const { Jimp } = require('jimp');
const chokidar = require('chokidar');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;

/**
 * CONFIGURATION BLOCK
 */
/**
 * CONFIGURATION BLOCK
 * Adjust these values to balance speed, detail, and server stability.
 */
const CONFIG = {
    // The target Drawasaurus room URL.
    ROOM_URL: 'https://www.drawasaurus.org/',

    // The name the bot will use when joining the room.
    USERNAME: 'Psudo',

    // Currently unused in the draw logic, but can be used for a greeting.
    CHAT_MESSAGE: "odusP Bot Active 🎨",

    // DELAY (ms) between sending stroke packets. 
    // TWEAK: Lower (5-10) is faster but might get you kicked for spam. 
    // Higher (20-30) is safer and looks more "human."
    PACKET_DELAY: 15,

    // The total time (ms) allowed to finish a drawing before it stops.
    // TWEAK: Set to match the room's round timer (usually 60000 or 90000).
    TIME_LIMIT_MS: 60000,

    // RGB value (0-255) above which a pixel is considered "white" and skipped.
    // TWEAK: Lower (220) skips more "off-white" pixels. Higher (250) draws almost everything.
    WHITE_THRESHOLD: 240,

    // Limits how many unique colors the bot will attempt to draw.
    // TWEAK: 8-12 is best for speed. 32 provides high detail but takes much longer.
    COLOR_LIMIT: 12,

    // The internal width the image is resized to before processing.
    // TWEAK: Higher (600+) = more detail but thousands more points to draw.
    RES_WIDTH: 450,

    // Distance threshold for "pen up" logic in some algorithms.
    STRICT_UP_DIST: 0.02,

    // How many points ahead the bot looks to find the next nearest neighbor.
    SEARCH_LOOKAHEAD: 140,

    /**
     * LAYER SETTINGS
     * These are the most important values for the "Scribble" look.
     */
    LAYERS: [
        { 
            // The size of the brush tool in-game.
            // TWEAK: Use 10-15 for "Fast Fill," use 2-4 for "Fine Detail."
            thick: 8, 

            // How many pixels to skip during scanning.
            // TWEAK: 1.0 = every pixel (slow). 4.0-6.0 = wide scribble (very fast).
            step: 3, 

            // Maximum points allowed in a single WebSocket message.
            // TWEAK: Don't exceed 100 or the server may reject the packet.
            maxPoints: 60 
        }
    ],

    // Target dimensions of the Drawasaurus canvas.
    CANVAS_WIDTH: 800,
    CANVAS_HEIGHT: 600,

    // The local folder the bot watches for new image files.
    WATCH_DIR: './images'
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
        } catch (e) { console.warn("[NAV] Manual login required."); }

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
        const steps = [];
        const layer = CONFIG.LAYERS[0];
        
        // 1. Scan for continuous horizontal lines (Segments)
        for (let y = 0; y < height; y += layer.step) {
            let startX = -1;
            let lastHex = null;

            for (let x = 0; x < width; x += layer.step) {
                const c = img.getPixelColor(x, y);
                const r = (c >> 24) & 255, g = (c >> 16) & 255, b = (c >> 8) & 255;

                // Skip white
                if (r > CONFIG.WHITE_THRESHOLD && g > CONFIG.WHITE_THRESHOLD && b > CONFIG.WHITE_THRESHOLD) {
                    if (startX !== -1) {
                        steps.push({ color: lastHex, thick: layer.thick, points: [[startX/width, y/height], [x/width, y/height]] });
                        startX = -1;
                    }
                    continue;
                }

                // Quantize for solid blocks
                const Q = 32;
                const qr = Math.floor(r / Q) * Q, qg = Math.floor(g / Q) * Q, qb = Math.floor(b / Q) * Q;
                const hex = `#${qr.toString(16).padStart(2,'0')}${qg.toString(16).padStart(2,'0')}${qb.toString(16).padStart(2,'0')}`;

                if (hex !== lastHex) {
                    if (startX !== -1) {
                        steps.push({ color: lastHex, thick: layer.thick, points: [[startX/width, y/height], [x/width, y/height]] });
                    }
                    startX = x;
                    lastHex = hex;
                }
            }
            if (startX !== -1) {
                steps.push({ color: lastHex, thick: layer.thick, points: [[startX/width, y/height], [(width-1)/width, y/height]] });
            }
        }
        return steps;
    }

    async draw(steps) {
        try {
            await this.page.evaluate(async (steps, cfg) => {
                const socket = window._latestSocket || (window._socketPool || []).find(x => x.readyState === 1);
                if (!socket) return;
                const ctx = document.querySelector('canvas').getContext('2d');
                const start = Date.now();
                
                for (const s of steps) {
                    if (Date.now() - start > cfg.TIME_LIMIT_MS) break;
                    while (socket.bufferedAmount > 20000) await new Promise(r => setTimeout(r, 5));

                    const pts = s.points.map(p => [Math.round(p[0] * cfg.CANVAS_WIDTH), Math.round(p[1] * cfg.CANVAS_HEIGHT)]);
                    socket.send(JSON.stringify({ a: ["drawLine", { colour: s.color, lines: pts, thick: s.thick }] }));
                    
                    ctx.beginPath(); ctx.strokeStyle = s.color; ctx.lineWidth = s.thick;
                    ctx.lineCap = 'round'; ctx.moveTo(pts[0][0], pts[0][1]);
                    for(let i=1; i<pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
                    ctx.stroke();
                    
                    await new Promise(r => setTimeout(r, cfg.PACKET_DELAY));
                }
            }, steps, CONFIG);
        } catch (err) { console.error("[DRAW ERROR]", err.message); }           
    }
}

new DrawBot().init();