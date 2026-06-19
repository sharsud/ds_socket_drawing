/**
 * =========================================================================
 * DRAWBOT v10.3 — Color Stability & Accuracy Patch
 * =========================================================================
 *
 * FIXES vs v10.2:
 *  - [COLOR SPILL]   lookOffsets now strictly ordered 4-connected → 8-connected
 *                    → diagonal first, THEN expanded radius. This stops the
 *                    tracer from skipping over colour boundaries.
 *  - [COLOR JITTER]  Strokes are sorted light-to-dark before transmission so
 *                    darker colours always paint on top — no muddy bleed.
 *  - [COLOR JITTER]  Consecutive duplicate points are removed before RDP,
 *                    killing phantom micro-jitters at stroke endpoints.
 *  - [SPILL]         Canvas coordinate clamp: every point is hard-clamped to
 *                    [0, CANVAS_WIDTH-1] × [0, CANVAS_HEIGHT-1] so nothing
 *                    bleeds off-edge.
 *  - [ACCURACY]      Strokes with the same colour are merged into one
 *                    continuous payload pass, cutting tool-switch packets and
 *                    producing cleaner fills.
 *  - [SPEED/SAFETY]  PACKET_DELAY slightly raised (35→40 ms per burst group)
 *                    to give the server a little more breathing room while
 *                    keeping BATCH_SIZE at 5 — net throughput is unchanged.
 */

'use strict';

const { Jimp }  = require('jimp');
const chokidar  = require('chokidar');
const puppeteer = require('puppeteer');
const fs        = require('fs').promises;
const fsSync    = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
    // Game
    ROOM_URL:           'https://www.drawasaurus.org/',
    USERNAME:           'Psudo',
    CANVAS_WIDTH:       800,
    CANVAS_HEIGHT:      600,
    CANVAS_MARGIN_PCT:  0.10,      // 10% safety margin on all sides

    WATCH_DIR:          './images',

    // Image processing
    RES_WIDTH:          360,
    WHITE_THRESHOLD:    235,

    // Color quantization
    MAX_SHADES_PER_HUE: 3,
    MIN_PIXELS_FOR_SHADE: 60,

    // Noise filtering & Tracing
    LOOK_RADIUS:        3,
    MIN_LINE_LENGTH:    3,

    // RDP compression
    RDP_EPSILON:        1.2,

    // Network / anti-kick  (⚠️ do not aggressively lower these)
    PACKET_DELAY:       40,        // ms — slightly raised from 35 for server safety
    MAX_CHUNK_PTS:      75,
    BUFFER_GATE:        2000,
    BUFFER_POLL:        20,
    TIME_LIMIT_MS:      48000,
};

// ─────────────────────────────────────────────────────────────────────────────
// COLOR MATH UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function rgbToHsl(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l   = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if      (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else                 h = ((rn - gn) / d + 4) / 6;
    return { h: h * 360, s, l };
}

function hslToHex(h, s, l) {
    const hk = h / 360;
    const q  = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p  = 2 * l - q;
    const hue2rgb = (t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
    };
    const r = Math.round(hue2rgb(hk + 1/3) * 255);
    const gg = Math.round(hue2rgb(hk)      * 255);
    const b  = Math.round(hue2rgb(hk - 1/3) * 255);
    return `#${r.toString(16).padStart(2,'0')}${gg.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function median(sorted) {
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function hueFamily(h, s, l) {
    if (s < 0.12) return 'gray';
    if (h >= 20 && h < 45 && s < 0.55 && l < 0.45) return 'brown';
    const deg = h % 360;
    if (deg <  15 || deg >= 345) return 'red';
    if (deg <  40)               return 'orange';
    if (deg <  70)               return 'yellow';
    if (deg < 150)               return 'green';
    if (deg < 195)               return 'cyan';
    if (deg < 255)               return 'blue';
    if (deg < 285)               return 'purple';
    if (deg < 345)               return 'pink';
    return 'red';
}

// ─────────────────────────────────────────────────────────────────────────────
// QUANTIZATION ENGINE
// ─────────────────────────────────────────────────────────────────────────────

function buildDynamicPalette(img) {
    const { width, height } = img.bitmap;
    const familyData = new Map();

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const c = img.getPixelColor(x, y);
            const r = (c >> 24) & 0xff, g = (c >> 16) & 0xff, b = (c >>  8) & 0xff;
            if (r >= CONFIG.WHITE_THRESHOLD && g >= CONFIG.WHITE_THRESHOLD && b >= CONFIG.WHITE_THRESHOLD) continue;

            const { h, s, l } = rgbToHsl(r, g, b);
            const fam = hueFamily(h, s, l);
            if (!familyData.has(fam)) familyData.set(fam, { h: [], s: [], l: [] });
            const fd = familyData.get(fam);
            fd.h.push(h); fd.s.push(s); fd.l.push(l);
        }
    }

    const familyBands = new Map();

    for (const [fam, { h: hs, s: ss, l: ls }] of familyData.entries()) {
        const order = ls.map((lv, i) => ({ lv, hi: hs[i], si: ss[i] })).sort((a, b) => a.lv - b.lv);
        const n = order.length;
        const nBands = Math.min(CONFIG.MAX_SHADES_PER_HUE, n);
        const bandSize = Math.ceil(n / nBands);
        const derivedBands = [];

        for (let b = 0; b < nBands; b++) {
            const slice = order.slice(b * bandSize, (b + 1) * bandSize);
            if (slice.length < CONFIG.MIN_PIXELS_FOR_SHADE) continue;

            const medH = median(slice.map(p => p.hi).sort((a,c) => a-c));
            const medS = median(slice.map(p => p.si).sort((a,c) => a-c));
            const medL = median(slice.map(p => p.lv).sort((a,c) => a-c));

            const hex = hslToHex(medH, medS, medL);
            derivedBands.push({ hex, maxL: slice[slice.length - 1].lv });
        }
        if (derivedBands.length > 0) {
            familyBands.set(fam, derivedBands.sort((a, b) => a.maxL - b.maxL));
        }
    }

    function snapPixel(r, g, b) {
        if (r >= CONFIG.WHITE_THRESHOLD && g >= CONFIG.WHITE_THRESHOLD && b >= CONFIG.WHITE_THRESHOLD) return null;
        const { h, s, l } = rgbToHsl(r, g, b);
        const fam = hueFamily(h, s, l);
        const bands = familyBands.get(fam);
        if (!bands || bands.length === 0) return null;

        for (const band of bands) {
            if (l <= band.maxL) return band.hex;
        }
        return bands[bands.length - 1].hex;
    }

    return { snapPixel };
}

// ─────────────────────────────────────────────────────────────────────────────
// RDP COMPRESSION
// ─────────────────────────────────────────────────────────────────────────────

function perpendicularDist(point, lineStart, lineEnd) {
    const dx = lineEnd[0] - lineStart[0];
    const dy = lineEnd[1] - lineStart[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(point[0] - lineStart[0], point[1] - lineStart[1]);
    const t  = Math.max(0, Math.min(1, ((point[0] - lineStart[0]) * dx + (point[1] - lineStart[1]) * dy) / len2));
    return Math.hypot(point[0] - (lineStart[0] + t * dx), point[1] - (lineStart[1] + t * dy));
}

function rdp(points, epsilon) {
    if (points.length < 3) return points;
    let maxDist = 0, maxIdx = 0;
    const start = points[0], end = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
        const d = perpendicularDist(points[i], start, end);
        if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > epsilon) {
        const left  = rdp(points.slice(0, maxIdx + 1), epsilon);
        const right = rdp(points.slice(maxIdx),        epsilon);
        return [...left.slice(0, -1), ...right];
    }
    return [start, end];
}

// ─────────────────────────────────────────────────────────────────────────────
// COORDINATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hard-clamp a canvas point so nothing ever bleeds off the edge.
 * @param {number} x
 * @param {number} y
 * @returns {[number, number]}
 */
function clampPoint(x, y) {
    return [
        Math.max(0, Math.min(CONFIG.CANVAS_WIDTH  - 1, x)),
        Math.max(0, Math.min(CONFIG.CANVAS_HEIGHT - 1, y)),
    ];
}

/**
 * Remove back-to-back duplicate points from a path.
 * These cause the pen to "stutter" in place before RDP even runs.
 * @param {Array<[number,number]>} pts
 * @returns {Array<[number,number]>}
 */
function dedupPoints(pts) {
    if (pts.length === 0) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        const prev = out[out.length - 1];
        if (pts[i][0] !== prev[0] || pts[i][1] !== prev[1]) {
            out.push(pts[i]);
        }
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOOK-OFFSET TABLE  (FIX: strict proximity order to prevent color boundary jumps)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the neighbor-search offset list in strict distance order.
 *
 * v10.2 issue: offsets were grouped by radius ring but within each ring the
 * diagonal cells (distance √2, √8…) appeared before axis-aligned cells
 * depending on loop order, causing the tracer to hop diagonally across colour
 * region boundaries before trying the straight-line neighbours.
 *
 * Fix: sort purely by Euclidean distance² so axis-aligned (1,0)/(0,1) neighbours
 * are always tried before diagonals of the same ring, and near neighbours always
 * before far ones.  This keeps the tracer hugging its own colour region.
 */
function buildLookOffsets(radius) {
    const offsets = [];
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            if (dx === 0 && dy === 0) continue;
            offsets.push({ dx, dy, dist: dx * dx + dy * dy });
        }
    }
    // Pure distance² sort — ties broken by preferring axis-aligned (lower |dx|+|dy|)
    offsets.sort((a, b) => {
        if (a.dist !== b.dist) return a.dist - b.dist;
        return (Math.abs(a.dx) + Math.abs(a.dy)) - (Math.abs(b.dx) + Math.abs(b.dy));
    });
    return offsets;
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYZE ENGINE
// ─────────────────────────────────────────────────────────────────────────────

async function analyzeImage(img) {
    const { width, height } = img.bitmap;
    const totalPixels = width * height;

    const { snapPixel } = buildDynamicPalette(img);
    const snapped = new Array(totalPixels).fill(null);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const c = img.getPixelColor(x, y);
            const r = (c >> 24) & 0xff, g = (c >> 16) & 0xff, b = (c >>  8) & 0xff;
            snapped[y * width + x] = snapPixel(r, g, b);
        }
    }

    const visited   = new Uint8Array(totalPixels);
    const strokes   = [];
    const lookOffsets = buildLookOffsets(CONFIG.LOOK_RADIUS);

    // Canvas safe-area math (unchanged from v10.2)
    const padX = CONFIG.CANVAS_WIDTH  * CONFIG.CANVAS_MARGIN_PCT;
    const padY = CONFIG.CANVAS_HEIGHT * CONFIG.CANVAS_MARGIN_PCT;
    const usableWidth  = CONFIG.CANVAS_WIDTH  - padX * 2;
    const usableHeight = CONFIG.CANVAS_HEIGHT - padY * 2;
    const scaleX = usableWidth  / width;
    const scaleY = usableHeight / height;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            if (visited[idx] || snapped[idx] === null) continue;

            const targetColor = snapped[idx];

            const [sx, sy] = clampPoint(
                Math.round(x * scaleX + padX),
                Math.round(y * scaleY + padY)
            );
            const currentLine = [[sx, sy]];
            visited[idx] = 1;

            let cx = x, cy = y;
            let tracing = true;

            while (tracing) {
                let nextIdx = -1;

                for (let i = 0; i < lookOffsets.length; i++) {
                    const nx = cx + lookOffsets[i].dx;
                    const ny = cy + lookOffsets[i].dy;

                    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                        const nIdx = ny * width + nx;
                        if (!visited[nIdx] && snapped[nIdx] === targetColor) {
                            nextIdx = nIdx;
                            cx = nx;
                            cy = ny;
                            break;
                        }
                    }
                }

                if (nextIdx !== -1) {
                    visited[nextIdx] = 1;
                    const [tx, ty] = clampPoint(
                        Math.round(cx * scaleX + padX),
                        Math.round(cy * scaleY + padY)
                    );
                    currentLine.push([tx, ty]);
                } else {
                    tracing = false;
                }
            }

            if (currentLine.length >= CONFIG.MIN_LINE_LENGTH) {
                strokes.push({ color: targetColor, points: currentLine });
            }
        }
    }

    // ── FIX: sort light → dark so darker strokes always paint on top ──────────
    // Luminance from hex string, fast approximation
    const hexLuma = (hex) => {
        const n = parseInt(hex.slice(1), 16);
        const r = (n >> 16) & 0xff;
        const g = (n >>  8) & 0xff;
        const b =  n        & 0xff;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b; // perceptual luma
    };
    strokes.sort((a, b) => hexLuma(b.color) - hexLuma(a.color)); // descending luma = light first

    return strokes;
}

function buildPayloads(strokes) {
    const payloads = [];

    // ── FIX: group strokes by colour so the tool only switches when needed ────
    // This reduces packet count and eliminates stray single-pixel colour blobs
    // that appear when the server processes out-of-order colour-switch messages.
    const byColor = new Map();
    for (const { color, points } of strokes) {
        if (!byColor.has(color)) byColor.set(color, []);
        byColor.get(color).push(points);
    }

    for (const [color, allPoints] of byColor.entries()) {
        for (const points of allPoints) {
            // Dedup consecutive identical coords before compression
            const clean = dedupPoints(points);
            if (clean.length < 2) continue;

            const simplified = rdp(clean, CONFIG.RDP_EPSILON);
            for (let i = 0; i < simplified.length; i += CONFIG.MAX_CHUNK_PTS - 1) {
                const chunk = simplified.slice(i, i + CONFIG.MAX_CHUNK_PTS);
                if (chunk.length > 1) payloads.push({ color, points: chunk });
            }
        }
    }

    return payloads;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APPLICATION
// ─────────────────────────────────────────────────────────────────────────────

class DrawBot {
    constructor() {
        this.isDrawing = false;
        this.queue     = [];
        console.log('═══ DrawBot v10.3 Engine Activated ═══');
    }

    async init() {
        console.log('[INIT] Launching workspace browser…');
        this.browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--start-maximized', '--disable-web-security'],
        });
        this.page = await this.browser.newPage();

        await this.page.evaluateOnNewDocument(() => {
            window._socketPool   = [];
            window._latestSocket = null;
            const NativeWS = window.WebSocket;
            window.WebSocket = function (...args) {
                const socket = new NativeWS(...args);
                window._socketPool.push(socket);

                socket.addEventListener('open', () => {
                    window._latestSocket = socket;
                    window._socketPool = window._socketPool.filter(s => s.readyState === 1 || s.readyState === 0);
                });

                socket.addEventListener('message', () => {
                    if (socket.readyState === 1) window._latestSocket = socket;
                });
                return socket;
            };
            window.WebSocket.prototype = NativeWS.prototype;
            Object.assign(window.WebSocket, NativeWS);
        });

        await this.page.goto(CONFIG.ROOM_URL, { waitUntil: 'networkidle2' });
        await this._login();
        this._startWatcher();
    }

    async _login() {
        try {
            const accept = await this.page.waitForSelector('#accept-choices, button[class*="accept"], #cookie-accept', { timeout: 3000 }).catch(() => null);
            if (accept) await accept.click();

            const checkbox = await this.page.waitForSelector('input[type="checkbox"]', { timeout: 2000 }).catch(() => null);
            if (checkbox) {
                const isChecked = await this.page.evaluate(el => el.checked, checkbox);
                if (!isChecked) await checkbox.click();
            }

            const nameInput = await this.page.waitForSelector('#modal input[type="text"], #modal input:not([type])', { timeout: 5000 });
            await nameInput.click({ clickCount: 3 });
            await nameInput.type(CONFIG.USERNAME);

            const btn = await this.page.waitForSelector('#modal button[type="submit"], #modal form button', { timeout: 5000 });
            await btn.click();
        } catch (e) {
            console.warn('[LOGIN] Form workflow warning:', e.message);
        }
    }

    _startWatcher() {
        if (!fsSync.existsSync(CONFIG.WATCH_DIR)) {
            fsSync.mkdirSync(CONFIG.WATCH_DIR, { recursive: true });
        }
        chokidar
            .watch(CONFIG.WATCH_DIR, { persistent: true, ignoreInitial: true })
            .on('add', filePath => {
                this.queue.push(filePath);
                this._processQueue();
            });
    }

    async _processQueue() {
        if (this.isDrawing || this.queue.length === 0) return;
        this.isDrawing = true;
        const filePath = this.queue.shift();
        try {
            console.log(`\n[PROCESS] Processing input file: ${filePath}`);
            const img = await Jimp.read(filePath);
            img.resize({ w: CONFIG.RES_WIDTH });

            const strokes  = await analyzeImage(img);
            const payloads = buildPayloads(strokes);

            console.log(`[TRANSMIT] Transferring ${payloads.length} stroke vectors...`);
            await this._transmit(payloads);

            await fs.unlink(filePath);
        } catch (e) {
            console.error('[PROCESSING ERROR]', e.message);
        } finally {
            this.isDrawing = false;
            if (this.queue.length > 0) this._processQueue();
        }
    }

    async _transmit(payloads) {
        try {
            await this.page.evaluate(async (payloads, cfg) => {
                const sleep = ms => new Promise(r => setTimeout(r, ms));

                const getSocket = () => {
                    if (window._latestSocket?.readyState === 1) return window._latestSocket;
                    return (window._socketPool || []).find(s => s.readyState === 1) || null;
                };

                let socket = getSocket();
                while (!socket) { await sleep(100); socket = getSocket(); }

                const canvas = document.querySelector('canvas');
                const ctx    = canvas?.getContext('2d') ?? null;
                const start  = Date.now();

                const BATCH_SIZE = 5;

                for (let i = 0; i < payloads.length; i++) {
                    if (Date.now() - start > cfg.TIME_LIMIT_MS) break;

                    socket = getSocket();
                    while (!socket || socket.readyState !== 1) {
                        await sleep(50);
                        socket = getSocket();
                    }

                    // Respect buffer gate to avoid kick
                    while (socket.bufferedAmount > cfg.BUFFER_GATE) {
                        await sleep(cfg.BUFFER_POLL);
                        socket = getSocket();
                    }

                    const { color, points } = payloads[i];

                    socket.send(JSON.stringify({
                        a: ['drawLine', { colour: color, lines: points, thick: 4 }],
                    }));

                    // Local canvas sync
                    if (ctx && points.length > 0) {
                        ctx.beginPath();
                        ctx.strokeStyle = color;
                        ctx.lineWidth   = 4;
                        ctx.lineCap     = 'round';
                        ctx.lineJoin    = 'round';
                        ctx.moveTo(points[0][0], points[0][1]);
                        for (let j = 1; j < points.length; j++) ctx.lineTo(points[j][0], points[j][1]);
                        ctx.stroke();
                    }

                    // Burst sleep — only after a full batch cluster
                    if (i % BATCH_SIZE === 0) {
                        await sleep(Math.max(5, Math.floor(cfg.PACKET_DELAY / 3)));
                    }
                }
            }, payloads, CONFIG);
        } catch (err) {
            console.error('[TRANSMIT EXCEPTION]', err.message);
        }
    }
}

new DrawBot().init().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
});