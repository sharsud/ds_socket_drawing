const { Jimp } = require('jimp');
const chokidar = require('chokidar');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;

const CONFIG = {
    ROOM_URL: 'https://www.drawasaurus.org/',
    USERNAME: 'odusP',
    CHAT_MESSAGE: "odusP Bot Active 🎨",
    PACKET_DELAY: 8,         
    TIME_LIMIT_MS: 48000,
    WHITE_THRESHOLD: 240,   
    RES_WIDTH: 450,         
    MAX_GAP: 0.04,          
    STROKE_MAX_PTS: 60,
    COLOR_LIMIT: 24          // Set your desired color limit here
};

async function getDynamicPalette(image, limit) {
    const counts = new Map();
    const { width, height } = image.bitmap;
    for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
            const color = image.getPixelColor(x, y);
            const r = (color >> 24) & 0xFF, g = (color >> 16) & 0xFF, b = (color >> 8) & 0xFF;
            if (r > CONFIG.WHITE_THRESHOLD && g > CONFIG.WHITE_THRESHOLD && b > CONFIG.WHITE_THRESHOLD) continue;
            // Quantize colors slightly to group similar shades
            const key = (r >> 3) << 16 | (g >> 3) << 8 | (b >> 3);
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([k]) => {
            const r = (k >> 16) << 3, g = ((k >> 8) & 0xFF) << 3, b = (k & 0xFF) << 3;
            return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        });
}

class DrawBot {
    constructor() { 
        this.isDrawing = false; 
        this.queue = []; 
    }

    async init() {
        console.log(`[INIT] Launching Browser...`);
        this.browser = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--start-maximized'] });
        this.page = await this.browser.newPage();

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
            const accept = await this.page.waitForSelector('#accept-choices', { timeout: 5000 });
            await accept.click();
            await this.page.type('input[placeholder="Enter your name..."]', CONFIG.USERNAME);
            await this.page.click('button[type="submit"]');
        } catch (e) { console.warn("[NAV] Login manual intervention might be needed."); }

        this.startWatcher();
    }

    startWatcher() {
        if (!require('fs').existsSync('./images')) require('fs').mkdirSync('./images');
        chokidar.watch('./images', { ignoreInitial: true }).on('add', fp => {
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
        } catch (e) { console.error(`[ERROR]`, e); }
        finally { this.isDrawing = false; this.processQueue(); }
    }

    async analyze(img) {
        const { width: W, height: H } = img.bitmap;
        const colorLimit = CONFIG.COLOR_LIMIT; 
        const dynamicPalette = await getDynamicPalette(img, colorLimit);
        const steps = [];

        for (const targetColor of dynamicPalette) {
            let pool = [];

            // Scan and map image to the extracted dynamic palette
            for (let y = 0; y < H; y += 2.5) {
                for (let x = 0; x < W; x += 2.5) {
                    const c = img.getPixelColor(x, y);
                    const r = (c >> 24) & 0xFF, g = (c >> 16) & 0xFF, b = (c >> 8) & 0xFF;
                    
                    if (r > CONFIG.WHITE_THRESHOLD && g > CONFIG.WHITE_THRESHOLD && b > CONFIG.WHITE_THRESHOLD) continue;

                    // Match current pixel to the closest color in our dynamic palette
                    let bestHex = dynamicPalette[0], minD = Infinity;
                    for (const hex of dynamicPalette) {
                        const r2 = parseInt(hex.slice(1,3), 16), g2 = parseInt(hex.slice(3,5), 16), b2 = parseInt(hex.slice(5,7), 16);
                        const d = (r-r2)**2 + (g-g2)**2 + (b-b2)**2;
                        if (d < minD) { minD = d; bestHex = hex; }
                    }

                    if (bestHex === targetColor) {
                        pool.push([x / W, y / H]);
                    }
                }
            }

            // Scribble Logic: Connect points of the same color
            while (pool.length > 0) {
                let curr = pool.shift();
                let stroke = [curr];

                while (stroke.length < CONFIG.STROKE_MAX_PTS) {
                    let nearestIdx = -1, nearestD = CONFIG.MAX_GAP;
                    for (let i = 0; i < Math.min(pool.length, 100); i++) {
                        const d = Math.sqrt((curr[0] - pool[i][0]) ** 2 + (curr[1] - pool[i][1]) ** 2);
                        if (d < nearestD) { nearestD = d; nearestIdx = i; }
                    }
                    if (nearestIdx === -1) break; 
                    curr = pool.splice(nearestIdx, 1)[0];
                    stroke.push(curr);
                }
                if (stroke.length > 1) {
                    steps.push({ color: targetColor, points: stroke, thick: 4 });
                }
            }
        }
        return steps;
    }

    async draw(steps) {
        await this.page.evaluate(async (steps, cfg) => {
            const getBestSocket = () => {
                if (window._latestSocket && window._latestSocket.readyState === 1) return window._latestSocket;
                return (window._socketPool || []).find(s => s.readyState === 1);
            };

            const socket = getBestSocket();
            if (!socket) return;

            const canvas = document.querySelector('canvas');
            const ctx = canvas.getContext('2d'), GW = 800, GH = 600, start = Date.now();
            
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            for (const s of steps) {
                if (Date.now() - start > cfg.TIME_LIMIT_MS || socket.readyState !== 1) break;

                while (socket.bufferedAmount > 8000) await new Promise(r => setTimeout(r, 15));

                const pts = s.points.map(p => [Math.round(p[0] * GW), Math.round(p[1] * GH)]);
                socket.send(JSON.stringify({ a: ["drawLine", { colour: s.color, lines: pts, thick: s.thick }] }));

                ctx.strokeStyle = s.color;
                ctx.lineWidth = s.thick;
                ctx.beginPath();
                ctx.moveTo(pts[0][0], pts[0][1]);
                pts.forEach(p => ctx.lineTo(p[0], p[1]));
                ctx.stroke();

                await new Promise(r => setTimeout(r, cfg.PACKET_DELAY));
            }
        }, steps, CONFIG);
    }
}

new DrawBot().init();