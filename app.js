// MDF V-Frees Generator
// Pipeline: 2D depth canvas (V-bit profile gradients) → per-cell PlaneGeometry
// vertex displacement → MeshPhysicalMaterial + RoomEnvironment.

// === Globals ===
let scene, camera, renderer;
let depthCanvas, depthCtx;
let cellMeshes = [];
let adjustedValues = {};
let isMouseDown = false, mouseX = 0, mouseY = 0;
let targetRotationX = 0, targetRotationY = 0;
let cameraDistance = 800;

// === Constants ===
const RAL_PALETTE = [
    { code: 'RAL 9010', name: 'Zuiver wit',     hex: '#F1ECE0' },
    { code: 'RAL 9016', name: 'Verkeerswit',    hex: '#F1F0EA' },
    { code: 'RAL 9001', name: 'Cremewit',       hex: '#EAE0CC' },
    { code: 'RAL 1013', name: 'Parelwit',       hex: '#E3D9C6' },
    { code: 'RAL 1015', name: 'Lichtivoor',     hex: '#E1CC9A' },
    { code: 'RAL 7035', name: 'Lichtgrijs',     hex: '#CBD0CC' },
    { code: 'RAL 7044', name: 'Zijdegrijs',     hex: '#B9B4A1' },
    { code: 'RAL 7016', name: 'Antracietgrijs', hex: '#293133' },
    { code: 'RAL 9005', name: 'Gitzwart',       hex: '#0A0A0A' },
    { code: 'RAL 5014', name: 'Duifblauw',      hex: '#637D96' },
    { code: 'RAL 5011', name: 'Staalblauw',     hex: '#1A2B3C' },
    { code: 'RAL 6021', name: 'Bleekgroen',     hex: '#89AC76' },
    { code: 'RAL 6005', name: 'Mosgroen',       hex: '#2F4538' },
    { code: 'RAL 3009', name: 'Oxiderood',      hex: '#6D3F33' },
    { code: 'RAL 8017', name: 'Chocoladebruin', hex: '#45322E' },
];

const DENSITY_PER_AREA = { 1: 0.25, 2: 0.7, 3: 1.8, 4: 4, 5: 9 }; // strokes per 100x100mm
const SCALE_FREQ = { macro: 0.003, medium: 0.008, micro: 0.02 };

// Grayscale 255 ↔ this many mm of physical depth. Recomputed per render based
// on the user's max depth setting so the peak stroke uses the full grayscale
// range (best resolution for the V-profile gradient).
let maxDepthMm = 6;
const CANVAS_RES = 1000;      // long side of depth canvas in pixels
// Front-face vertex grid: target 1 vertex per mm so it matches the depth-canvas
// resolution. Cap prevents huge cells (>1m) from blowing up the buffer.
const PLANE_SEG_PER_MM = 1;
const PLANE_SEG_CAP = 1000;

// === Seeded PRNG (mulberry32) ===
function hashToSeed(hash) {
    const h = (hash || '').replace(/^0x/, '');
    let s = 0;
    for (let i = 0; i < h.length; i++) {
        s = (s * 16 + (parseInt(h[i], 16) || 0)) | 0;
    }
    return Math.abs(s) || 1;
}

function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function regenerateHash() {
    const chars = '0123456789abcdef';
    let h = '0x';
    for (let i = 0; i < 16; i++) h += chars[Math.floor(Math.random() * 16)];
    document.getElementById('hash').value = h;
    updatePanel();
}

// === V-bit profile ===
function vBitMaxDepthRatio(bit) {
    if (bit === '30-deg') return Math.tan(30 * Math.PI / 180) / 2; // ≈0.2887
    return 0.5; // 45-deg
}
function vBitProfile(bit) {
    const max = vBitMaxDepthRatio(bit);
    return (t) => Math.min(t, 1 - t) * 2 * max; // depth ratio at normalized cross-section position t∈[0,1]
}

// === RAL ===
function populateRALSelect() {
    const sel = document.getElementById('ralCode');
    if (!sel || sel.options.length > 0) return;
    RAL_PALETTE.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.code;
        opt.textContent = `${c.code} — ${c.name}`;
        if (c.code === 'RAL 7035') opt.selected = true;
        sel.appendChild(opt);
    });
}
function getRALHex(code) {
    const f = RAL_PALETTE.find((c) => c.code === code);
    return f ? f.hex : '#cccccc';
}

// === Init ===
function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeeeeee);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 6000);
    camera.position.set(0, 0, cameraDistance);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    document.getElementById('scene-container').appendChild(renderer.domElement);

    // Environment for PBR reflections
    if (typeof THREE.RoomEnvironment === 'function') {
        const pmrem = new THREE.PMREMGenerator(renderer);
        pmrem.compileEquirectangularShader();
        scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
    }

    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(-300, 400, 500); // upper-left, ~45° down-right
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.25);
    fill.position.set(300, -200, 200);
    scene.add(fill);

    depthCanvas = document.createElement('canvas');
    depthCtx = depthCanvas.getContext('2d');

    populateRALSelect();
    updateColumnInputs();
    createPanel();

    renderer.domElement.addEventListener('mousedown', onMouseDown, false);
    renderer.domElement.addEventListener('mousemove', onMouseMove, false);
    renderer.domElement.addEventListener('mouseup', onMouseUp, false);
    renderer.domElement.addEventListener('wheel', onMouseWheel, false);
    window.addEventListener('resize', onWindowResize, false);

    animate();
}

// Returns true if a panel-coord point is inside the carving region (panel
// minus frame margins). Optional halfW shrinks the boundary so the round
// stroke cap with that half-width still fits entirely inside the frame —
// this is what mirrors a real V-bit lifting before reaching the rim.
function inFrameRegion(x, y, panelW, panelH, frame, halfW) {
    const m = halfW || 0;
    const left = -panelW / 2 + (frame.left || 0) + m;
    const right = panelW / 2 - (frame.right || 0) - m;
    const bottom = -panelH / 2 + (frame.bottom || 0) + m;
    const top = panelH / 2 - (frame.top || 0) - m;
    if (left > right || bottom > top) return false;
    return x >= left && x <= right && y >= bottom && y <= top;
}

// === Stroke generation ===
function generateStrokes(panelW, panelH, params, rng) {
    const {
        minDepthMm, maxDepthMm: maxD, maxRatio, varyAlongStroke,
        densityPerArea, placement, pattern, strokeLength, scaleFreq, layers, frame,
    } = params;
    // Width is derived from depth per V-bit physics: depth = w * tan(angle)/2 = w * maxRatio
    // → w = depth / maxRatio
    const avgDepth = (minDepthMm + maxD) / 2;
    const avgWidthMm = avgDepth / Math.max(0.001, maxRatio);

    const area = (panelW * panelH) / 10000; // in 100x100mm units
    const strokesPerLayer = Math.max(2, Math.round(densityPerArea * area));
    const strokeStepMm = Math.max(0.5, avgWidthMm * 0.5);
    const strokeMaxLength = Math.min(panelW, panelH) * 0.8;

    const simplexInst = new SimplexNoise(rng);
    // Independent noise instance for along-stroke depth modulation, so the
    // depth pattern is decorrelated from the flow direction.
    const depthSimplex = new SimplexNoise(() => rng());

    const lengthMul = strokeLength === 'short' ? 0.45 :
                      strokeLength === 'long' ? 3.5 : 1.0;
    const traceBoth = strokeLength === 'long';

    // Use the maximum possible half-width as the frame margin so the round
    // line cap of even the deepest stroke stays inside the frame.
    const frameMargin = (maxD / Math.max(0.001, maxRatio)) / 2;

    const strokes = [];
    for (let layer = 0; layer < layers; layer++) {
        for (let i = 0; i < strokesPerLayer; i++) {
            // Retry seed if it lands outside the frame region; gives up after
            // a few attempts to avoid infinite loops with a thick frame.
            let seedPt = null;
            for (let attempt = 0; attempt < 6; attempt++) {
                const candidate = pickSeedPoint(placement, panelW, panelH, i, strokesPerLayer, densityPerArea, rng);
                if (inFrameRegion(candidate.x, candidate.y, panelW, panelH, frame, frameMargin)) {
                    seedPt = candidate;
                    break;
                }
            }
            if (!seedPt) continue;
            const lengthFactor = strokeLengthFactor(placement) * lengthMul;
            const maxSteps = Math.floor((strokeMaxLength * lengthFactor) / strokeStepMm);
            const stepCount = Math.max(6, Math.floor(maxSteps * (0.5 + rng() * 0.5)));

            // Per-stroke base depth: random in [min, max]. Used directly when not
            // varying along the stroke; otherwise serves as the noise's mean.
            const baseDepth = minDepthMm + rng() * (maxD - minDepthMm);
            // Seed offset to decorrelate per-stroke noise patterns
            const depthSeed = rng() * 1000;
            const depthFreq = 0.04; // along-stroke wavelength in mm⁻¹

            const points = [];
            let accumDist = 0;
            const lastPt = { x: 0, y: 0, set: false };

            const computeWidth = (x, y) => {
                let depth;
                if (varyAlongStroke) {
                    if (lastPt.set) accumDist += Math.hypot(x - lastPt.x, y - lastPt.y);
                    lastPt.x = x; lastPt.y = y; lastPt.set = true;
                    const n = depthSimplex.noise2D(accumDist * depthFreq, depthSeed);
                    const t = (n + 1) * 0.5; // 0..1
                    depth = minDepthMm + t * (maxD - minDepthMm);
                } else {
                    depth = baseDepth;
                }
                return { depth, w: depth / Math.max(0.001, maxRatio) };
            };

            // Forward trace — terminate when leaving frame region (with the
            // current point's half-width as margin so the round cap fits).
            let fx = seedPt.x, fy = seedPt.y;
            for (let s = 0; s < stepCount; s++) {
                if (!inPlacementRegion(placement, fx, fy, panelW, panelH)) break;
                const cw = computeWidth(fx, fy);
                if (!inFrameRegion(fx, fy, panelW, panelH, frame, cw.w / 2)) break;
                points.push({ x: fx, y: fy, w: cw.w, depth: cw.depth });
                const ang = patternFlowAngle(pattern, fx, fy, simplexInst, scaleFreq, panelW, panelH);
                fx += Math.cos(ang) * strokeStepMm;
                fy += Math.sin(ang) * strokeStepMm;
            }

            // Backward trace from seed (only when "long")
            if (traceBoth) {
                const backward = [];
                let bx = seedPt.x, by = seedPt.y;
                // Reset the along-distance walker for backward chain — it
                // continues from the seed outward, just like forward did.
                lastPt.set = false;
                let backAccum = 0;
                for (let s = 0; s < stepCount; s++) {
                    const ang = patternFlowAngle(pattern, bx, by, simplexInst, scaleFreq, panelW, panelH);
                    bx -= Math.cos(ang) * strokeStepMm;
                    by -= Math.sin(ang) * strokeStepMm;
                    if (!inPlacementRegion(placement, bx, by, panelW, panelH)) break;
                    let depth;
                    if (varyAlongStroke) {
                        backAccum += strokeStepMm;
                        const n = depthSimplex.noise2D(-backAccum * depthFreq, depthSeed);
                        const t = (n + 1) * 0.5;
                        depth = minDepthMm + t * (maxD - minDepthMm);
                    } else {
                        depth = baseDepth;
                    }
                    const wm = depth / Math.max(0.001, maxRatio);
                    if (!inFrameRegion(bx, by, panelW, panelH, frame, wm / 2)) break;
                    backward.push({ x: bx, y: by, w: wm, depth });
                }
                if (backward.length > 0) {
                    backward.reverse();
                    points.unshift(...backward);
                }
            }

            if (points.length >= 2) {
                points.uniform = !varyAlongStroke;
                strokes.push(points);
            }
        }
    }
    return strokes;
}

// Pattern controls the FLOW direction of strokes — independent of placement.
// Placement decides where strokes start and which regions they're allowed in;
// pattern decides which way they travel from there.
function patternFlowAngle(pattern, x, y, simplexInst, scaleFreq, panelW, panelH) {
    const n = simplexInst.noise2D(x * scaleFreq, y * scaleFreq);
    switch (pattern) {
        case 'horizontal':
            return n * 0.18; // ±~10° wobble around horizontal
        case 'vertical':
            return Math.PI / 2 + n * 0.18;
        case 'diagonal':
            return Math.PI / 4 + n * 0.18;
        case 'wavy': {
            // Sine wave running along x; angle oscillates around horizontal.
            const wave = Math.sin(x * scaleFreq * 6) * 0.7;
            return wave + n * 0.12;
        }
        case 'concentric': {
            // Tangent to the radius vector → strokes form rings around panel centre.
            return Math.atan2(y, x) + Math.PI / 2 + n * 0.08;
        }
        case 'radial': {
            // Along the radius vector → strokes emanate from / into the centre.
            return Math.atan2(y, x) + n * 0.08;
        }
        case 'spiral': {
            // Tangent with a slight inward bias so strokes spiral.
            return Math.atan2(y, x) + Math.PI / 2 - 0.35 + n * 0.08;
        }
        case 'cross-axis': {
            // Horizontal in horizontal cross-arm, vertical in vertical arm.
            const inH = Math.abs(y) < panelH * 0.22;
            const inV = Math.abs(x) < panelW * 0.22;
            if (inH && !inV) return n * 0.4;
            if (inV && !inH) return Math.PI / 2 + n * 0.4;
            return n * Math.PI * 2;
        }
        case 'flow':
        default:
            return n * Math.PI * 2;
    }
}

// Region containment per placement. Cross/square/diamonds confine strokes so
// out-of-region areas stay clean MDF.
function inPlacementRegion(placement, x, y, W, H) {
    switch (placement) {
        case 'cross': {
            const inH = Math.abs(y) < H * 0.25;
            const inV = Math.abs(x) < W * 0.25;
            return inH || inV;
        }
        case 'square': {
            // Four square clusters with empty gutters between them
            const ax = Math.abs(x), ay = Math.abs(y);
            return ax > W * 0.06 && ax < W * 0.46 && ay > H * 0.06 && ay < H * 0.46;
        }
        case 'diamonds': {
            const centers = [
                [0, 0],
                [W * 0.32, H * 0.32],
                [-W * 0.32, H * 0.32],
                [W * 0.32, -H * 0.32],
                [-W * 0.32, -H * 0.32],
            ];
            const r = Math.min(W, H) * 0.18;
            for (let k = 0; k < centers.length; k++) {
                const dx = x - centers[k][0];
                const dy = y - centers[k][1];
                if (Math.abs(dx) / r + Math.abs(dy) / r < 1) return true;
            }
            return false;
        }
        default:
            return true;
    }
}

function strokeLengthFactor(placement) {
    switch (placement) {
        case 'grid':    return 0.45;
        case 'rows':    return 0.55;
        case 'columns': return 0.55;
        case 'square':  return 0.55;
        case 'diamonds': return 0.55;
        case 'cross':   return 0.75;
        default:        return 1.0; // chaos
    }
}

function pickSeedPoint(placement, W, H, i, total, density, rng) {
    switch (placement) {
        case 'grid': {
            const cols = Math.max(2, Math.ceil(Math.sqrt(total * (W / H))));
            const rows = Math.max(2, Math.ceil(total / cols));
            const ci = i % cols;
            const ri = Math.floor(i / cols) % rows;
            const sx = -W / 2 + (ci + 0.5) * W / cols + (rng() - 0.5) * (W / cols) * 0.25;
            const sy = -H / 2 + (ri + 0.5) * H / rows + (rng() - 0.5) * (H / rows) * 0.25;
            return { x: sx, y: sy };
        }
        case 'rows': {
            const numRows = Math.max(4, Math.round(density * H / 50));
            const ri = i % numRows;
            const rowH = H / numRows;
            const sy = -H / 2 + (ri + 0.5) * rowH + (rng() - 0.5) * rowH * 0.3;
            return { x: -W / 2 + rng() * W, y: sy };
        }
        case 'columns': {
            const numCols = Math.max(4, Math.round(density * W / 50));
            const ci = i % numCols;
            const colW = W / numCols;
            const sx = -W / 2 + (ci + 0.5) * colW + (rng() - 0.5) * colW * 0.3;
            return { x: sx, y: -H / 2 + rng() * H };
        }
        case 'cross': {
            // 50/50 between horizontal arm and vertical arm
            if (rng() < 0.5) {
                return { x: -W / 2 + rng() * W, y: (rng() - 0.5) * H * 0.4 };
            }
            return { x: (rng() - 0.5) * W * 0.4, y: -H / 2 + rng() * H };
        }
        case 'square': {
            // Pick one of 4 quadrant clusters
            const block = Math.floor(rng() * 4);
            const sx = (block % 2 === 0 ? -1 : 1) * W * 0.26;
            const sy = (block < 2 ? -1 : 1) * H * 0.26;
            return { x: sx + (rng() - 0.5) * W * 0.32, y: sy + (rng() - 0.5) * H * 0.32 };
        }
        case 'diamonds': {
            const centers = [
                [0, 0],
                [W * 0.32, H * 0.32],
                [-W * 0.32, H * 0.32],
                [W * 0.32, -H * 0.32],
                [-W * 0.32, -H * 0.32],
            ];
            const ci = Math.floor(rng() * centers.length);
            const [cx, cy] = centers[ci];
            const r = Math.min(W, H) * 0.18;
            // Rejection-sample inside the diamond |dx/r|+|dy/r| < 1
            for (let attempt = 0; attempt < 8; attempt++) {
                const dx = (rng() - 0.5) * 2 * r;
                const dy = (rng() - 0.5) * 2 * r;
                if (Math.abs(dx) / r + Math.abs(dy) / r < 1) return { x: cx + dx, y: cy + dy };
            }
            return { x: cx, y: cy };
        }
        case 'chaos':
        default:
            return { x: -W / 2 + rng() * W, y: -H / 2 + rng() * H };
    }
}

// === Depth canvas rendering ===
// Each stroke is rasterised as PROFILE_LAYERS stacked polyline passes, going
// from full-width-darkest to centerline-brightest. lineCap/lineJoin = 'round'
// keeps the polyline smooth across direction changes — no per-segment seams.
// 'lighten' composite ensures the deepest value wins both within a stroke
// (concentric passes) and between overlapping strokes. A final small blur
// smooths the discrete brightness steps so the groove becomes one continuous V.
const PROFILE_LAYERS = 48;
const FINAL_BLUR_PX = 0.9;

function renderDepthCanvas(panelW, panelH, strokes, bit, frame) {
    const long = Math.max(panelW, panelH);
    const cw = Math.round(CANVAS_RES * (panelW / long));
    const ch = Math.round(CANVAS_RES * (panelH / long));
    depthCanvas.width = cw;
    depthCanvas.height = ch;
    const ctx = depthCtx;

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalCompositeOperation = 'lighten';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const maxRatio = vBitMaxDepthRatio(bit);
    const mmToPx = cw / panelW;

    const px = (mx) => (mx + panelW / 2) * mmToPx;
    const py = (my) => ch - (my + panelH / 2) * (ch / panelH);

    for (const stroke of strokes) {
        if (!stroke || stroke.length < 2) continue;

        if (stroke.uniform) {
            // Fast path: one polyline per layer, single lineWidth.
            const strokeWmm = stroke[0].w;
            if (strokeWmm < 0.05) continue;
            const peakDepthMm = strokeWmm * maxRatio;
            const peakG = Math.min(255, Math.round((peakDepthMm / maxDepthMm) * 255));
            if (peakG < 1) continue;

            ctx.beginPath();
            ctx.moveTo(px(stroke[0].x), py(stroke[0].y));
            for (let i = 1; i < stroke.length; i++) {
                ctx.lineTo(px(stroke[i].x), py(stroke[i].y));
            }
            for (let k = 1; k <= PROFILE_LAYERS; k++) {
                const widthFrac = 1 - (k - 1) / PROFILE_LAYERS;
                const widthMm = strokeWmm * widthFrac;
                if (widthMm < 0.04) break;
                const gray = Math.round(peakG * (2 * k - 1) / (2 * PROFILE_LAYERS));
                if (gray < 1) continue;
                ctx.strokeStyle = `rgb(${gray},${gray},${gray})`;
                ctx.lineWidth = Math.max(0.5, widthMm * mmToPx);
                ctx.stroke();
            }
        } else {
            // Variable width along stroke: per-segment passes. Round caps on
            // every segment overlap their neighbours so width transitions are
            // smooth and seam-free.
            for (let i = 0; i < stroke.length - 1; i++) {
                const a = stroke[i];
                const b = stroke[i + 1];
                const segW = (a.w + b.w) / 2;
                if (segW < 0.05) continue;
                const peakDepthMm = segW * maxRatio;
                const peakG = Math.min(255, Math.round((peakDepthMm / maxDepthMm) * 255));
                if (peakG < 1) continue;

                ctx.beginPath();
                ctx.moveTo(px(a.x), py(a.y));
                ctx.lineTo(px(b.x), py(b.y));
                for (let k = 1; k <= PROFILE_LAYERS; k++) {
                    const widthFrac = 1 - (k - 1) / PROFILE_LAYERS;
                    const widthMm = segW * widthFrac;
                    if (widthMm < 0.04) break;
                    const gray = Math.round(peakG * (2 * k - 1) / (2 * PROFILE_LAYERS));
                    if (gray < 1) continue;
                    ctx.strokeStyle = `rgb(${gray},${gray},${gray})`;
                    ctx.lineWidth = Math.max(0.5, widthMm * mmToPx);
                    ctx.stroke();
                }
            }
        }
    }

    // Smooth the discrete brightness steps: blur into a temp canvas, copy back.
    if (FINAL_BLUR_PX > 0) {
        const tmp = document.createElement('canvas');
        tmp.width = cw;
        tmp.height = ch;
        const tctx = tmp.getContext('2d');
        tctx.filter = `blur(${FINAL_BLUR_PX}px)`;
        tctx.drawImage(depthCanvas, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, cw, ch);
        ctx.drawImage(tmp, 0, 0);
    }

    // Frame is enforced during stroke tracing now (strokes terminate inside
    // the frame margin so their round caps stay within the rim), so no
    // post-render mask is needed here.

    ctx.globalCompositeOperation = 'source-over';
}

// === Sample depth canvas at a panel coordinate ===
function sampleDepth(imageData, cw, ch, panelW, panelH, panelX, panelY) {
    const px = Math.floor((panelX + panelW / 2) / panelW * cw);
    const py = Math.floor(ch - (panelY + panelH / 2) / panelH * ch);
    if (px < 0 || px >= cw || py < 0 || py >= ch) return 0;
    const idx = (py * cw + px) * 4;
    return (imageData[idx] / 255) * maxDepthMm;
}

// === createPanel: full pipeline ===
function createPanel() {
    const t0 = performance.now();
    clearScene();
    updateColumnInputs();

    const panelW = parseFloat(document.getElementById('width').value);
    const panelH = parseFloat(document.getElementById('height').value);
    const panelThickness = Math.max(1, parseFloat(document.getElementById('panelThickness').value) || 18);
    const columns = parseInt(document.getElementById('columns').value);
    const spacing = parseFloat(document.getElementById('spacing').value);
    const spacingHorizontal = parseFloat(document.getElementById('spacingHorizontal').value);

    const ralCode = document.getElementById('ralCode').value;
    const ralHex = getRALHex(ralCode);
    const bit = document.getElementById('bit').value;
    const placement = document.getElementById('placement').value;
    const patternEl = document.getElementById('pattern');
    const pattern = patternEl ? patternEl.value : 'flow';
    const strokeLengthEl = document.getElementById('strokeLength');
    const strokeLength = strokeLengthEl ? strokeLengthEl.value : 'normal';
    const minDepth = Math.max(0.5, parseFloat(document.getElementById('minDepth').value) || 4);
    const maxDepth = Math.max(minDepth, parseFloat(document.getElementById('maxDepth').value) || 6);
    const varyAlongStroke = !!document.getElementById('varyAlongStroke').checked;
    const densityLevel = parseInt(document.getElementById('density').value);
    const scaleKey = document.getElementById('patternScale').value;
    const layers = parseInt(document.getElementById('layers').value);
    const frame = {
        top:    Math.max(0, parseFloat(document.getElementById('frameTop').value)    || 0),
        right:  Math.max(0, parseFloat(document.getElementById('frameRight').value)  || 0),
        bottom: Math.max(0, parseFloat(document.getElementById('frameBottom').value) || 0),
        left:   Math.max(0, parseFloat(document.getElementById('frameLeft').value)   || 0),
    };
    const hash = document.getElementById('hash').value;

    const densityPerArea = DENSITY_PER_AREA[densityLevel];
    const scaleFreq = SCALE_FREQ[scaleKey];
    const maxRatio = vBitMaxDepthRatio(bit);
    // Map grayscale 255 to the user's max depth so the V-profile gradient uses
    // the full grayscale range — best resolution per stroke.
    maxDepthMm = Math.max(maxDepth, 1);

    const seed = hashToSeed(hash);
    const rng = mulberry32(seed);

    const strokes = generateStrokes(panelW, panelH, {
        minDepthMm: minDepth, maxDepthMm: maxDepth, maxRatio, varyAlongStroke,
        densityPerArea, placement, pattern, strokeLength, scaleFreq, layers, frame,
    }, rng);

    renderDepthCanvas(panelW, panelH, strokes, bit, null);
    const cw = depthCanvas.width;
    const ch = depthCanvas.height;
    const imageData = depthCtx.getImageData(0, 0, cw, ch).data;

    // Per-cell column widths
    let totalSpecifiedWidth = 0;
    const columnWidths = [];
    for (let i = 0; i < columns - 1; i++) {
        const colWidth = adjustedValues[`colWidth${i + 1}`] || (panelW - (columns - 1) * spacing) / columns;
        columnWidths.push(colWidth);
        totalSpecifiedWidth += colWidth;
        const el = document.getElementById(`colWidth${i + 1}`);
        if (el) el.value = colWidth;
    }
    const lastColumnWidth = panelW - totalSpecifiedWidth - (columns - 1) * spacing;
    columnWidths.push(lastColumnWidth);
    const lastColEl = document.getElementById(`colWidth${columns}`);
    if (lastColEl) { lastColEl.value = lastColumnWidth; lastColEl.disabled = true; }

    let xOffset = -panelW / 2 + columnWidths[0] / 2;
    for (let i = 0; i < columns; i++) {
        const rowsEl = document.getElementById(`rows${i + 1}`);
        const rows = rowsEl ? parseInt(rowsEl.value) : (adjustedValues[`rows${i + 1}`] || 1);
        let totalSpecifiedHeight = 0;
        const rowHeights = [];
        for (let j = 0; j < rows - 1; j++) {
            const rowHeight = adjustedValues[`rowHeight${i + 1}_${j + 1}`] || (panelH - (rows - 1) * spacingHorizontal) / rows;
            rowHeights.push(rowHeight);
            totalSpecifiedHeight += rowHeight;
            const rhEl = document.getElementById(`rowHeight${i + 1}_${j + 1}`);
            if (rhEl) rhEl.value = rowHeight;
        }
        const lastRowHeight = panelH - totalSpecifiedHeight - (rows - 1) * spacingHorizontal;
        rowHeights.push(lastRowHeight);
        const lastRhEl = document.getElementById(`rowHeight${i + 1}_${rows}`);
        if (lastRhEl) { lastRhEl.value = lastRowHeight; lastRhEl.disabled = true; }

        let yOffset = -panelH / 2 + rowHeights[0] / 2;
        for (let j = 0; j < rows; j++) {
            const cellW = columnWidths[i];
            const cellH = rowHeights[j];
            const wSegs = Math.min(PLANE_SEG_CAP, Math.max(20, Math.ceil(cellW * PLANE_SEG_PER_MM)));
            const hSegs = Math.min(PLANE_SEG_CAP, Math.max(20, Math.ceil(cellH * PLANE_SEG_PER_MM)));
            // BoxGeometry gives the panel real thickness (front + back + 4 sides).
            // depthSegments=1 keeps side-wall vertex count low.
            const geometry = new THREE.BoxGeometry(cellW, cellH, panelThickness, wSegs, hSegs, 1);
            const positions = geometry.attributes.position;
            const halfT = panelThickness / 2;

            for (let v = 0; v < positions.count; v++) {
                const vz = positions.getZ(v);
                // Only the front face vertices (z ≈ +T/2) get displaced. Back face,
                // edges and side walls keep their original z so the panel keeps a
                // proper MDF-block silhouette.
                if (Math.abs(vz - halfT) < 0.01) {
                    const vx = positions.getX(v);
                    const vy = positions.getY(v);
                    const px = xOffset + vx;
                    const py = yOffset + vy;
                    const depth = sampleDepth(imageData, cw, ch, panelW, panelH, px, py);
                    positions.setZ(v, halfT - depth);
                }
            }
            positions.needsUpdate = true;
            geometry.computeVertexNormals();

            const isDark = isHexDark(ralHex);
            const material = new THREE.MeshPhysicalMaterial({
                color: ralHex,
                roughness: 0.35,
                metalness: 0.0,
                clearcoat: isDark ? 0.55 : 0.4,
                clearcoatRoughness: 0.3,
                reflectivity: 0.4,
                side: THREE.FrontSide,
            });
            // Side walls get a slightly rougher version so the cut edge of MDF
            // reads as un-finished compared to the silk-gloss faces.
            // (kept simple: same material on all faces for v1)
            const mesh = new THREE.Mesh(geometry, material);
            mesh.position.set(xOffset, yOffset, 0);
            scene.add(mesh);
            cellMeshes.push(mesh);

            yOffset += rowHeights[j] / 2 + (j < rows - 1 ? rowHeights[j + 1] / 2 : 0) + spacingHorizontal;
        }
        xOffset += columnWidths[i] / 2 + (i < columns - 1 ? columnWidths[i + 1] / 2 : 0) + spacing;
    }

    fitPanelToView();

    const t1 = performance.now();
    const rt = document.getElementById('renderTime');
    if (rt) {
        rt.textContent = `Render: ${((t1 - t0) / 1000).toFixed(2)}s — ${strokes.length} strokes, depth canvas ${cw}×${ch}`;
    }
}

function isHexDark(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substr(0, 2), 16);
    const g = parseInt(h.substr(2, 2), 16);
    const b = parseInt(h.substr(4, 2), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 100;
}

// === Column / row dynamic inputs ===
function updateColumnInputs() {
    const columns = parseInt(document.getElementById('columns').value);
    const totalWidth = parseFloat(document.getElementById('width').value);
    const spacing = parseFloat(document.getElementById('spacing').value);

    const columnSectionsDiv = document.getElementById('column-sections');
    columnSectionsDiv.innerHTML = '';
    let totalSpecifiedWidth = 0;

    for (let i = 0; i < columns; i++) {
        const columnSection = document.createElement('div');
        columnSection.className = 'column-section';
        let colWidth;
        if (i < columns - 1) {
            colWidth = adjustedValues[`colWidth${i + 1}`] || ((totalWidth - (columns - 1) * spacing) / columns);
            totalSpecifiedWidth += colWidth;
        } else {
            colWidth = totalWidth - totalSpecifiedWidth - (columns - 1) * spacing;
        }
        const rowsValue = adjustedValues[`rows${i + 1}`] || 1;

        columnSection.innerHTML = `
            <label>Col ${i + 1} width: <input type="number" id="colWidth${i + 1}" value="${colWidth}" ${i === columns - 1 ? 'disabled' : ''} min="10" max="10000" onchange="onInputChange('colWidth${i + 1}')" onkeypress="checkEnterKey(event)"></label>
            <label>Rows in col ${i + 1}: <input type="number" id="rows${i + 1}" value="${rowsValue}" min="1" max="10" onchange="onRowsChange(${i + 1})" onkeypress="checkEnterKey(event)"></label>
            <div id="row-sections${i + 1}" class="row-section"></div>
        `;
        columnSectionsDiv.appendChild(columnSection);
        updateRowInputs(i + 1);
    }
}

function updateRowInputs(columnIndex) {
    const rows = parseInt(document.getElementById(`rows${columnIndex}`).value);
    const totalHeight = parseFloat(document.getElementById('height').value);
    const spacingHorizontal = parseFloat(document.getElementById('spacingHorizontal').value);

    const rowSectionsDiv = document.getElementById(`row-sections${columnIndex}`);
    rowSectionsDiv.innerHTML = '';
    let totalSpecifiedHeight = 0;

    for (let i = 0; i < rows; i++) {
        let rowHeight;
        if (i < rows - 1) {
            rowHeight = adjustedValues[`rowHeight${columnIndex}_${i + 1}`] || ((totalHeight - (rows - 1) * spacingHorizontal) / rows);
            totalSpecifiedHeight += rowHeight;
        } else {
            rowHeight = totalHeight - totalSpecifiedHeight - (rows - 1) * spacingHorizontal;
        }
        const rowLabel = document.createElement('label');
        rowLabel.innerHTML = `Row ${i + 1} height: <input type="number" id="rowHeight${columnIndex}_${i + 1}" value="${rowHeight}" ${i === rows - 1 ? 'disabled' : ''} min="10" max="10000" onchange="onInputChange('rowHeight${columnIndex}_${i + 1}')" onkeypress="checkEnterKey(event)"><br>`;
        rowSectionsDiv.appendChild(rowLabel);
    }
}

function onRowsChange(columnIndex) {
    adjustedValues[`rows${columnIndex}`] = parseInt(document.getElementById(`rows${columnIndex}`).value);
    updateRowInputs(columnIndex);
    updatePanel();
}

function checkEnterKey(event) {
    if (event.keyCode === 13) updatePanel();
}

function onInputChange(inputId) {
    adjustedValues[inputId] = parseFloat(document.getElementById(inputId).value);
    updatePanel();
}

// === Camera fit / mouse / animate ===
function fitPanelToView() {
    const panelW = parseFloat(document.getElementById('width').value);
    const panelH = parseFloat(document.getElementById('height').value);
    const aspect = window.innerWidth / window.innerHeight;
    const panelAspect = panelW / panelH;
    const fovTanHalf = Math.tan((camera.fov * Math.PI / 180) / 2);
    let fitDistance;
    if (panelAspect > aspect) {
        fitDistance = (panelW / aspect) / (2 * fovTanHalf);
    } else {
        fitDistance = panelH / (2 * fovTanHalf);
    }
    cameraDistance = fitDistance * 1.15;
    camera.position.set(0, 0, cameraDistance);
    camera.lookAt(0, 0, 0);
    targetRotationX = 0;
    targetRotationY = 0;
    scene.rotation.x = 0;
    scene.rotation.y = 0;
}

function resetView() { fitPanelToView(); }

function clearScene() {
    if (!scene) return;
    cellMeshes.forEach((m) => {
        scene.remove(m);
        if (m.geometry) m.geometry.dispose();
        if (m.material) m.material.dispose();
    });
    cellMeshes = [];
}

function onMouseDown(e) { isMouseDown = true; mouseX = e.clientX; mouseY = e.clientY; }
function onMouseUp() { isMouseDown = false; }
function onMouseMove(e) {
    if (!isMouseDown) return;
    const dx = e.clientX - mouseX;
    const dy = e.clientY - mouseY;
    targetRotationY += dx * 0.005;
    targetRotationX += dy * 0.005;
    targetRotationX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, targetRotationX));
    mouseX = e.clientX;
    mouseY = e.clientY;
}
function onMouseWheel(e) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.08 : 0.92;
    cameraDistance = Math.max(100, Math.min(6000, cameraDistance * factor));
    camera.position.z = cameraDistance;
}
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    scene.rotation.x += (targetRotationX - scene.rotation.x) * 0.1;
    scene.rotation.y += (targetRotationY - scene.rotation.y) * 0.1;
    renderer.render(scene, camera);
}

function updatePanel() { createPanel(); }

// === Export PNG ===
function exportPNG() {
    renderer.render(scene, camera);
    const data = renderer.domElement.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = data;
    link.download = 'panel.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// === OBJ export (kept from previous) ===
class OBJExporter {
    parse(object) {
        let output = '';
        let indexVertex = 0, indexVertexUvs = 0, indexNormals = 0;
        const vertex = new THREE.Vector3();
        const normal = new THREE.Vector3();
        const uv = new THREE.Vector2();
        const parseMesh = (mesh) => {
            let geometry = mesh.geometry;
            if (!(geometry instanceof THREE.BufferGeometry)) return;
            if (geometry.index !== null) geometry = geometry.toNonIndexed();
            const positions = geometry.attributes.position;
            const normals = geometry.attributes.normal;
            const uvs = geometry.attributes.uv;
            if (!positions) return;
            for (let i = 0; i < positions.count; i++) {
                vertex.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
                output += `v ${vertex.x} ${vertex.y} ${vertex.z}\n`;
            }
            if (normals) {
                const m = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
                for (let i = 0; i < normals.count; i++) {
                    normal.fromBufferAttribute(normals, i).applyMatrix3(m);
                    output += `vn ${normal.x} ${normal.y} ${normal.z}\n`;
                }
            }
            if (uvs) {
                for (let i = 0; i < uvs.count; i++) {
                    uv.fromBufferAttribute(uvs, i);
                    output += `vt ${uv.x} ${uv.y}\n`;
                }
            }
            for (let i = 0; i < positions.count; i += 3) {
                output += 'f ';
                output += (indexVertex + i + 1) + '/' + (indexVertexUvs + i + 1) + '/' + (indexNormals + i + 1) + ' ';
                output += (indexVertex + i + 2) + '/' + (indexVertexUvs + i + 2) + '/' + (indexNormals + i + 2) + ' ';
                output += (indexVertex + i + 3) + '/' + (indexVertexUvs + i + 3) + '/' + (indexNormals + i + 3) + '\n';
            }
            indexVertex += positions.count;
            indexVertexUvs += uvs ? uvs.count : 0;
            indexNormals += normals ? normals.count : 0;
        };
        object.traverse((child) => { if (child instanceof THREE.Mesh) parseMesh(child); });
        return output;
    }
}

function exportModel() {
    const exporter = new OBJExporter();
    const result = exporter.parse(scene);
    if (!result.length) { alert('Export failed: empty OBJ'); return; }
    const blob = new Blob([result], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'panel.obj';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

async function exportZip() {
    const zip = new JSZip();
    const exporter = new OBJExporter();
    zip.file('panel.obj', exporter.parse(scene));
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');
    const pngBytes = atob(dataUrl.split(',')[1]);
    const buf = new Uint8Array(pngBytes.length);
    for (let i = 0; i < pngBytes.length; i++) buf[i] = pngBytes.charCodeAt(i);
    zip.file('panel.png', buf);
    const content = await zip.generateAsync({ type: 'blob' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = 'panel_files.zip';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

init();
