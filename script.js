const { Jimp } = require('jimp');
const chokidar = require('chokidar');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;

const CONFIG = {
    ROOM_URL: 'https://www.drawasaurus.org/room/The+koala+Room',
    CHAT_MESSAGE: "odusP Bot Active 🎨",
    PACKET_DELAY: 5,        
    TIME_LIMIT_MS: 48000,
    WHITE_THRESHOLD: 230,  
    STRICT_UP_DIST: 0.02,  
    COLOR_LIMIT: 32,        
    RES_WIDTH: 450         
};

async function getDynamicPalette(image) {
    const counts = new Map();
    const { width, height } = image.bitmap;
    for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
            const color = image.getPixelColor(x, y);
            const r = (color >> 24) & 0xFF, g = (color >> 16) & 0xFF, b = (color >> 8) & 0xFF;
            if (r > CONFIG.WHITE_THRESHOLD && g > CONFIG.WHITE_THRESHOLD && b > CONFIG.WHITE_THRESHOLD) continue;
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
            return { hex, lum: 0.2126 * r + 0.7152 * g + 0.0722 * b };
        })
        .sort((a, b) => b.lum - a.lum);
}

class DrawBot {
    constructor() { 
        this.isDrawing = false; 
        this.queue = []; 
        console.log('--- DrawBot Instance Created ---');
    }

    async init() {
        console.log(`[INIT] Launching browser...`);
        this.browser = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--start-maximized'] });
        this.page = await this.browser.newPage();
        this.page.on('console', msg => console.log(`[BROWSER LOG] ${msg.text()}`));

        // --- 1. THE SNIFFER & MONITOR (Must be evaluateOnNewDocument) ---
        await this.page.evaluateOnNewDocument(() => {
            window._socketPool = [];
            window._latestSocket = null;

            const NativeWS = window.WebSocket;
            window.WebSocket = function(...args) {
                const socket = new NativeWS(...args);
                window._socketPool.push(socket);

                socket.addEventListener('open', () => { 
                    window._latestSocket = socket;
                    console.log(`%c[SOCKET] Connected: ${args[0]}`, "color: green; font-weight: bold;");
                });
                return socket;
            };

            // Start the monitor loop inside the browser
            setInterval(() => {
                const pool = window._socketPool || [];
                if (pool.length > 0) {
                    console.log(`%c--- SOCKET POOL: ${pool.length} total ---`, "color: blue;");
                    pool.forEach((ws, i) => {
                        const states = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
                        console.log(`[${i}] ${states[ws.readyState]} | ${ws === window._latestSocket ? 'LATEST' : 'OLD'} | ${ws.url}`);
                    });
                }
            }, 5000);
        });
        
        await this.page.goto(CONFIG.ROOM_URL);

        // --- NAVIGATION ---
        try {
            const accept = await this.page.waitForSelector('xpath///*[@id="accept-choices"]', { timeout: 5000 });
            await accept.click();
            const span = await this.page.waitForSelector('xpath///*[@id="modal"]/div/div/div/div[1]/form/label/span');
            await span.click();
            await this.page.type('xpath///*[@id="modal"]/div/div/div/div[1]/form/div/input', 'odusP');
            const btn = await this.page.waitForSelector('xpath///*[@id="modal"]//button');
            await btn.click();
        } catch (e) { console.warn("[NAV] Login steps skipped."); }

        this.startWatcher();
    }

    startWatcher() {
        console.log(`[WATCHER] Monitoring ./images...`);
        chokidar.watch('./images', { persistent: true, ignoreInitial: true }).on('add', fp => {
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

    async analyze(img) {
        const { width, height } = img.bitmap;
        const paletteObjects = await getDynamicPalette(img);
        const palette = paletteObjects.map(o => o.hex);
        const layers = [{ thick: 14, step: 5, max: 20 }, { thick: 4, step: 1.8, max: 45 }]; 
        const steps = [];

        for (const layer of layers) {
            const pointsByColor = new Map();
            for (let y = 0; y < height; y += layer.step) {
                for (let x = 0; x < width; x += layer.step) {
                    const c = img.getPixelColor(x, y);
                    const r = (c >> 24) & 0xFF, g = (c >> 16) & 0xFF, b = (c >> 8) & 0xFF;
                    if (r > CONFIG.WHITE_THRESHOLD && g > CONFIG.WHITE_THRESHOLD && b > CONFIG.WHITE_THRESHOLD) continue;
                    let bestHex = palette[0], minD = Infinity;
                    for (const h of palette) {
                        const r2 = parseInt(h.slice(1,3),16), g2 = parseInt(h.slice(3,5),16), b2 = parseInt(h.slice(5,7),16);
                        const d = (r-r2)**2 + (g-g2)**2 + (b-b2)**2;
                        if (d < minD) { minD = d; bestHex = h; }
                    }
                    if (!pointsByColor.has(bestHex)) pointsByColor.set(bestHex, []);
                    pointsByColor.get(bestHex).push([x / width, y / height]);
                }
            }
            for (const colorObj of paletteObjects) {
                let pool = pointsByColor.get(colorObj.hex) || [];
                while (pool.length > 0) {
                    let curr = pool.shift(), stroke = [curr];
                    while (stroke.length < layer.max) {
                        let nearestIdx = -1, nearestD = CONFIG.STRICT_UP_DIST;
                        for (let i = 0; i < Math.min(pool.length, 140); i++) {
                            const d = Math.sqrt((curr[0]-pool[i][0])**2 + (curr[1]-pool[i][1])**2);
                            if (d < nearestD) { nearestD = d; nearestIdx = i; }
                        }
                        if (nearestIdx === -1) break; 
                        curr = pool.splice(nearestIdx, 1)[0];
                        stroke.push(curr);
                    }
                    if (stroke.length > 1) steps.push({ color: colorObj.hex, thick: layer.thick, points: stroke });
                }
            }
        }
        return steps;
    }

    async draw(steps) {
        try {
            await this.page.evaluate(async (steps, cfg) => {
                const getBestSocket = () => {
                    // Try the latest one first
                    if (window._latestSocket && window._latestSocket.readyState === 1) return window._latestSocket;
                    // Otherwise, find any open socket in the pool
                    return (window._socketPool || []).find(s => s.readyState === 1);
                };

                let socket = getBestSocket();

                if (!socket) {
                    console.log("[BROWSER] No active socket. Waiting...");
                    for (let i = 0; i < 50; i++) {
                        await new Promise(r => setTimeout(r, 100));
                        socket = getBestSocket();
                        if (socket) break;
                    }
                }

                if (!socket) throw new Error("Could not find an open WebSocket.");

                const canvas = document.querySelector('canvas');
                const ctx = canvas.getContext('2d'), GW = 800, GH = 600, start = Date.now();
                
                for (const s of steps) {
                    if (Date.now() - start > cfg.TIME_LIMIT_MS || socket.readyState !== 1) break;
                    const pts = s.points.map(p => [Math.round(p[0] * GW), Math.round(p[1] * GH)]);
                    socket.send(JSON.stringify({ a: ["drawLine", { colour: s.color, lines: pts, thick: s.thick }] }));
                    
                    ctx.beginPath(); ctx.strokeStyle = s.color; ctx.lineWidth = s.thick;
                    ctx.lineCap = 'round'; ctx.moveTo(pts[0][0], pts[0][1]);
                    for(let i=1; i<pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
                    ctx.stroke();
                    await new Promise(r => setTimeout(r, cfg.PACKET_DELAY));
                }
            }, steps, CONFIG);
        } catch (err) {
            if (err.message.includes('Execution context was destroyed')) {
                console.log("[SYSTEM] Re-initializing draw after page reload...");
                await new Promise(r => setTimeout(r, 2000));
                return this.draw(steps);
            }
            console.error("[DRAW ERROR]", err.message);
        }            
    }
}

new DrawBot().init();
