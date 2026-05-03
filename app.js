let scene, camera, renderer, panel, ambientLight, directionalLight;
const simplex = new SimplexNoise();
let carvingLines = [];
let currentLinesData = [];
let adjustedValues = {}; // To store adjusted values by the user

const MIN_CAMERA_Z = 50;
const MAX_CAMERA_Z = 8000;

let isMouseDown = false;
let mouseX = 0;
let mouseY = 0;
let targetRotationX = 0;
let targetRotationY = 0;

const DEFAULT_PANEL_COLOR = 0xFF8C00;
const noiseScaleValues = [0.005, 0.01, 0.015, 0.02, 0.025];

// Cross-section profiles for carving "tools". Input t = distance / (lineWidth/2),
// expected to be in [0, 1]. Output is a depth fraction in [0, 1] where 1 = max depth.
const TOOL_PROFILES = {
    cosine: (t) => Math.cos(Math.PI * t / 2),    // current behavior — broad U-groove
    vee:    (t) => 1 - Math.abs(t),              // sharp V-groove
    square: () => 1,                             // flat-bottom rectangular pocket
    round:  (t) => Math.sqrt(Math.max(0, 1 - t * t)),  // semicircle
};
const TOOL_NAMES = ['cosine', 'vee', 'square', 'round'];

function profileDepthFraction(toolName, t) {
    const fn = TOOL_PROFILES[toolName] || TOOL_PROFILES.cosine;
    return fn(Math.min(1, Math.max(0, t)));
}

function readStyleOpts() {
    const toolEl = document.getElementById('toolSelect');
    const toolValue = toolEl ? toolEl.value : 'cosine';
    return {
        toolMode: toolValue === 'random' ? 'random' : 'fixed',
        tool: toolValue === 'random' ? 'cosine' : toolValue,
        organic: !!(document.getElementById('organicEnabled') && document.getElementById('organicEnabled').checked),
        organicAmp: parseFloat((document.getElementById('organicAmp') || { value: 0 }).value),
        organicFreq: parseFloat((document.getElementById('organicFreq') || { value: 0.02 }).value),
        mishimaEnabled: !!(document.getElementById('mishimaEnabled') && document.getElementById('mishimaEnabled').checked),
        mishimaProb: parseFloat((document.getElementById('mishimaProb') || { value: 1 }).value),
    };
}

function init() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 10000);
    camera.position.z = 1000;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0); // Transparent background
    document.getElementById('scene-container').appendChild(renderer.domElement);

    ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    createPanel();

    renderer.domElement.addEventListener('mousedown', onMouseDown, false);
    renderer.domElement.addEventListener('mousemove', onMouseMove, false);
    renderer.domElement.addEventListener('mouseup', onMouseUp, false);
    renderer.domElement.addEventListener('wheel', onMouseWheel, false);

    window.addEventListener('resize', onWindowResize, false);

    animate();
}

function createPanel() {
    clearScene();

    // Ensure dynamic column/row inputs exist for the current `columns` value
    // before we read or write to them. Without this, pressing Enter on the
    // columns field renders before onchange has regenerated the inputs.
    updateColumnInputs();

    const width = parseFloat(document.getElementById('width').value);
    const height = parseFloat(document.getElementById('height').value);
    const thickness = parseFloat(document.getElementById('thickness').value);
    const columns = parseInt(document.getElementById('columns').value);
    const spacing = parseFloat(document.getElementById('spacing').value);
    const spacingHorizontal = parseFloat(document.getElementById('spacingHorizontal').value);
    const panelColor = new THREE.Color(document.getElementById('panelColor').value);

    let totalSpecifiedWidth = 0;
    const columnWidths = [];
    for (let i = 0; i < columns - 1; i++) {
        const colWidth = adjustedValues[`colWidth${i + 1}`] || (width - (columns - 1) * spacing) / columns;
        columnWidths.push(colWidth);
        totalSpecifiedWidth += colWidth;
        document.getElementById(`colWidth${i + 1}`).value = colWidth; // Set adjusted or default value
    }
    const lastColumnWidth = width - totalSpecifiedWidth - (columns - 1) * spacing;
    columnWidths.push(lastColumnWidth);
    if (document.getElementById(`colWidth${columns}`)) {
        document.getElementById(`colWidth${columns}`).value = lastColumnWidth; // Set value but not adjustable
        document.getElementById(`colWidth${columns}`).disabled = true;
    }

    carvingLines = [];

    const minWidth = parseFloat(document.getElementById('minWidth').value);
    const maxWidth = parseFloat(document.getElementById('maxWidth').value);

    const styleOpts = readStyleOpts();

    const globalLinesData = generateGlobalLinesData(
        document.getElementById('pattern').value,
        width, height, columns, spacing,
        parseFloat(document.getElementById('minSpacing').value),
        parseFloat(document.getElementById('maxSpacing').value),
        minWidth,
        maxWidth,
        styleOpts
    );

    currentLinesData = globalLinesData;
    globalLinesData.forEach(line => {
        const samples = sampleLineCenterline(line, width, height);
        const segments = [];
        for (let s = 0; s < samples.length - 1; s++) {
            segments.push({ start: samples[s], end: samples[s + 1] });
        }
        carvingLines.push(segments);
    });

    const useMishima = styleOpts.mishimaEnabled;
    const inlayColor = new THREE.Color(document.getElementById('inlayColor').value);
    const maxLineDepth = globalLinesData.reduce((m, l) => Math.max(m, l.lineDepth), 0) || 1;

    // Pick segment density adaptively: ~4 segments across the smallest line width,
    // capped so we don't blow up the vertex count for large multi-cell panels.
    const segPerMM = Math.max(0.05, 4 / Math.max(1, minWidth));

    let xOffset = -width / 2 + columnWidths[0] / 2;
    for (let i = 0; i < columns; i++) {
        const rowsEl = document.getElementById(`rows${i + 1}`);
        const rows = rowsEl ? parseInt(rowsEl.value) : (adjustedValues[`rows${i + 1}`] || 1);
        let totalSpecifiedHeight = 0;
        const rowHeights = [];
        for (let j = 0; j < rows - 1; j++) {
            const rowHeight = adjustedValues[`rowHeight${i + 1}_${j + 1}`] || (height - (rows - 1) * spacingHorizontal) / rows;
            rowHeights.push(rowHeight);
            totalSpecifiedHeight += rowHeight;
            const rhEl = document.getElementById(`rowHeight${i + 1}_${j + 1}`);
            if (rhEl) rhEl.value = rowHeight;
        }
        const lastRowHeight = height - totalSpecifiedHeight - (rows - 1) * spacingHorizontal;
        rowHeights.push(lastRowHeight);
        const lastRhEl = document.getElementById(`rowHeight${i + 1}_${rows}`);
        if (lastRhEl) {
            lastRhEl.value = lastRowHeight;
            lastRhEl.disabled = true;
        }

        let yOffset = -height / 2 + rowHeights[0] / 2;
        for (let j = 0; j < rows; j++) {
            const wSegs = Math.min(300, Math.max(20, Math.ceil(columnWidths[i] * segPerMM)));
            const hSegs = Math.min(300, Math.max(20, Math.ceil(rowHeights[j] * segPerMM)));
            const geometry = new THREE.BoxGeometry(columnWidths[i], rowHeights[j], thickness, wSegs, hSegs, 1);
            const material = new THREE.MeshPhongMaterial({ color: panelColor, vertexColors: useMishima });
            const newPanel = new THREE.Mesh(geometry, material);
            newPanel.position.set(
                xOffset,
                yOffset,
                0
            );
            scene.add(newPanel);

            const inlayMask = useMishima ? new Map() : null;
            const displacement = applyGlobalLinesToPanel(
                geometry, columnWidths[i], rowHeights[j], thickness,
                globalLinesData, xOffset, yOffset, width, height, inlayMask
            );
            if (useMishima) {
                applyInlayColors(geometry, displacement, inlayMask, panelColor, inlayColor, maxLineDepth, thickness);
            }

            geometry.computeVertexNormals();
            yOffset += rowHeights[j] / 2 + (j < rows - 1 ? rowHeights[j + 1] / 2 : 0) + spacingHorizontal;
        }
        xOffset += columnWidths[i] / 2 + (i < columns - 1 ? columnWidths[i + 1] / 2 : 0) + spacing;
    }

    fitPanelToView();
}

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
        let colWidth = '';

        if (i < columns - 1) {
            colWidth = adjustedValues[`colWidth${i + 1}`] || ((totalWidth - (columns - 1) * spacing) / columns);
            totalSpecifiedWidth += colWidth;
        } else {
            colWidth = totalWidth - totalSpecifiedWidth - (columns - 1) * spacing;
        }

        const rowsValue = adjustedValues[`rows${i + 1}`] || 1;

        columnSection.innerHTML = `
            <label>Column ${i + 1} Width: <input type="number" id="colWidth${i + 1}" value="${colWidth}" ${i === columns - 1 ? 'disabled' : ''} min="10" max="10000" onchange="onInputChange('colWidth${i + 1}')" onkeypress="checkEnterKey(event)"></label>
            <label>Rows in Column ${i + 1}: <input type="number" id="rows${i + 1}" value="${rowsValue}" min="1" max="10" onchange="onRowsChange(${i + 1})" onkeypress="checkEnterKey(event)"></label>
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
        let rowHeight = '';

        if (i < rows - 1) {
            rowHeight = adjustedValues[`rowHeight${columnIndex}_${i + 1}`] || ((totalHeight - (rows - 1) * spacingHorizontal) / rows);
            totalSpecifiedHeight += rowHeight;
        } else {
            rowHeight = totalHeight - totalSpecifiedHeight - (rows - 1) * spacingHorizontal;
        }

        const rowLabel = document.createElement('label');
        rowLabel.innerHTML = `Row ${i + 1} Height: <input type="number" id="rowHeight${columnIndex}_${i + 1}" value="${rowHeight}" ${i === rows - 1 ? 'disabled' : ''} min="10" max="10000" onchange="onInputChange('rowHeight${columnIndex}_${i + 1}')" onkeypress="checkEnterKey(event)"><br>`;
        rowSectionsDiv.appendChild(rowLabel);
    }
}

function onRowsChange(columnIndex) {
    adjustedValues[`rows${columnIndex}`] = parseInt(document.getElementById(`rows${columnIndex}`).value);
    updateRowInputs(columnIndex); // Reinitialize rows input fields
    updatePanel(); // Update panel when rows change
}

function checkEnterKey(event) {
    if (event.keyCode === 13) { // Enter key
        updatePanel();
    }
}

function onInputChange(inputId) {
    adjustedValues[inputId] = parseFloat(document.getElementById(inputId).value);
    updatePanel();
}

updateColumnInputs();

function generateGlobalLinesData(patternType, width, height, columns, spacing, minSpacing, maxSpacing, minWidth, maxWidth, styleOpts) {
    const opts = styleOpts || {};
    const linesData = [];

    const decorate = (line) => {
        line.tool = opts.toolMode === 'random'
            ? TOOL_NAMES[Math.floor(Math.random() * TOOL_NAMES.length)]
            : (opts.tool || 'cosine');
        line.organic = !!opts.organic;
        line.organicAmp = opts.organicAmp || 0;
        line.organicFreq = opts.organicFreq || 0.02;
        line.seed = Math.random() * 1000;
        line.mishima = !!(opts.mishimaEnabled && Math.random() < (opts.mishimaProb != null ? opts.mishimaProb : 1));
        return line;
    };

    if (patternType === 'horizontal') {
        let y = -height / 2;
        const maxY = height / 2;
        while (y < maxY) {
            const lineWidth = Math.random() * (maxWidth - minWidth) + minWidth;
            const lineDepth = lineWidth / 3;
            linesData.push(decorate({ y, lineWidth, lineDepth }));
            y += lineWidth + Math.random() * (maxSpacing - minSpacing) + minSpacing;
        }
    } else if (patternType === 'vertical') {
        let x = -width / 2;
        const maxX = width / 2;
        while (x < maxX) {
            const lineWidth = Math.random() * (maxWidth - minWidth) + minWidth;
            const lineDepth = lineWidth / 3;
            linesData.push(decorate({ x, lineWidth, lineDepth }));
            x += lineWidth + Math.random() * (maxSpacing - minSpacing) + minSpacing;
        }
    } else if (patternType === 'cross') {
        generateGlobalLinesData('horizontal', width, height, columns, spacing, minSpacing, maxSpacing, minWidth, maxWidth, opts).forEach(line => linesData.push(line));
        generateGlobalLinesData('vertical', width, height, columns, spacing, minSpacing, maxSpacing, minWidth, maxWidth, opts).forEach(line => linesData.push(line));
    }

    return linesData;
}

// Returns polyline samples for a line in panel-global coords (origin at panel center).
// Straight line -> 2 samples (start, end). Organic -> stepped samples along simplex-noise wave.
function sampleLineCenterline(line, panelW, panelH) {
    const isVertical = line.hasOwnProperty('x');
    const baseCoord = isVertical ? line.x : line.y;
    const along0 = isVertical ? -panelH / 2 : -panelW / 2;
    const along1 = isVertical ? panelH / 2 : panelW / 2;

    if (!line.organic || !line.organicAmp) {
        if (isVertical) return [{ x: baseCoord, y: along0 }, { x: baseCoord, y: along1 }];
        return [{ x: along0, y: baseCoord }, { x: along1, y: baseCoord }];
    }

    const step = Math.max(0.5, Math.min(2, line.lineWidth));
    const seed = line.seed || 0;
    const freq = line.organicFreq;
    const amp = line.organicAmp;
    const samples = [];
    let along = along0;
    while (along < along1) {
        const offset = amp * simplex.noise2D(along * freq, seed);
        if (isVertical) samples.push({ x: baseCoord + offset, y: along });
        else samples.push({ x: along, y: baseCoord + offset });
        along += step;
    }
    const endOffset = amp * simplex.noise2D(along1 * freq, seed);
    if (isVertical) samples.push({ x: baseCoord + endOffset, y: along1 });
    else samples.push({ x: along1, y: baseCoord + endOffset });
    return samples;
}

function applyGlobalLinesToPanel(geometry, width, height, thickness, linesData, xOffset, yOffset, panelW, panelH, vertexInlayMask) {
    const positions = geometry.attributes.position;
    const vertexDisplacement = new Map();

    // Cache front-face vertices once to avoid scanning all 6 faces per line.
    const frontX = [], frontY = [], frontI = [];
    for (let i = 0; i < positions.count; i++) {
        if (Math.abs(positions.getZ(i) - thickness / 2) < 0.01) {
            frontX.push(positions.getX(i));
            frontY.push(positions.getY(i));
            frontI.push(i);
        }
    }
    const N = frontI.length;

    // Coarse spatial grid so per-segment lookups don't scan the whole front face.
    const gridSize = 20;
    const gridCols = Math.max(1, Math.ceil(width / gridSize)) + 1;
    const gridRows = Math.max(1, Math.ceil(height / gridSize)) + 1;
    const grid = new Array(gridCols * gridRows);
    for (let k = 0; k < N; k++) {
        const cx = Math.min(gridCols - 1, Math.max(0, Math.floor((frontX[k] + width / 2) / gridSize)));
        const cy = Math.min(gridRows - 1, Math.max(0, Math.floor((frontY[k] + height / 2) / gridSize)));
        const g = cy * gridCols + cx;
        if (!grid[g]) grid[g] = [];
        grid[g].push(k);
    }

    linesData.forEach(line => {
        const samples = sampleLineCenterline(line, panelW, panelH);
        const halfW = line.lineWidth / 2;
        const tool = line.tool || 'cosine';

        for (let s = 0; s < samples.length - 1; s++) {
            // Convert global -> cell-local
            const ax = samples[s].x - xOffset;
            const ay = samples[s].y - yOffset;
            const bx = samples[s + 1].x - xOffset;
            const by = samples[s + 1].y - yOffset;
            const dx = bx - ax;
            const dy = by - ay;
            const lenSq = dx * dx + dy * dy;
            if (lenSq === 0) continue;

            const minX = Math.min(ax, bx) - halfW;
            const maxX = Math.max(ax, bx) + halfW;
            const minY = Math.min(ay, by) - halfW;
            const maxY = Math.max(ay, by) + halfW;

            const cxMin = Math.max(0, Math.floor((minX + width / 2) / gridSize));
            const cxMax = Math.min(gridCols - 1, Math.floor((maxX + width / 2) / gridSize));
            const cyMin = Math.max(0, Math.floor((minY + height / 2) / gridSize));
            const cyMax = Math.min(gridRows - 1, Math.floor((maxY + height / 2) / gridSize));
            if (cxMin > cxMax || cyMin > cyMax) continue;

            for (let cy = cyMin; cy <= cyMax; cy++) {
                for (let cx = cxMin; cx <= cxMax; cx++) {
                    const bucket = grid[cy * gridCols + cx];
                    if (!bucket) continue;
                    for (let m = 0; m < bucket.length; m++) {
                        const k = bucket[m];
                        const vx = frontX[k];
                        const vy = frontY[k];
                        if (vx < minX || vx > maxX || vy < minY || vy > maxY) continue;
                        const t = ((vx - ax) * dx + (vy - ay) * dy) / lenSq;
                        if (t < 0 || t > 1) continue;
                        const projX = ax + t * dx;
                        const projY = ay + t * dy;
                        const distance = Math.hypot(vx - projX, vy - projY);
                        if (distance >= halfW) continue;

                        const profile = profileDepthFraction(tool, distance / halfW);
                        const newZ = thickness / 2 - line.lineDepth * profile;
                        const idx = frontI[k];
                        const existingZ = vertexDisplacement.has(idx) ? vertexDisplacement.get(idx) : thickness / 2;
                        if (newZ < existingZ) {
                            vertexDisplacement.set(idx, newZ);
                            if (vertexInlayMask) vertexInlayMask.set(idx, !!line.mishima);
                        }
                    }
                }
            }
        }
    });

    for (let [vertexIndex, displacement] of vertexDisplacement.entries()) {
        positions.setZ(vertexIndex, displacement);
    }
    positions.needsUpdate = true;

    return vertexDisplacement;
}

function applyInlayColors(geometry, displacement, inlayMask, panelColor, inlayColor, maxDepth, thickness) {
    const positions = geometry.attributes.position;
    const colors = new Float32Array(positions.count * 3);
    const tmp = new THREE.Color();
    const safeMax = maxDepth > 0 ? maxDepth : 1;

    for (let i = 0; i < positions.count; i++) {
        if (inlayMask.get(i)) {
            const z = displacement.has(i) ? displacement.get(i) : thickness / 2;
            const depth = Math.max(0, thickness / 2 - z);
            const factor = Math.min(1, depth / safeMax);
            tmp.copy(panelColor).lerp(inlayColor, factor);
            colors[i * 3] = tmp.r;
            colors[i * 3 + 1] = tmp.g;
            colors[i * 3 + 2] = tmp.b;
        } else {
            colors[i * 3] = panelColor.r;
            colors[i * 3 + 1] = panelColor.g;
            colors[i * 3 + 2] = panelColor.b;
        }
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function updatePanel() {
    createPanel();
    resetView();
}

function resetView() {
    targetRotationX = 0;
    targetRotationY = 0;
    fitPanelToView();
}

function fitPanelToView() {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxSize = Math.max(size.x, size.y, size.z);
    const fitHeightDistance = maxSize / (2 * Math.atan(Math.PI * camera.fov / 360));
    const fitWidthDistance = fitHeightDistance / camera.aspect;
    const distance = fitHeightDistance > fitWidthDistance ? fitHeightDistance : fitWidthDistance;
    camera.position.set(0, 0, distance * 1.2);
    camera.lookAt(box.getCenter(new THREE.Vector3()));
}

function onMouseDown(event) {
    isMouseDown = true;
    mouseX = event.clientX;
    mouseY = event.clientY;
}

function onMouseMove(event) {
    if (isMouseDown) {
        const deltaX = event.clientX - mouseX;
        const deltaY = event.clientY - mouseY;

        targetRotationY += deltaX * 0.01;
        targetRotationX += deltaY * 0.01;

        mouseX = event.clientX;
        mouseY = event.clientY;
    }
}

function onMouseUp() {
    isMouseDown = false;
}

function onMouseWheel(event) {
    event.preventDefault();
    const next = camera.position.z + event.deltaY;
    camera.position.z = Math.min(MAX_CAMERA_Z, Math.max(MIN_CAMERA_Z, next));
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    scene.rotation.x += (targetRotationX - scene.rotation.x) * 0.05;
    scene.rotation.y += (targetRotationY - scene.rotation.y) * 0.05;

    renderer.render(scene, camera);
}

class OBJExporter {
    parse(object) {
        let output = '';
        let indexVertex = 0;
        let indexVertexUvs = 0;
        let indexNormals = 0;

        const vertex = new THREE.Vector3();
        const normal = new THREE.Vector3();
        const uv = new THREE.Vector2();

        const parseMesh = (mesh) => {
            let geometry = mesh.geometry;

            if (geometry instanceof THREE.BufferGeometry) {
                if (geometry.index !== null) {
                    geometry = geometry.toNonIndexed();
                }

                const positions = geometry.attributes.position;
                const normals = geometry.attributes.normal;
                const uvs = geometry.attributes.uv;

                if (!positions) {
                    console.error('OBJExporter: Geometry has no positions.');
                    return;
                }

                for (let i = 0, l = positions.count; i < l; i++) {
                    vertex.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
                    output += `v ${vertex.x} ${vertex.y} ${vertex.z}\n`;
                }

                if (normals !== undefined) {
                    for (let i = 0, l = normals.count; i < l; i++) {
                        normal.fromBufferAttribute(normals, i);
                        normal.applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld));
                        output += `vn ${normal.x} ${normal.y} ${normal.z}\n`;
                    }
                }

                if (uvs !== undefined) {
                    for (let i = 0, l = uvs.count; i < l; i++) {
                        uv.fromBufferAttribute(uvs, i);
                        output += `vt ${uv.x} ${uv.y}\n`;
                    }
                }

                for (let i = 0, j = 1, l = positions.count; i < l; i += 3, j += 3) {
                    output += 'f ';
                    output += (indexVertex + i + 1) + '/' + (indexVertexUvs + i + 1) + '/' + (indexNormals + i + 1) + ' ';
                    output += (indexVertex + i + 2) + '/' + (indexVertexUvs + i + 2) + '/' + (indexNormals + i + 2) + ' ';
                    output += (indexVertex + i + 3) + '/' + (indexVertexUvs + i + 3) + '/' + (indexNormals + i + 3) + '\n';
                }

                indexVertex += positions.count;
                indexVertexUvs += uvs ? uvs.count : 0;
                indexNormals += normals ? normals.count : 0;
            } else {
                console.warn('OBJExporter: Geometry is not an instance of THREE.BufferGeometry.', geometry);
                return;
            }
        };

        object.traverse(function (child) {
            if (child instanceof THREE.Mesh) {
                parseMesh(child);
            }
        });

        return output;
    }
}

function exportModel() {
    try {
        const exporter = new OBJExporter();
        const result = exporter.parse(scene);
        if (result.length === 0) {
            console.error("Exported OBJ is empty");
            alert("Export failed: Generated OBJ is empty");
            return;
        }
        const blob = new Blob([result], { type: 'text/plain' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'panel.obj';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (error) {
        console.error("Error in exportModel:", error);
        alert("Export failed: " + error.message);
    }
}

async function previewPDF() {
    const pdfBlob = await generatePDFBlob();
    const url = URL.createObjectURL(pdfBlob);
    window.open(url, '_blank');
}

async function generatePDFBlob() {
    const width = parseFloat(document.getElementById('width').value);
    const height = parseFloat(document.getElementById('height').value);
    const thickness = parseFloat(document.getElementById('thickness').value);

    const carvingLength = calculateCarvingLength();
    const area = (width * height) / 1000000;

    renderer.render(scene, camera);

    const canvas = await html2canvas(document.getElementById('scene-container'), { backgroundColor: null });
    const imgData = canvas.toDataURL('image/png');

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();

    pdf.setFontSize(16);
    pdf.text('3D Panel Report', 10, 10);
    pdf.setFontSize(12);
    pdf.text(`Width: ${width} mm`, 10, 20);
    pdf.text(`Height: ${height} mm`, 10, 30);
    pdf.text(`Thickness: ${thickness} mm`, 10, 40);
    pdf.text(`Carving Length: ${carvingLength.toFixed(2)} mm`, 10, 50);
    pdf.text(`Area: ${area.toFixed(2)} square meters`, 10, 60);

    pdf.addImage(imgData, 'PNG', 10, 70, 180, 120);

    return pdf.output('blob');
}

async function exportZip() {
    const zip = new JSZip();

    const exporter = new OBJExporter();
    const objData = exporter.parse(scene);
    zip.file('panel.obj', objData);

    const pdfBlob = await generatePDFBlob();
    zip.file('panel_report.pdf', pdfBlob);

    zip.file('panel.gcode', generateCNCCode());

    zip.generateAsync({ type: 'blob' }).then(function(content) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = 'panel_files.zip';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
}

function generateCNCCode() {
    const width = parseFloat(document.getElementById('width').value);
    const height = parseFloat(document.getElementById('height').value);
    const safeZ = 5;
    const plungeFeed = 200;
    const cutFeed = 800;

    const lines = [];
    lines.push('; G-code generated by 3D Panel Designer');
    lines.push(`; Panel: ${width} x ${height} mm`);
    lines.push(`; Carvings: ${currentLinesData.length}`);
    lines.push('G21 ; mm');
    lines.push('G90 ; absolute');
    lines.push('G17 ; XY plane');
    lines.push('M3 S12000 ; spindle on');
    lines.push(`G0 Z${safeZ}`);

    currentLinesData.forEach(line => {
        const samples = sampleLineCenterline(line, width, height);
        if (samples.length < 2) return;
        const depth = (-line.lineDepth).toFixed(3);
        const tool = line.tool || 'cosine';
        if (line.mishima) lines.push(`; mishima inlay (visual only)`);
        lines.push(`; tool profile: ${tool}`);
        // Convert from panel-center coords to bottom-left corner coords
        const startX = (samples[0].x + width / 2).toFixed(3);
        const startY = (samples[0].y + height / 2).toFixed(3);
        lines.push(`G0 X${startX} Y${startY}`);
        lines.push(`G1 Z${depth} F${plungeFeed}`);
        for (let s = 1; s < samples.length; s++) {
            const sx = (samples[s].x + width / 2).toFixed(3);
            const sy = (samples[s].y + height / 2).toFixed(3);
            lines.push(`G1 X${sx} Y${sy} F${cutFeed}`);
        }
        lines.push(`G0 Z${safeZ}`);
    });

    lines.push('M5 ; spindle off');
    lines.push('M30 ; end');
    return lines.join('\n');
}

function exportCNC() {
    const gcode = generateCNCCode();
    const blob = new Blob([gcode], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'panel.gcode';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function calculateCarvingLength() {
    let carvingLength = 0;
    carvingLines.forEach(lineSegments => {
        for (let i = 0; i < lineSegments.length; i++) {
            const start = lineSegments[i].start;
            const end = lineSegments[i].end;
            const segmentLength = Math.sqrt((end.x - start.x) ** 2 + (end.y - start.y) ** 2);
            carvingLength += segmentLength;
        }
    });
    return carvingLength;
}

function clearScene() {
    const children = scene.children.filter(child => child.type === 'Mesh');
    children.forEach(child => {
        scene.remove(child);
        child.geometry.dispose();
        child.material.dispose();
    });
}

init();
