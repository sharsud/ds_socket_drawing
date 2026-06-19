const { Jimp } = require('jimp');
const chokidar = require('chokidar');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;

/**
 * =========================================================================
 * DRAWBOT v7.5 — High-Detail Vector Flow Engine (Anti-Kick Adaptive Buffer)
 * =========================================================================
 */
const CONFIG = {
    // --- Game Environment Setup ---
    ROOM_URL: 'https://www.drawasaurus.org/',
    USERNAME: 'Psudo',
    CHAT_MESSAGE: "odusP Bot Active 🎨",
    CANVAS_WIDTH: 800,
    CANVAS_HEIGHT: 600,
    WATCH_DIR: './images',

    // --- Performance & Network Tuning ---
    PACKET_DELAY: 25,          // Unchanged as requested
    BATCH_SIZE: 1,             // Optimized batching density for high-speed delivery
    TIME_LIMIT_MS: 48000,       
    MAX_BUFFER_AMOUNT: 9000,   // Balanced structural safety threshold

    // --- Image Processing & Colors ---
    RES_WIDTH: 450,            
    COLOR_LIMIT: 32,           
    WHITE_THRESHOLD: 200,      
    
    // --- Anti-Aliasing Filters ---
    AA_GRAY_MIN: 180,          
    AA_GRAY_MAX: 230,          

    // --- High-Detail Features ---
    BLACK_SNAP_THRESHOLD: 75,  

    // --- Fine-tuned Pathfinding Parameters ---
    THICKNESS: 4,              
    SCAN_STEP: 1.0,            // Scans every pixel to capture maximum details
    MAX_POINTS: 800,            // Extended line memory for flowing strokes
    NEAREST_DIST: 0.018,       // Balanced tracking radius for crisp curves
    SEARCH_LOOKAHEAD: 180      // Wider lookup frame to reduce unnecessary pen lifts
};

// --- PRE-PARSED PALETTE GENERATOR ---
async function getDynamicPalette(image) {
    const counts = new Map();
    const { width, height } = image.bitmap;
    for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
            const color = image.getPixelColor(x, y);
            const r = (color >> 24) & 0xFF, g = (color >> 16) & 0xFF, b = (color >> 8) & 0xFF;
            
            if (r >= CONFIG.WHITE_THRESHOLD && g >= CONFIG.WHITE_THRESHOLD && b >= CONFIG.WHITE_THRESHOLD) continue;
            
            const key = (r >> 3) << 16 | (g >> 3) << 8 | (b >> 3);
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, CONFIG.COLOR_LIMIT)
        .map(([k]) => {
            const r = (k >> 16) << 3, g = ((k >> 8) & 0xFF) << 3, b = (k & 0xFF) << 3;
            const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
            return { hex, r, g, b, lum: 0.2126 * r + 0.7152 * g + 0.0722 * b };
        })
        .sort((a, b) => b.lum - a.lum);
}

class DrawBot {
    constructor() { 
        this.isDrawing = false; 
        this.queue = []; 
        console.log('--- DrawBot High-Detail Engine Active ---');
    }

    async init() {
        console.log(`[INIT] Launching browser...`);
        this.browser = await puppeteer.launch({ 
            headless: false, 
            defaultViewport: null, 
            args: ['--start-maximized', '--disable-web-security'] 
        });
        this.page = await this.browser.newPage();
        
        const client = await this.page.target().createCDPSession();
        await client.send('Network.enable');
        
        await this.page.evaluateOnNewDocument(() => {
            window._socketPool = [];
            window._latestSocket = null;
            const NativeWS = window.WebSocket;
            window.WebSocket = function(...args) {
                const socket = new NativeWS(...args);
                window._socketPool.push(socket);
                socket.addEventListener('open', () => { window._latestSocket = socket; });
                return socket;
            };
        });
        
        await this.page.goto(CONFIG.ROOM_URL);

        try {
            const accept = await this.page.waitForSelector('xpath///*[@id="accept-choices"]', { timeout: 3000 }).catch(() => null);
            if (accept) await accept.click();
            
            const input = await this.page.waitForSelector('xpath///*[@id="modal"]/div/div/div/div[1]/form/label/input', { timeout: 5000 });
            await input.click({ clickCount: 3 });
            
            const input1 = await this.page.waitForSelector('xpath///*[@id="modal"]/div/div/div/div[1]/form/div/input', { timeout: 5000 });
            await input1.type(CONFIG.USERNAME);

            const btn = await this.page.waitForSelector('xpath///*[@id="modal"]/div/div/div/div[1]/form/div/button');
            await btn.click();
        } catch (e) { console.warn("[NAV] Login skipped."); }

        this.startWatcher();
    }

    startWatcher() {
        if (!require('fs').existsSync(CONFIG.WATCH_DIR)) require('fs').mkdirSync(CONFIG.WATCH_DIR);
        chokidar.watch(CONFIG.WATCH_DIR, { persistent: true, ignoreInitial: true }).on('add', fp => {
            this.queue.push(fp);
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isDrawing || this.queue.length === 0) return;
        this.isDrawing = true;
        const path = this.queue.shift();
        try {
            console.log(`[PROCESS] File: ${path}`);
            const img = await Jimp.read(path);
            img.resize({ w: CONFIG.RES_WIDTH });
            const steps = await this.analyze(img);
            await this.draw(steps);
            await fs.unlink(path);
        } catch (e) { console.error(`[ERROR]`, e.message); }
        finally { this.isDrawing = false; if (this.queue.length > 0) this.processQueue(); }
    }

    // --- HIGH-PRECISION LINE TRACKING ---
    async analyze(img) {
        const { width, height } = img.bitmap;
        const steps = [];
        const globalVisited = new Uint8Array(width * height);
        const palette = await getDynamicPalette(img); 
        const pointsByColor = new Map();

        const darkestHex = palette.reduce((prev, curr) => (prev.lum < curr.lum ? prev : curr)).hex;

        for (let y = 0; y < height; y += CONFIG.SCAN_STEP) {
            for (let x = 0; x < width; x += CONFIG.SCAN_STEP) {
                const flX = Math.floor(x);
                const flY = Math.floor(y);
                const pixelIdx = (flY * width) + flX;
                if (globalVisited[pixelIdx]) continue;

                const c = img.getPixelColor(flX, flY);
                const r = (c >> 24) & 255;
                const g = (c >> 16) & 255;
                const b = (c >> 8) & 255;

                if (r >= CONFIG.WHITE_THRESHOLD && g >= CONFIG.WHITE_THRESHOLD && b >= CONFIG.WHITE_THRESHOLD) continue;

                let closestHex = palette[0].hex;

                if (r < CONFIG.BLACK_SNAP_THRESHOLD && g < CONFIG.BLACK_SNAP_THRESHOLD && b < CONFIG.BLACK_SNAP_THRESHOLD) {
                    closestHex = darkestHex;
                } else {
                    let minDistance = Infinity;
                    for (let i = 0; i < palette.length; i++) {
                        const pColor = palette[i];
                        const dist = (r - pColor.r) ** 2 + (g - pColor.g) ** 2 + (b - pColor.b) ** 2;
                        if (dist < minDistance) {
                            minDistance = dist;
                            closestHex = pColor.hex;
                        }
                    }
                }

                if (!pointsByColor.has(closestHex)) pointsByColor.set(closestHex, []);
                pointsByColor.get(closestHex).push({ x: flX / width, y: flY / height, idx: pixelIdx, v: false });
            }
        }

        for (const [colorHex, pool] of pointsByColor.entries()) {
            let localPool = pool;
            let poolLen = localPool.length;
            let leftPointer = 0;

            while (leftPointer < poolLen) {
                let curr = localPool[leftPointer];
                if (curr.v || globalVisited[curr.idx]) { leftPointer++; continue; }

                let stroke = [[curr.x, curr.y]];
                globalVisited[curr.idx] = 1;
                curr.v = true;

                while (stroke.length < CONFIG.MAX_POINTS) {
                    let nearestIdx = -1;
                    let nearestD = CONFIG.NEAREST_DIST; 

                    const searchEnd = Math.min(poolLen, leftPointer + CONFIG.SEARCH_LOOKAHEAD);
                    for (let i = leftPointer + 1; i < searchEnd; i++) {
                        const p = localPool[i];
                        if (p.v || globalVisited[p.idx]) continue;

                        const d = Math.hypot(curr.x - p.x, curr.y - p.y);
                        if (d < nearestD) {
                            nearestD = d;
                            nearestIdx = i;
                        }
                    }

                    if (nearestIdx === -1) break;

                    curr = localPool[nearestIdx];
                    curr.v = true;
                    stroke.push([curr.x, curr.y]);
                    globalVisited[curr.idx] = 1;
                }

                if (stroke.length > 0) {
                    steps.push({ color: colorHex, thick: CONFIG.THICKNESS, points: stroke });
                }
                leftPointer++;
            }
        }
        return steps;
    }

    // --- ADAPTIVE FLUSH DRAW TRANSMISSION ---
    async draw(steps) {
        try {
            await this.page.evaluate(async (steps, cfg) => {
                const getActiveSocket = () => {
                    if (window._latestSocket?.readyState === 1) return window._latestSocket;
                    return (window._socketPool || []).find(x => x.readyState === 1) || null;
                };

                let socket = getActiveSocket();
                while (!socket) { 
                    await new Promise(r => setTimeout(r, 100));
                    socket = getActiveSocket();
                }

                const canvas = document.querySelector('canvas');
                const ctx = canvas ? canvas.getContext('2d') : null;
                const start = Date.now();
                let index = 0;
                
                while (index < steps.length) {
                    if (Date.now() - start > cfg.TIME_LIMIT_MS || socket.readyState !== 1) break;
                    
                    // Dynamic Adaptive Valve: Prevents buffer overflows and ensures players aren't kicked
                    if (socket.bufferedAmount > cfg.MAX_BUFFER_AMOUNT) {
                        await new Promise(r => setTimeout(r, 8));
                        continue;
                    }

                    const currentBatch = steps.slice(index, index + cfg.BATCH_SIZE);
                    index += cfg.BATCH_SIZE;

                    for (let b = 0; b < currentBatch.length; b++) {
                        const s = currentBatch[b];
                        const pts = s.points.map(p => [
                            Math.round(p[0] * cfg.CANVAS_WIDTH), 
                            Math.round(p[1] * cfg.CANVAS_HEIGHT)
                        ]);

                        socket.send(JSON.stringify({ a: ["drawLine", { colour: s.color, lines: pts, thick: s.thick }] }));
                        
                        if (ctx && pts.length > 0) {
                            ctx.beginPath(); 
                            ctx.strokeStyle = s.color; 
                            ctx.lineWidth = s.thick;
                            ctx.lineCap = 'round'; 
                            ctx.moveTo(pts[0][0], pts[0][1]);
                            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
                            ctx.stroke();
                        }
                    }
                    
                    await new Promise(r => setTimeout(r, cfg.PACKET_DELAY));
                }
            }, steps, CONFIG);
        } catch (err) {
            console.error("[DRAW ERROR]", err.message);
        }           
    }
}

new DrawBot().init();