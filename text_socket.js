/**
 * =========================================================================
 * DRAWBOT v11.7 — Spaced Multi-Font Column Engine (VBS-Friendly)
 * =========================================================================
 *
 * FIXES:
 * - Added a character-by-character tracker loop to handle letter-spacing.
 * - Prevents bold strokes from merging horizontally before rendering.
 * - Added narrow, clear sans-serif alternatives to handle compact words.
 * - Injected elegant script/cursive font choices into the random pool.
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
    CANVAS_MARGIN_PCT:  0.15,

    // Replaced problematic fonts with a curated mix of clean narrow and elegant cursive choices
    FONTS: [
        'Arial Narrow',      // Crisp, thin, condensed structure
        'Trebuchet MS',      // Clean layout spacing
        'Courier New',        // Uniform monospace gaps
        'Brush Script MT',   // Classic cursive/script font
        'Lucida Handwriting',// Clear flowing cursive
        'Comic Sans MS'      // Informal separated script style
    ],

    LETTER_SPACING_PX:  12,   // Safe horizontal separation gap forced between characters
    SCANLINE_STEP:      2,    // High fidelity vertical step definition
    PACKET_DELAY:       30,        
    BUFFER_GATE:        3000,
    BUFFER_POLL:        15,
    TIME_LIMIT_MS:      48000,
    POLL_INTERVAL_MS:   500 
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────

class DrawBot {
    async init() {
        console.log('═══ DrawBot v11.7 Spaced Font Engine Activated ═══');
        console.log(`[WATCHER] Monitoring changes in: ${FILE_PATH}`);

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
            console.warn('[LOGIN] Bypassed elements:', e.message);
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
                    console.log(`[INJECT] Target intercepted: "${data}"`);
                    
                    fs.writeFileSync(FILE_PATH, '', 'utf8');
                    await this._processTextRequest(data);
                    
                    console.log('[STATUS] Operation completed.');
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
                
                // Adjust font size scaling depending on cursive vs narrow type density
                const isCursive = font.includes('Script') || font.includes('Handwriting');
                const fontSize = isCursive ? Math.floor(Math.random() * 10) + 75 : Math.floor(Math.random() * 15) + 60;
                
                ctx.font = isCursive ? `${fontSize}px "${font}", cursive` : `bold ${fontSize}px "${font}"`;

                // Calculate exact total layout canvas dimension tracking custom manual kerning
                let calculatedTotalWidth = 0;
                for (let i = 0; i < txt.length; i++) {
                    calculatedTotalWidth += ctx.measureText(txt[i]).width;
                    if (i < txt.length - 1) calculatedTotalWidth += cfg.LETTER_SPACING_PX;
                }

                const marginX = cfg.CANVAS_WIDTH * cfg.CANVAS_MARGIN_PCT;
                const marginY = cfg.CANVAS_HEIGHT * cfg.CANVAS_MARGIN_PCT;

                const maxX = cfg.CANVAS_WIDTH - calculatedTotalWidth - marginX;
                const maxY = cfg.CANVAS_HEIGHT - marginY;
                const minX = marginX;
                const minY = marginY + fontSize;

                const randomX = Math.max(minX, Math.floor(Math.random() * (maxX - minX + 1)) + minX);
                const randomY = Math.max(minY, Math.floor(Math.random() * (maxY - minY + 1)) + minY);

                const randColor = () => `#${Math.floor(Math.random()*16777215).toString(16).padStart(2, '0')}`;
                const baseColor = randColor();
                const shadowColor = '#000000';

                // Internal text drawer helper function with manual spacing constraints
                const drawSpacedText = (targetCtx, fillStyleColor, xOffset, yOffset) => {
                    targetCtx.fillStyle = fillStyleColor;
                    let currentX = randomX + xOffset;
                    const targetY = randomY + yOffset;

                    for (let i = 0; i < txt.length; i++) {
                        const char = txt[i];
                        targetCtx.fillText(char, currentX, targetY);
                        currentX += targetCtx.measureText(char).width + cfg.LETTER_SPACING_PX;
                    }
                };

                const passes = [];

                // Layer 1: Background Drop Shadow
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                drawSpacedText(ctx, shadowColor, 3, 3);
                passes.push({ color: shadowColor, ctxData: ctx.getImageData(0, 0, canvas.width, canvas.height) });

                // Layer 2: Foreground Primary Fill Color
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                drawSpacedText(ctx, baseColor, 0, 0);
                passes.push({ color: baseColor, ctxData: ctx.getImageData(0, 0, canvas.width, canvas.height) });

                const localPayloads = [];
                const step = cfg.SCANLINE_STEP;

                for (const pass of passes) {
                    const data = pass.ctxData.data;

                    for (let x = 0; x < canvas.width; x += step) {
                        let inStroke = false;
                        let startY = 0;

                        for (let y = 0; y < canvas.height; y++) {
                            const idx = (y * canvas.width + x) * 4;
                            const alpha = data[idx + 3];

                            if (alpha > 60) { 
                                if (!inStroke) {
                                    inStroke = true;
                                    startY = y;
                                }
                            } else {
                                if (inStroke) {
                                    localPayloads.push({
                                        color: pass.color,
                                        points: [[x, startY], [x, y - 1]]
                                    });
                                    inStroke = false;
                                }
                            }
                        }
                        if (inStroke) {
                            localPayloads.push({
                                color: pass.color,
                                points: [[x, startY], [x, canvas.height - 1]]
                            });
                        }
                    }
                }
                return localPayloads;
            }, text, CONFIG);

            if (payloads && payloads.length > 0) {
                console.log(`[TRANSMIT] Transferring ${payloads.length} crisp vertical lines...`);
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
                const BATCH_SIZE = 10; 

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

                    const { color, points } = payloads[i];

                    socket.send(JSON.stringify({
                        a: ['drawLine', { colour: color, lines: points, thick: 4 }],
                    }));

                    if (ctx && points.length > 0) {
                        ctx.beginPath();
                        ctx.strokeStyle = color;
                        ctx.lineWidth    = 4;
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