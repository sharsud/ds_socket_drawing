/**
 * =========================================================================
 * DRAWBOT v13.2 — Procedural Neon Engine (VBS-Friendly)
 * =========================================================================
 *
 * MODIFICATIONS:
 * - Replaced static color arrays with programmatic random RGB neon generation.
 * - Enforces bright neon hues while explicitly avoiding near-white canvas blend-outs.
 * - Preserved the core 6-layer illusion matrix pipeline.
 */

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, 'transfer.txt');

if (!fs.existsSync(FILE_PATH)) {
    fs.writeFileSync(FILE_PATH, '', 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
    ROOM_URL:           'https://www.drawasaurus.org/',
    USERNAME:           'Psudo',
    CANVAS_WIDTH:       800,
    CANVAS_HEIGHT:      600,
    CANVAS_MARGIN_PCT:  0.18, 

   FONTS: [
        'Century Gothic',       // Sleek, ultra-modern geometric layout
        'Cinzel',               // Elite, razor-sharp classical roman structure
        'Edwardian Script ITC', // Premium, hyper-elegant sweeping cursive
        'Futura',               // High-end, sharp geometric tech style
        'Garamond',             // High-contrast, premium traditional elite serif
        'Vladimir Script',      // Artistic, flowing elite script with dramatic angles
        'Palatino',             // Strong, elegant, sophisticated calligraphic serif
        'Georgia',              // Deeply defined, highly legible bold serif track
        'Monotype Corsiva'      // Clean, classic, readable high-end italic script
    ],

    LETTER_SPACING_PX:  14,   
    SCANLINE_STEP:      2,    
    PACKET_DELAY:       25,        
    BUFFER_GATE:        3500,
    BUFFER_POLL:        12,
    TIME_LIMIT_MS:      48000,
    POLL_INTERVAL_MS:   500 
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────

class DrawBot {
    async init() {
        console.log('═══ DrawBot v13.2 Procedural RGB Engine Online ═══');
        console.log(`[WATCHER] Polling target queue: ${FILE_PATH}`);

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
        
        await this.page.waitForSelector('canvas', { timeout: 15000 }).catch(() => null);
        this._startFileListener();
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
            console.warn('[LOGIN] Direct elements bypassed:', e.message);
        }
    }

    _startFileListener() {
        let isProcessing = false;

        setInterval(async () => {
            if (isProcessing) return;

            try {
                const data = fs.readFileSync(FILE_PATH, 'utf8').trim();
                if (data.length > 0) {
                    isProcessing = true;
                    console.log(`[INJECT] Dynamic string intercepted: "${data}"`);
                    
                    fs.writeFileSync(FILE_PATH, '', 'utf8');
                    await this._processTextRequest(data);
                    
                    console.log('[STATUS] Execution pass over. Ready for next loop.');
                    isProcessing = false;
                }
            } catch (err) {
                console.error('[IO READ ERROR]', err.message);
                isProcessing = false; 
            }
        }, CONFIG.POLL_INTERVAL_MS);
    }

    async _processTextRequest(text) {
        try {
            const payloads = await this.page.evaluate((txt, cfg) => {
                const canvas = document.createElement('canvas');
                canvas.width = cfg.CANVAS_WIDTH;
                canvas.height = cfg.CANVAS_HEIGHT;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });

                const font = cfg.FONTS[Math.floor(Math.random() * cfg.FONTS.length)];
                const isCursive = font.includes('Script') || font.includes('Handwriting');
                const fontSize = isCursive ? Math.floor(Math.random() * 10) + 75 : Math.floor(Math.random() * 15) + 65;
                
                ctx.font = isCursive ? `${fontSize}px "${font}", cursive` : `bold ${fontSize}px "${font}"`;

                let totalWidth = 0;
                for (let i = 0; i < txt.length; i++) {
                    totalWidth += ctx.measureText(txt[i]).width;
                    if (i < txt.length - 1) totalWidth += cfg.LETTER_SPACING_PX;
                }

                const marginX = cfg.CANVAS_WIDTH * cfg.CANVAS_MARGIN_PCT;
                const marginY = cfg.CANVAS_HEIGHT * cfg.CANVAS_MARGIN_PCT;

                const maxX = cfg.CANVAS_WIDTH - totalWidth - marginX;
                const maxY = cfg.CANVAS_HEIGHT - marginY;
                const minX = marginX;
                const minY = marginY + fontSize;

                const randomX = Math.max(minX, Math.floor(Math.random() * (maxX - minX + 1)) + minX);
                const randomY = Math.max(minY, Math.floor(Math.random() * (maxY - minY + 1)) + minY);

                // Generates vibrant neon RGB combinations by forcing channels high or fully off, avoiding white.
                const generateProceduralNeon = () => {
                    const channels = [255, Math.floor(Math.random() * 160), 0];
                    // Shuffle array values randomly to distribute weights down Red/Green/Blue axis channels
                    for (let i = channels.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [channels[i], channels[j]] = [channels[j], channels[i]];
                    }
                    const r = channels[0].toString(16).padStart(2, '0');
                    const g = channels[1].toString(16).padStart(2, '0');
                    const b = channels[2].toString(16).padStart(2, '0');
                    return `#${r}${g}${b}`;
                };

                let neonMain = generateProceduralNeon();
                let neonAlt = generateProceduralNeon();

                const drawSpacedText = (targetCtx, color, xOffset, yOffset) => {
                    targetCtx.fillStyle = color;
                    let currentX = randomX + xOffset;
                    const targetY = randomY + yOffset;
                    for (let i = 0; i < txt.length; i++) {
                        targetCtx.fillText(txt[i], currentX, targetY);
                        currentX += targetCtx.measureText(txt[i]).width + cfg.LETTER_SPACING_PX;
                    }
                };

                const passes = [];
                const effectSelector = Math.floor(Math.random() * 6); 

                if (effectSelector === 0) {
                    console.log("-> Selected Style: 🌊 Kinetic Wave Displacement");
                    const tmpCanvas = document.createElement('canvas');
                    tmpCanvas.width = canvas.width; tmpCanvas.height = canvas.height;
                    const tmpCtx = tmpCanvas.getContext('2d');
                    tmpCtx.font = ctx.font;
                    drawSpacedText(tmpCtx, neonMain, 0, 0);
                    
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    for (let x = 0; x < canvas.width; x++) {
                        const shiftY = Math.round(Math.sin(x * 0.04) * 16);
                        ctx.drawImage(tmpCanvas, x, 0, 1, canvas.height, x, shiftY, 1, canvas.height);
                    }
                    passes.push({ color: neonMain, ctxData: ctx.getImageData(0, 0, canvas.width, canvas.height), thickOverride: 4 });

                } else if (effectSelector === 1) {
                    console.log("-> Selected Style: 🔭 Isometric 3D Extrusion");
                    const depthSteps = 12;
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    for (let k = depthSteps; k > 0; k--) {
                        drawSpacedText(ctx, '#111111', k, k);
                    }
                    passes.push({ color: '#000000', ctxData: ctx.getImageData(0, 0, canvas.width, canvas.height), thickOverride: 4 });

                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    drawSpacedText(ctx, neonMain, 0, 0);
                    passes.push({ color: neonMain, ctxData: ctx.getImageData(0, 0, canvas.width, canvas.height), thickOverride: 4 });

                } else if (effectSelector === 2) {
                    console.log("-> Selected Style: 🏁 Cyberpunk Matrix Glitch");
                    const tmpCanvas = document.createElement('canvas');
                    tmpCanvas.width = canvas.width; tmpCanvas.height = canvas.height;
                    const tmpCtx = tmpCanvas.getContext('2d');
                    tmpCtx.font = ctx.font;
                    drawSpacedText(tmpCtx, neonMain, 0, 0);

                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    for (let x = 0; x < canvas.width; x += 4) {
                        const isGlitched = Math.random() < 0.35;
                        const splitShift = isGlitched ? (Math.random() > 0.5 ? 12 : -12) : 0;
                        ctx.drawImage(tmpCanvas, x, 0, 4, canvas.height, x, splitShift, 4, canvas.height);
                    }
                    passes.push({ color: neonMain, ctxData: ctx.getImageData(0, 0, canvas.width, canvas.height), thickOverride: 4 });

                } else if (effectSelector === 3) {
                    console.log("-> Selected Style: 🦓 Laser Zebra Interlacing");
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    drawSpacedText(ctx, neonMain, 0, 0);
                    const rawData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const pix = rawData.data;

                    for (let y = 0; y < canvas.height; y++) {
                        if (y % 6 < 3) { 
                            for (let x = 0; x < canvas.width; x++) {
                                const baseIdx = (y * canvas.width + x) * 4;
                                pix[baseIdx + 3] = 0; 
                            }
                        }
                    }
                    passes.push({ color: neonMain, ctxData: rawData, thickOverride: 4 });

                } else if (effectSelector === 4) {
                    console.log("-> Selected Style: 🎯 Comic Book Stencil Pop-Art");
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    ctx.strokeStyle = '#111111';
                    ctx.lineWidth = 10;
                    let outlineX = randomX;
                    for (let i = 0; i < txt.length; i++) {
                        ctx.strokeText(txt[i], outlineX, randomY);
                        outlineX += ctx.measureText(txt[i]).width + cfg.LETTER_SPACING_PX;
                    }
                    passes.push({ color: '#000000', ctxData: ctx.getImageData(0, 0, canvas.width, canvas.height), stencil: true, thickOverride: 3 });

                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    drawSpacedText(ctx, neonMain, 0, 0);
                    passes.push({ color: neonMain, ctxData: ctx.getImageData(0, 0, canvas.width, canvas.height), thickOverride: 4 });

                } else if (effectSelector === 5) {
                    console.log("-> Selected Style: ⚡ Chiseled Center Inline");
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    drawSpacedText(ctx, neonMain, 0, 0);
                    passes.push({ color: neonMain, ctxData: ctx.getImageData(0, 0, canvas.width, canvas.height), thickOverride: 6 }); 

                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    drawSpacedText(ctx, '#ffffff', 0, 0);
                    passes.push({ color: '#ffffff', ctxData: ctx.getImageData(0, 0, canvas.width, canvas.height), thickOverride: 2 }); 
                }

                const localPayloads = [];
                const step = cfg.SCANLINE_STEP;

                for (const pass of passes) {
                    const data = pass.ctxData.data;

                    for (let x = 0; x < canvas.width; x += step) {
                        let inStroke = false;
                        let startY = 0;
                        const verticalInterval = pass.stencil ? 4 : 1;

                        for (let y = 0; y < canvas.height; y += verticalInterval) {
                            const idx = (y * canvas.width + x) * 4;
                            const alpha = data[idx + 3];

                            if (alpha > 60) { 
                                if (!inStroke) {
                                    inStroke = true;
                                    startY = y;
                                }
                                if (pass.stencil) {
                                    localPayloads.push({
                                        color: pass.color,
                                        points: [[x, startY], [x, y]],
                                        thick: pass.thickOverride
                                    });
                                    inStroke = false;
                                }
                            } else {
                                if (inStroke) {
                                    localPayloads.push({
                                        color: pass.color,
                                        points: [[x, startY], [x, y - 1]],
                                        thick: pass.thickOverride
                                    });
                                    inStroke = false;
                                }
                            }
                        }
                        if (inStroke) {
                            localPayloads.push({
                                color: pass.color,
                                points: [[x, startY], [x, canvas.height - 1]],
                                thick: pass.thickOverride
                            });
                        }
                    }
                }
                return localPayloads;
            }, text, CONFIG);

            if (payloads && payloads.length > 0) {
                console.log(`[TRANSMIT] Transferring ${payloads.length} customized dynamic matrix steps...`);
                await this._transmit(payloads);
            }
        } catch (e) {
            console.error('[PROCESSING ERROR]', e.message);
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
                const BATCH_SIZE = 12; 

                for (let i = 0; i < payloads.length; i++) {
                    if (Date.now() - start > cfg.TIME_LIMIT_MS) break;

                    socket = getSocket();
                    while (!socket || socket.readyState !== 1) {
                        await sleep(30);
                        socket = getSocket();
                    }

                    while (socket.bufferedAmount > cfg.BUFFER_GATE) {
                        await sleep(cfg.BUFFER_POLL);
                        socket = getSocket();
                    }

                    const { color, points, thick } = payloads[i];
                    const strokeWidth = thick || 4; 

                    socket.send(JSON.stringify({
                        a: ['drawLine', { colour: color, lines: points, thick: strokeWidth }],
                    }));

                    if (ctx && points.length > 0) {
                        ctx.beginPath();
                        ctx.strokeStyle = color;
                        ctx.lineWidth    = strokeWidth;
                        ctx.lineCap     = 'round';
                        ctx.moveTo(points[0][0], points[0][1]);
                        ctx.lineTo(points[1][0], points[1][1]);
                        ctx.stroke();
                    }

                    if (i % BATCH_SIZE === 0) {
                        await sleep(cfg.PACKET_DELAY);
                    }
                }
            }, payloads, CONFIG);
        } catch (err) {
            console.error('[TRANSMIT EXCEPTION]', err.message);
        }
    }
}

new DrawBot().init().catch(err => {
    console.error('[FATAL ERROR]', err);
    process.exit(1);
});