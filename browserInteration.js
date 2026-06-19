const { Jimp } = require('jimp');
const chokidar = require('chokidar');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;

/**
 * CONFIGURATION BLOCK
 */
const CONFIG = {
    ROOM_URL: 'https://www.drawasaurus.org/',
    USERNAME: 'Psudo',
    CHAT_MESSAGE: "odusP Bot Active 🎨",
    PACKET_DELAY: 35,
    TIME_LIMIT_MS: 48000,
    WHITE_THRESHOLD: 254,      // Skips only true background white pixels
    COLOR_LIMIT: 32,
    RES_WIDTH: 450,
    SEARCH_LOOKAHEAD: 140,
    LAYERS: [
        { thick: 4, step: 1.5, maxPoints: 60 }
    ],
    CANVAS_WIDTH: 800,
    CANVAS_HEIGHT: 600,
    WATCH_DIR: './images',

    // --- NEW: COLOR CLUSTERING RADIUS ---
    // Higher = more aggressive grouping (e.g., treats close grays/blacks as 1 color)
    COLOR_GROUP_RADIUS: 50    
};

/**
 * Helper logic to determine if a color matches an existing cluster bucket
 */
function getGroupedColor(r, g, b, uniqueBuckets) {
    for (const bucket of uniqueBuckets) {
        const dist = Math.sqrt(
            Math.pow(r - bucket.r, 2) + 
            Math.pow(g - bucket.g, 2) + 
            Math.pow(b - bucket.b, 2)
        );
        if (dist < CONFIG.COLOR_GROUP_RADIUS) {
            return bucket.hex;
        }
    }
    const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    uniqueBuckets.push({ r, g, b, hex });
    return hex;
}

class DrawBot {
    constructor() { 
        this.isDrawing = false; 
        this.queue = []; 
        console.log('--- DrawBot Instance Created (CDP Socket Mode) ---');
    }

    async init() {
        console.log(`[INIT] Launching browser...`);
        this.browser = await puppeteer.launch({ 
            headless: false, 
            defaultViewport: null, 
            args: ['--start-maximized', '--disable-web-security'] 
        });
        this.page = await this.browser.newPage();
        this.page.on('console', msg => console.log(`[BROWSER LOG] ${msg.text()}`));

        // CDP WebSocket Sniffer
        const client = await this.page.target().createCDPSession();
        await client.send('Network.enable');
        client.on('Network.webSocketCreated', ({requestId, url}) => {
            console.log(`[CDP] WebSocket detected: ${url}`);
        });

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
            window._socketSnifferArmed = true;
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
            console.log("[NAV] Login Successful.");
        } catch (e) { console.warn("[NAV] Login steps skipped/manual."); }

        this.startWatcher();
    }

    startWatcher() {
        if (!require('fs').existsSync(CONFIG.WATCH_DIR)) require('fs').mkdirSync(CONFIG.WATCH_DIR);
        console.log(`[WATCHER] Monitoring ${CONFIG.WATCH_DIR}...`);
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

    /**
     * RE-ENGINEERED ANALYZE LOGIC
     * Dynamically clusters adjacent shades into core color buckets to prevent broken micro-strokes.
     */
    async analyze(img) {
        const { width, height } = img.bitmap;
        const steps = [];
        const globalVisited = new Uint8Array(width * height);
        
        const pointsByColor = new Map();
        const uniqueBuckets = []; 

        for (let y = 0; y < height; y += CONFIG.LAYERS[0].step) {
            for (let x = 0; x < width; x += CONFIG.LAYERS[0].step) {
                const pixelIdx = (Math.floor(y) * width) + Math.floor(x);
                if (globalVisited[pixelIdx]) continue;

                const c = img.getPixelColor(x, y);
                const r = (c >> 24) & 255;
                const g = (c >> 16) & 255;
                const b = (c >> 8) & 255;

                // Only drop pure background canvas white
                if (r >= CONFIG.WHITE_THRESHOLD && g >= CONFIG.WHITE_THRESHOLD && b >= CONFIG.WHITE_THRESHOLD) continue;

                // Group similar gradient colors under one shared hex value
                const targetHex = getGroupedColor(r, g, b, uniqueBuckets);

                if (!pointsByColor.has(targetHex)) pointsByColor.set(targetHex, []);
                pointsByColor.get(targetHex).push({ x: x / width, y: y / height, idx: pixelIdx });
            }
        }

        console.log(`[ANALYSIS] Grouped shades into ${pointsByColor.size} unique unified color channels.`);

        // Pathfinder tracing loop using our unified color pools
        for (const [colorHex, pool] of pointsByColor.entries()) {
            let localPool = [...pool];
            while (localPool.length > 0) {
                let curr = localPool.shift();
                if (globalVisited[curr.idx]) continue;

                let stroke = [[curr.x, curr.y]];
                globalVisited[curr.idx] = 1;

                while (stroke.length < CONFIG.LAYERS[0].maxPoints) {
                    let nearestIdx = -1;
                    let nearestD = 0.025; 

                    for (let i = 0; i < Math.min(localPool.length, CONFIG.SEARCH_LOOKAHEAD); i++) {
                        const p = localPool[i];
                        if (globalVisited[p.idx]) continue;

                        const d = Math.hypot(curr.x - p.x, curr.y - p.y);
                        if (d < nearestD) {
                            nearestD = d;
                            nearestIdx = i;
                        }
                    }

                    if (nearestIdx === -1) break;

                    curr = localPool.splice(nearestIdx, 1)[0];
                    stroke.push([curr.x, curr.y]);
                    globalVisited[curr.idx] = 1;
                }

                if (stroke.length > 0) {
                    steps.push({ color: colorHex, thick: CONFIG.LAYERS[0].thick, points: stroke });
                }
            }
        }
        return steps;
    }

    async draw(steps) {
        try {
            await this.page.evaluate(async (steps, cfg) => {
                const getActiveSocket = () => {
                    if (window._latestSocket?.readyState === 1) return window._latestSocket;
                    return (window._socketPool || []).find(x => x.readyState === 1) || null;
                };

                let socket = getActiveSocket();
                let waitTime = 0;
                while (!socket && waitTime < 100) { 
                    await new Promise(r => setTimeout(r, 100));
                    socket = getActiveSocket();
                    waitTime++;
                }

                if (!socket) throw new Error("SOCKET_SYNC_TIMEOUT: No active socket found after 10s.");

                const canvas = document.querySelector('canvas');
                if (!canvas) throw new Error("CANVAS_NOT_FOUND");
                const ctx = canvas.getContext('2d');
                const start = Date.now();
                
                for (const s of steps) {
                    if (Date.now() - start > cfg.TIME_LIMIT_MS || socket.readyState !== 1) break;
                    while (socket.bufferedAmount > 15000) await new Promise(r => setTimeout(r, 5));

                    const pts = s.points.map(p => [
                        Math.round(p[0] * cfg.CANVAS_WIDTH), 
                        Math.round(p[1] * cfg.CANVAS_HEIGHT)
                    ]);

                    socket.send(JSON.stringify({ a: ["drawLine", { colour: s.color, lines: pts, thick: s.thick }] }));
                    
                    ctx.beginPath(); ctx.strokeStyle = s.color; ctx.lineWidth = s.thick;
                    ctx.lineCap = 'round'; ctx.moveTo(pts[0][0], pts[0][1]);
                    for(let i=1; i<pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
                    ctx.stroke();
                    
                    await new Promise(r => setTimeout(r, cfg.PACKET_DELAY));
                }
            }, steps, CONFIG);
        } catch (err) {
            if (err.message.includes('destroyed') || err.message.includes('SOCKET_SYNC_TIMEOUT')) {
                console.log("[SYSTEM] Connection lost. Re-syncing...");
                await new Promise(r => setTimeout(r, 3000));
                return this.draw(steps);
            }
            console.error("[DRAW ERROR]", err.message);
        }           
    }
}

new DrawBot().init();