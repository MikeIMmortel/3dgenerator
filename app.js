let scene, camera, renderer, panel, ambientLight, directionalLight;
let isOrganicEnabled = false;
const simplex = new SimplexNoise();
let carvingLines = [];
let adjustedValues = {}; // To store adjusted values by the user

let isMouseDown = false;
let mouseX = 0;
let mouseY = 0;
let targetRotationX = 0;
let targetRotationY = 0;

const DEFAULT_PANEL_COLOR = 0xFF8C00;
const noiseScaleValues = [0.005, 0.01, 0.015, 0.02, 0.025];

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

    const width = parseFloat(document.getElementById('width').value);
    const height = parseFloat(document.getElementById('height').value);
    const thickness = parseFloat(document.getElementById('thickness').value);
    const columns = parseFloat(document.getElementById('columns').value);
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

    const globalLinesData = generateGlobalLinesData(
        document.getElementById('pattern').value,
        width, height, columns, spacing, 
        parseFloat(document.getElementById('minSpacing').value), 
        parseFloat(document.getElementById('maxSpacing').value), 
        parseFloat(document.getElementById('minWidth').value), 
        parseFloat(document.getElementById('maxWidth').value)
    );

    let xOffset = -width / 2 + columnWidths[0] / 2;
    for (let i = 0; i < columns; i++) {
        const rows = parseFloat(document.getElementById(`rows${i + 1}`).value);
        let totalSpecifiedHeight = 0;
        const rowHeights = [];
        for (let j = 0; j < rows - 1; j++) {
            const rowHeight = adjustedValues[`rowHeight${i + 1}_${j + 1}`] || (height - (rows - 1) * spacingHorizontal) / rows;
            rowHeights.push(rowHeight);
            totalSpecifiedHeight += rowHeight;
            document.getElementById(`rowHeight${i + 1}_${j + 1}`).value = rowHeight; // Set adjusted or default value
        }
        const lastRowHeight = height - totalSpecifiedHeight - (rows - 1) * spacingHorizontal;
        rowHeights.push(lastRowHeight);
        if (document.getElementById(`rowHeight${i + 1}_${rows}`)) {
            document.getElementById(`rowHeight${i + 1}_${rows}`).value = lastRowHeight; // Set value but not adjustable
            document.getElementById(`rowHeight${i + 1}_${rows}`).disabled = true;
        }

        let yOffset = -height / 2 + rowHeights[0] / 2;
        for (let j = 0; j < rows; j++) {
            const geometry = new THREE.BoxGeometry(columnWidths[i], rowHeights[j], thickness, 400, 400, 1);
            const material = new THREE.MeshPhongMaterial({ color: panelColor });
            const newPanel = new THREE.Mesh(geometry, material);
            newPanel.position.set(
                xOffset,
                yOffset,
                0
            );
            scene.add(newPanel);

            applyGlobalLinesToPanel(geometry, columnWidths[i], rowHeights[j], thickness, globalLinesData, xOffset, yOffset);

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

function generateGlobalLinesData(patternType, width, height, columns, spacing, minSpacing, maxSpacing, minWidth, maxWidth) {
    const linesData = [];

    if (patternType === 'horizontal') {
        let y = -height / 2;
        const maxY = height / 2;
        while (y < maxY) {
            const lineWidth = Math.random() * (maxWidth - minWidth) + minWidth;
            const lineDepth = lineWidth / 3;
            linesData.push({ y, lineWidth, lineDepth });
            y += lineWidth + Math.random() * (maxSpacing - minSpacing) + minSpacing;
        }
    } else if (patternType === 'vertical') {
        let x = -width / 2;
        const maxX = width / 2;
        while (x < maxX) {
            const lineWidth = Math.random() * (maxWidth - minWidth) + minWidth;
            const lineDepth = lineWidth / 3;
            linesData.push({ x, lineWidth, lineDepth });
            x += lineWidth + Math.random() * (maxSpacing - minSpacing) + minSpacing;
        }
    } else if (patternType === 'cross') {
        generateGlobalLinesData('horizontal', width, height, columns, spacing, minSpacing, maxSpacing, minWidth, maxWidth).forEach(line => linesData.push(line));
        generateGlobalLinesData('vertical', width, height, columns, spacing, minSpacing, maxSpacing, minWidth, maxWidth).forEach(line => linesData.push(line));
    }

    return linesData;
}

function applyGlobalLinesToPanel(geometry, width, height, thickness, linesData, xOffset, yOffset) {
    const positions = geometry.attributes.position;
    const vertexDisplacement = new Map();

    linesData.forEach(line => {
        if (line.hasOwnProperty('y')) {
            let y = line.y - yOffset;

            if (isOrganicEnabled) {
                // drawOrganicLine function was here
            } else {
                drawLineVertices(geometry, -width / 2, width / 2, y, line.lineWidth, line.lineDepth, false, thickness, vertexDisplacement);
            }
        }
    });

    linesData.forEach(line => {
        if (line.hasOwnProperty('x')) {
            let x = line.x - xOffset;

            if (isOrganicEnabled) {
                // drawOrganicLine function was here
            } else {
                drawLineVertices(geometry, -height / 2, height / 2, x, line.lineWidth, line.lineDepth, true, thickness, vertexDisplacement);
            }
        }
    });

    for (let [vertexIndex, displacement] of vertexDisplacement.entries()) {
        positions.setZ(vertexIndex, displacement);
    }

    positions.needsUpdate = true;
}

function drawLineVertices(geometry, start, end, fixedCoord, lineWidth, lineDepth, isVertical, thickness, vertexDisplacement) {
    const positions = geometry.attributes.position;

    for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const y = positions.getY(i);
        const z = positions.getZ(i);

        if (Math.abs(z - thickness / 2) < 0.01) {
            let coord = isVertical ? y : x;
            let distanceToLine = isVertical ? Math.abs(x - fixedCoord) : Math.abs(y - fixedCoord);

            if (coord >= start && coord <= end && distanceToLine < lineWidth / 2) {
                const newZ = thickness / 2 - lineDepth * Math.cos(Math.PI * distanceToLine / lineWidth);
                const existingDisplacement = vertexDisplacement.get(i) || thickness / 2;

                if (newZ < existingDisplacement) {
                    vertexDisplacement.set(i, newZ);
                }
            }
        }
    }
}

function selectPresetColor() {
    const colorPicker = document.getElementById('panelColor');
    const presetColors = document.getElementById('presetColors');
    colorPicker.value = presetColors.value;
    updatePanel();
}

function updatePanel() {
    clearScene();
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

function toggleOrganic() {
    isOrganicEnabled = !isOrganicEnabled;
    document.getElementById('toggleOrganic').textContent = isOrganicEnabled ? 'Straight Lines' : 'Organic Lines';
    updatePanel();
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
    camera.position.z += event.deltaY;
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

    zip.generateAsync({ type: 'blob' }).then(function(content) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = 'panel_files.zip';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
}

function exportCNC() {
    alert('CNC export functionality not implemented yet.');
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
