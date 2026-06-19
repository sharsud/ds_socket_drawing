const { Jimp } = require('jimp');
const puppeteer = require('puppeteer');
const fs = require("fs");
const CONFIG = {
    ROOM_URL: 'https://www.drawasaurus.org/room/The+moose+Room',
    USERNAME: 'Psudo',
    PACKET_DELAY: 25,
    TIME_LIMIT_MS: 48000,
    WHITE_THRESHOLD: 230,
    RES_WIDTH: 450,
    STRICT_UP_DIST: 0.02,
    SEARCH_LOOKAHEAD: 140,
    LAYERS: [{ thick: 4, step: 1.5, maxPoints: 45 }],
    CANVAS_WIDTH: 800,
    CANVAS_HEIGHT: 600,
    XP_TURN_INDICATOR: '//*[@id="__next"]/div/div/main/div/div/div[2]/div/div[3]/div',
    XP_PROMPT_TEXT: '//*[@id="__next"]/div/div/main/div/div[1]/div[2]/button'
};
const API_KEY = "55451316-0bea46e5eff16ea50bbfc626b"; // replace this

// ❌ Words to avoid per query
const NEGATIVE_KEYWORDS = {
    nail: ["polish", "manicure", "fingernail"],
    bat: ["baseball"],
    mouse: ["computer"],
    crane: ["machine"],
    chip: ["food"],
};

    // 🧠 Score images based on relevance
    
async function getDynamicPalette(image) {
    const counts = new Map();
    const { width, height } = image.bitmap;
    for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
            const c = image.getPixelColor(x, y);
            const r = (c >> 24) & 0xFF;
            const g = (c >> 16) & 0xFF;
            const b = (c >> 8) & 0xFF;
            const a = c & 0xFF;
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

class OpenClipartBot {
    constructor() {
        this.isDrawing = false;
        this.lastSubject = "";
        console.log('--- Generic OpenClipart Autonomous Bot Active ---');
    }

    async init() {
        this.browser = await puppeteer.launch({ 
            headless: false, 
            defaultViewport: null, 
            args: ['--start-maximized', '--disable-web-security'] 
        });
        this.page = await this.browser.newPage();

        // Socket Sniffer & Hijacker
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

        // Auto-Login
        try {
            const accept = await this.page.waitForSelector('xpath///*[@id="accept-choices"]', { timeout: 3000 }).catch(() => null);
            if (accept) await accept.click();
            const input = await this.page.waitForSelector('xpath///*[@id="modal"]//input', { timeout: 5000 });
            await input.type(CONFIG.USERNAME);
            const btn = await this.page.waitForSelector('xpath///*[@id="modal"]//button');
            await btn.click();
        } catch (e) { console.warn("[NAV] Manual login required."); }

        this.monitorTurn();
    }

    async monitorTurn() {
        setInterval(async () => {
            if (this.isDrawing) return;
            try {
                const promptHandle = await this.page.$('xpath/' + CONFIG.XP_PROMPT_TEXT);
                if (promptHandle) {
                    const rawText = await this.page.evaluate(el => el.innerText, promptHandle);
                    if (rawText.toLowerCase().includes("drawing")) {
                        const subject = rawText.replace(/You are Drawing\s+/i, '').trim().toUpperCase();
                        if (subject && subject !== this.lastSubject && subject.length > 2) {
                            if (subject.includes("WAITING") || subject.includes("CHOOSING")) return;
                            this.lastSubject = subject;
                            await this.runAutomation(subject);
                        }
                    }
                }
            } catch (e) {}
        }, 2500);
    }

    /**
     * SMART GENERIC SEARCH
     * Uses OpenClipart's public API to find drawable assets.
     */
    async fetchFromOpenverse(query) {
    try {
        const url = `https://api.openverse.engineering/v1/images?q=${encodeURIComponent(query)}&license=cc0`;

        const res = await fetch(url);
        console.log("[Openverse STATUS]", res.status);

        const data = await res.json();

        if (data.results && data.results.length > 0) {
            console.log("[Openverse HIT]");
            return data.results[0].url;
        }

    } catch (e) {
        console.error("[Openverse ERROR]", e.message);
    }

    return null;
}
// -----------------------------
// SMART PIXABAY SEARCH MODULE
// -----------------------------

    scoreImage(img, query) {
        const text = (img.tags || "").toLowerCase();
        let score = 0;

        if (text.includes(query)) score += 5;
        if (text.includes("outline")) score += 4;
        if (text.includes("line")) score += 3;
        if (text.includes("simple")) score += 3;
        if (text.includes("cartoon")) score += 2;
        if (text.includes("black")) score += 1;
        if (text.includes("white")) score += 1;
        if (text.includes("vector")) score += 2;

        return score;
    }
    // 🚫 Remove wrong matches
    filterImages(images, query) {
        const badWords = NEGATIVE_KEYWORDS[query] || [];

        return images.filter(img => {
            const text = (img.tags || "").toLowerCase();

            // remove unwanted meanings
            if (badWords.some(bad => text.includes(bad))) {
                return false;
            }

            return true;
        });
    }

    // 🔍 Core Pixabay fetch
    async fetchFromPixabay(query) {
        try {
            const url = `https://pixabay.com/api/?key=${API_KEY}&q=${encodeURIComponent(query)}&image_type=illustration&per_page=20`;

            const res = await fetch(url);
            const data = await res.json();

            if (!data.hits || data.hits.length === 0) {
                console.log("[Pixabay] No results");
                return null;
            }

            // Step 1: filter junk
            let images = this.filterImages(data.hits, query);

            if (images.length === 0) {
                images = data.hits; // fallback to all
            }

            // Step 2: score and pick best
            const best = images
                .map(img => ({
                    img,
                    score: this.scoreImage(img, query)
                }))
                .sort((a, b) => b.score - a.score)[0];

            if (best) {
                console.log("[Pixabay BEST MATCH]", best.img.tags);
                return best.img.webformatURL;
            }

        } catch (e) {
            console.error("[Pixabay ERROR]", e.message);
        }

        return null;
    }

    // 🔥 Main smart search function
    async searchClipart(word) {
        const query = word
            .toLowerCase()
            .replace(/[^a-z0-9 ]/g, "")
            .trim();

        console.log("\n==============================");
        console.log("[SEARCH WORD]", query);
        console.log("==============================");

        // 🎯 Multiple query strategies
        const variations = [
            `${query} clipart`,
            `${query} simple drawing`,
            `${query} line drawing`,
            `${query} vector`,
            `${query} white background`,
            query // fallback
        ];

        for (const q of variations) {
            console.log("[TRYING]", q);

            const result = await this.fetchFromPixabay(q);
            if (result) {
                console.log("[FINAL RESULT]", result);
                return result;
            }
        }

        // fallback
        const fallback = `https://dummyimage.com/400x400/000/fff&text=${encodeURIComponent(query)}`;
        console.log("[FALLBACK]", fallback);

        return fallback;
    }


    async runAutomation(subject) {
        this.isDrawing = true;

        try {
            const imageUrl = await this.searchClipart(subject);
            if (!imageUrl) throw new Error("Could not find image.");

            console.log("[IMAGE URL]", imageUrl);

            // // 👉 Load image ONCE (in memory)
            const img = await Jimp.read(imageUrl);

            // // 👉 Create safe filename
            // const fileName = subject.replace(/[^a-z0-9]/gi, "_").toLowerCase();

            // // 👉 OPTIONAL: Save original to temp/debug
            // await original.writeAsync(`./temp_${fileName}_original.png`);

            // // 👉 Clone for processing (so original stays intact)
            // const img = original.clone();

            // 👉 Process image (used for drawing)
            img.resize({ w: CONFIG.RES_WIDTH })
            .contrast(1)
            .normalize();

            // 👉 Save processed version (for debugging)
            // await img.writeAsync(`./temp_${fileName}_processed.png`);

            // console.log(`[DEBUG] Saved images for ${subject}`);

            // 👉 Continue with SAME processed image (no reload)
            const steps = await this.analyze(img);

            if (steps.length > 0) {
                await this.draw(steps);
            }

            console.log(`[SUCCESS] Finished drawing ${subject}.`);

        } catch (e) {
            console.error(`[ERROR]`, e.message);
        } finally {
            this.isDrawing = false;
        }
    }

    async analyze(img) {
        const { width, height } = img.bitmap;
        const paletteObjects = await getDynamicPalette(img);
        const palette = paletteObjects.map(o => o.hex);
        const steps = [];

        for (const layer of CONFIG.LAYERS) {
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
                    while (stroke.length < layer.maxPoints) {
                        let nearestIdx = -1, nearestD = CONFIG.STRICT_UP_DIST;
                        for (let i = 0; i < Math.min(pool.length, CONFIG.SEARCH_LOOKAHEAD); i++) {
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
                const getActiveSocket = () => {
                    // Refined check: latest captured OR pool member that is currently OPEN
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
                const rect = canvas.getBoundingClientRect();
                const W = rect.width;
                const H = rect.height;
                const ctx = canvas.getContext('2d');
                const start = Date.now();
                for (const s of steps) {
                    if (Date.now() - start > cfg.TIME_LIMIT_MS || socket.readyState !== 1) break;
                    // Adjusted bufferedAmount for smoother line delivery
                    while (socket.bufferedAmount > 15000) await new Promise(r => setTimeout(r, 5));

                    const pts = s.points.map(p => [
                        Math.round(p[0] * W), 
                        Math.round(p[1] * H)
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

new OpenClipartBot().init();