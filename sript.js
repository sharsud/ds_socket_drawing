const puppeteer = require('puppeteer');
const { createCanvas, loadImage } = require('canvas');
const chokidar = require('chokidar');

// --- BALANCED CONFIGURATION ---
const RESOLUTION_WIDTH = 150; // Back up for better detail
const SIMPLIFICATION_EPSILON = .1; // Sweet spot for detail vs speed
const MAX_COLORS_PER_DRAWING = 12; // Fewer colors = more time for detail
const TIME_LIMIT_MS = 48500; 

const PALETTE = [
    { r: 0, g: 0, b: 0, hex: 'rgb(0,0,0)' },
    { r: 87, g: 87, b: 87, hex: 'rgb(87,87,87)' },
    { r: 160, g: 160, b: 160, hex: 'rgb(160,160,160)' },
    { r: 156, g: 39, b: 176, hex: 'rgb(156,39,176)' },
    { r: 157, g: 175, b: 255, hex: 'rgb(157,175,255)' },
    { r: 42, g: 75, b: 215, hex: 'rgb(42,75,215)' },
    { r: 41, g: 208, b: 208, hex: 'rgb(41,208,208)' },
    { r: 129, g: 197, b: 122, hex: 'rgb(129,197,122)' },
    { r: 76, g: 175, b: 80, hex: 'rgb(76,175,80)' },
    { r: 198, g: 255, b: 0, hex: 'rgb(198,255,0)' },
    { r: 255, g: 238, b: 51, hex: 'rgb(255,238,51)' },
    { r: 255, g: 146, b: 51, hex: 'rgb(255,146,51)' },
    { r: 233, g: 222, b: 187, hex: 'rgb(233,222,187)' },
    { r: 129, g: 74, b: 25, hex: 'rgb(129,74,25)' },
    { r: 248, g: 187, b: 208, hex: 'rgb(248,187,208)' },
    { r: 244, g: 67, b: 54, hex: 'rgb(244,67,54)' },
    { r: 173, g: 35, b: 35, hex: 'rgb(173,35,35)' },
    { r: 255, g: 255, b: 255, hex: 'rgb(255,255,255)' }
];

let isMouseDown = false;

async function safeUp(page) {
    if (isMouseDown) { await page.mouse.up(); isMouseDown = false; }
}

async function safeDown(page) {
    if (!isMouseDown) { await page.mouse.down(); isMouseDown = true; }
}

function getClosestColorIndex(r, g, b, allowedIndices = null) {
    let bestIdx = -1;
    let minDistance = Infinity;
    const targets = allowedIndices || [...Array(PALETTE.length).keys()];
    for (const i of targets) {
        const p = PALETTE[i];
        const dr = r - p.r, dg = g - p.g, db = b - p.b;
        const distance = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11; // Removed sqrt for speed
        if (distance < minDistance) { minDistance = distance; bestIdx = i; }
    }
    return bestIdx;
}

function simplifyPath(points, epsilon) {
    if (points.length <= 2) return points;
    let maxDist = 0, index = 0;
    const start = points[0], end = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
        const d = distToSegment(points[i], start, end);
        if (d > maxDist) { index = i; maxDist = d; }
    }
    return maxDist > epsilon ? 
        [...simplifyPath(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplifyPath(points.slice(index), epsilon)] : 
        [start, end];
}

function distToSegment(p, a, b) {
    const l2 = (a.x - b.x)**2 + (a.y - b.y)**2;
    if (l2 === 0) return Math.sqrt((p.x - a.x)**2 + (p.y - a.y)**2);
    let t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
    return Math.sqrt((p.x - (a.x + t * (b.x - a.x)))**2 + (p.y - (a.y + t * (b.y - a.y)))**2);
}

async function processImage(page, imgPath) {
    const startTime = Date.now();
    const img = await loadImage(imgPath);
    const width = RESOLUTION_WIDTH;
    const height = Math.floor(img.height * (width / img.width));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    const imgData = ctx.getImageData(0, 0, width, height).data;

    // Analysis
    const colorCounts = {};
    for (let i = 0; i < imgData.length; i += 16) { // Sampling for speed
        if (imgData[i+3] < 120) continue;
        const bestIdx = getClosestColorIndex(imgData[i], imgData[i+1], imgData[i+2]);
        if (bestIdx !== 17) colorCounts[bestIdx] = (colorCounts[bestIdx] || 0) + 1;
    }

    let activePalette = Object.entries(colorCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_COLORS_PER_DRAWING)
        .map(entry => parseInt(entry[0]));

    const cvs = await page.evaluate(() => {
        const b = document.querySelector('canvas.c1bn54pb').getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height };
    });

    const sx = cvs.w / width;
    const sy = cvs.h / height;
    // Darker colors last
    const drawOrder = activePalette.sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : 0));

    for (const cIdx of drawOrder) {
        if (Date.now() - startTime > TIME_LIMIT_MS) break;

        const visited = new Uint8Array(width * height);
        
        await safeUp(page);
        await page.evaluate(async (h) => {
            const btn = Array.from(document.querySelectorAll('button.ctcn4wa')).find(b => b.innerText.includes("Color"));
            if (btn) {
                btn.click();
                await new Promise(r => setTimeout(r, 150));
                const s = Array.from(document.querySelectorAll('div.c18ajoc7')).find(v => v.style.backgroundColor.replace(/\s/g, '') === h);
                if (s) s.click();
                btn.click();
            }
        }, PALETTE[cIdx].hex);

        for (let i = 0; i < width * height; i++) {
            if (Date.now() - startTime > TIME_LIMIT_MS) break;
            const idx = i * 4;
            if (imgData[idx+3] < 120 || visited[i]) continue;
            
            if (getClosestColorIndex(imgData[idx], imgData[idx+1], imgData[idx+2], [...activePalette, 17]) === cIdx) {
                let path = [];
                let curr = i;
                while (curr !== -1) {
                    visited[curr] = 1;
                    path.push({ x: curr % width, y: Math.floor(curr / width) });
                    let next = -1;
                    // Optimized 8-way neighbor search for better detail
                    const neighbors = [-1, 1, -width, width, -width-1, -width+1, width-1, width+1];
                    for (let n of neighbors) {
                        const t = curr + n;
                        if (t >= 0 && t < width * height && !visited[t]) {
                            const nIdx = t * 4;
                            if (getClosestColorIndex(imgData[nIdx], imgData[nIdx+1], imgData[nIdx+2], [...activePalette, 17]) === cIdx) {
                                next = t; break;
                            }
                        }
                    }
                    curr = next;
                }

                if (path.length > 1) {
                    const simplified = simplifyPath(path, SIMPLIFICATION_EPSILON);
                    await page.mouse.move(cvs.x + simplified[0].x * sx, cvs.y + simplified[0].y * sy);
                    await safeDown(page);
                    for (let j = 1; j < simplified.length; j++) {
                        // High-speed move
                        await page.mouse.move(cvs.x + simplified[j].x * sx, cvs.y + simplified[j].y * sy);
                    }
                    await safeUp(page);
                }
            }
        }
    }
    console.log(`⏱️ Finished in ${(Date.now() - startTime)/1000}s`);
}

(async () => {
    const browser = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--start-maximized'] });
    const [page] = await browser.pages();
    await page.goto('https://www.drawasaurus.org/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas.c1bn54pb');
    chokidar.watch('./images', { ignoreInitial: true }).on('add', (path) => processImage(page, path));
})();