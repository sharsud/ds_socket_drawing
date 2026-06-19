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
    PACKET_DELAY: 35,           // Raised base delay — less aggressive on the server
    PACKET_JITTER: 10,          // ±ms of random jitter added to every send (looks more human)
    BACKOFF_THRESHOLD: 8000,    // bufferedAmount (bytes) at which we start slowing down
    BACKOFF_DELAY: 60,          // extra ms added per backoff check when buffer is saturated
    TIME_LIMIT_MS: 48000,
    WHITE_THRESHOLD: 230,
    COLOR_LIMIT: 32,
    RES_WIDTH: 450,
    STRICT_UP_DIST: 0.02,
    SEARCH_LOOKAHEAD: 140,
    LAYERS: [
        { thick: 6, step: 1.5, maxPoints: 60 }
    ],
    CANVAS_WIDTH: 800,
    CANVAS_HEIGHT: 600,
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
            const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '00')}${b.toString(16).padStart(2, '0')}`;
            return { hex, lum: 0.2126 * r + 0.7152 * g + 0.0722 * b };
        })
        .sort((a, b) => b.lum - a.lum);
}

/**
 * Score a stroke by visual importance.
 * Higher = more important = drawn first so partial renders look good.
 * Factors: length (more points = bigger visual contribution) + darkness (low lum = stands out).
 */
function strokeImportance(step) {
    const r = parseInt(step.color.slice(1, 3), 16);
    const g = parseInt(step.color.slice(3, 5), 16);
    const b = parseInt(step.color.slice(5, 7), 16);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const lengthScore = step.points.length;          // more points = bigger stroke
    const darknessScore = (255 - lum) / 255;         // 0=white, 1=black
    return lengthScore * (1 + darknessScore * 2);    // darkness weighted 2x
}

/**
 * 2-opt stroke reorder: minimises total pen travel between stroke endpoints.
 * Runs a single greedy nearest-neighbour pass — fast enough for hundreds of strokes.
 */
function reorderStrokesByTravel(steps) {
    if (steps.length < 2) return steps;
    const result = [];
    const used = new Uint8Array(steps.length);
    let currEnd = steps[0].points[steps[0].points.length - 1];
    result.push(steps[0]);
    used[0] = 1;

    for (let i = 1; i < steps.length; i++) {
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let j = 0; j < steps.length; j++) {
            if (used[j]) continue;
            const start = steps[j].points[0];
            const d = Math.hypot(currEnd[0] - start[0], currEnd[1] - start[1]);
            if (d < bestDist) { bestDist = d; bestIdx = j; }
        }
        used[bestIdx] = 1;
        result.push(steps[bestIdx]);
        currEnd = steps[bestIdx].points[steps[bestIdx].points.length - 1];
    }
    return result;
}

class DrawBot {
    constructor() {
        this.isDrawing = false;
        this.queue = [];
        this.drawStepIndex = 0;   // tracks resume position across reconnects
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

        const client = await this.page.target().createCDPSession();
        await client.send('Network.enable');
        client.on('Network.webSocketCreated', ({ requestId, url }) => {
            console.log(`[CDP] WebSocket detected: ${url}`);
        });

        await this.page.evaluateOnNewDocument(() => {
            window._socketPool = [];
            window._latestSocket = null;
            const NativeWS = window.WebSocket;
            window.WebSocket = function (...args) {
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
            this.drawStepIndex = 0;          // reset resume counter for new image
            await this.draw(steps);
            await fs.unlink(path);
        } catch (e) { console.error(`[ERROR]`, e.message); }
        finally {
            this.isDrawing = false;
            if (this.queue.length > 0) await this.processQueue(); // FIX: properly awaited
        }
    }

    async analyze(img) {
        const { width, height } = img.bitmap;
        const steps = [];
        const globalVisited = new Uint8Array(width * height);

        const palette = await getDynamicPalette(img);

        // FIX: proper darkest-color lookup via reduce instead of fragile index check
        const darkestColor = palette.reduce((a, b) => a.lum < b.lum ? a : b);

        const pointsByColor = new Map();

        for (let y = 0; y < height; y += CONFIG.LAYERS[0].step) {
            for (let x = 0; x < width; x += CONFIG.LAYERS[0].step) {
                const pixelIdx = (Math.floor(y) * width) + Math.floor(x);
                if (globalVisited[pixelIdx]) continue;

                const c = img.getPixelColor(x, y);
                const r = (c >> 24) & 255;
                const g = (c >> 16) & 255;
                const b = (c >> 8) & 255;

                if (r > 180 && g > 180 && b > 180 && r < CONFIG.WHITE_THRESHOLD) continue;
                if (r > CONFIG.WHITE_THRESHOLD && g > CONFIG.WHITE_THRESHOLD && b > CONFIG.WHITE_THRESHOLD) continue;

                let closestHex = palette[0].hex;
                let minDistance = Infinity;

                // FIX: use proper darkestColor from reduce, not a fragile index comparison
                if (r < 60 && g < 60 && b < 60) {
                    closestHex = darkestColor.hex;
                    minDistance = 0;
                } else {
                    for (const pColor of palette) {
                        const pr = parseInt(pColor.hex.slice(1, 3), 16);
                        const pg = parseInt(pColor.hex.slice(3, 5), 16);
                        const pb = parseInt(pColor.hex.slice(5, 7), 16);
                        const dist = Math.sqrt((r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2);
                        if (dist < minDistance) { minDistance = dist; closestHex = pColor.hex; }
                    }
                }

                if (minDistance > 100) continue;

                if (!pointsByColor.has(closestHex)) pointsByColor.set(closestHex, []);
                pointsByColor.get(closestHex).push({ x: x / width, y: y / height, idx: pixelIdx });
            }
        }

        // Pathfinding (Island Hopping) — unchanged
        for (const [colorHex, pool] of pointsByColor.entries()) {
            let localPool = [...pool];
            while (localPool.length > 0) {
                let curr = localPool.shift();
                if (globalVisited[curr.idx]) continue;

                let stroke = [[curr.x, curr.y]];
                globalVisited[curr.idx] = 1;

                while (stroke.length < CONFIG.LAYERS[0].maxPoints) {
                    let nearestIdx = -1;
                    let nearestD = CONFIG.STRICT_UP_DIST;

                    for (let i = 0; i < Math.min(localPool.length, CONFIG.SEARCH_LOOKAHEAD); i++) {
                        const p = localPool[i];
                        if (globalVisited[p.idx]) continue;
                        const d = Math.hypot(curr.x - p.x, curr.y - p.y);
                        if (d < nearestD) { nearestD = d; nearestIdx = i; }
                    }

                    if (nearestIdx === -1) break;

                    curr = localPool.splice(nearestIdx, 1)[0];
                    stroke.push([curr.x, curr.y]);
                    globalVisited[curr.idx] = 1;
                }

                if (stroke.length > 1) {
                    steps.push({ color: colorHex, thick: CONFIG.LAYERS[0].thick, points: stroke });
                }
            }
        }

        // IMPROVEMENT: sort by visual importance (dark + long strokes first)
        // so if time runs out, the most recognisable parts are already on canvas
        steps.sort((a, b) => strokeImportance(b) - strokeImportance(a));

        // IMPROVEMENT: reorder strokes to minimise pen travel (greedy nearest-neighbour)
        return reorderStrokesByTravel(steps);
    }

    async draw(steps) {
        try {
            // Pass resume index + timing config into the page context
            const resumeFrom = this.drawStepIndex;

            const stepsDrawn = await this.page.evaluate(async (steps, cfg, resumeFrom) => {
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

                let drawn = resumeFrom; // track how many steps we've successfully sent

                for (let i = resumeFrom; i < steps.length; i++) {
                    const s = steps[i];
                    if (Date.now() - start > cfg.TIME_LIMIT_MS || socket.readyState !== 1) break;

                    // IMPROVEMENT: dynamic backoff — slow down when buffer is saturated
                    while (socket.bufferedAmount > cfg.BACKOFF_THRESHOLD) {
                        await new Promise(r => setTimeout(r, cfg.BACKOFF_DELAY));
                    }

                    const pts = s.points.map(p => [
                        Math.round(p[0] * cfg.CANVAS_WIDTH),
                        Math.round(p[1] * cfg.CANVAS_HEIGHT)
                    ]);

                    socket.send(JSON.stringify({ a: ["drawLine", { colour: s.color, lines: pts, thick: s.thick }] }));

                    ctx.beginPath(); ctx.strokeStyle = s.color; ctx.lineWidth = s.thick;
                    ctx.lineCap = 'round'; ctx.moveTo(pts[0][0], pts[0][1]);
                    for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]);
                    ctx.stroke();

                    // IMPROVEMENT: jittered delay — looks human, harder to detect as a bot
                    const jitter = Math.floor((Math.random() * 2 - 1) * cfg.PACKET_JITTER);
                    await new Promise(r => setTimeout(r, cfg.PACKET_DELAY + jitter));

                    drawn = i + 1; // mark this step as safely completed
                }

                return drawn; // hand back the resume index to Node

            }, steps, CONFIG, resumeFrom);

            // Store progress so reconnect can resume instead of restart
            this.drawStepIndex = stepsDrawn;

        } catch (err) {
            if (err.message.includes('destroyed') || err.message.includes('SOCKET_SYNC_TIMEOUT')) {
                console.log(`[SYSTEM] Connection lost at step ${this.drawStepIndex}. Resuming in 3s...`);
                await new Promise(r => setTimeout(r, 3000));
                return this.draw(steps); // resumes from this.drawStepIndex, not step 0
            }
            console.error("[DRAW ERROR]", err.message);
        }
    }
}

new DrawBot().init();