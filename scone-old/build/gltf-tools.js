import * as path from "node:path";
import * as fs from 'node:fs';
import { Document, NodeIO } from '@gltf-transform/core';
import { dedup, instance, flatten, join, weld, resample, prune, sparse, mergeDocuments, unpartition } from '@gltf-transform/functions';
const COMPONENT_SIZE_BY_TYPE = {
    5120: 1,
    5121: 1,
    5122: 2,
    5123: 2,
    5125: 4,
    5126: 4,
};
const COMPONENT_COUNT_BY_ACCESSOR_TYPE = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
};
function remapAccessorComponents(sourceArray, sourceCount, sourceStride, targetStride, createTargetArray, options) {
    const outputLength = sourceCount * targetStride;
    const output = createTargetArray(outputLength);
    const sharedStride = Math.min(sourceStride, targetStride);
    const transformValue = options?.transformValue;
    for (let elementIndex = 0; elementIndex < sourceCount; elementIndex++) {
        const sourceOffset = elementIndex * sourceStride;
        const outputOffset = elementIndex * targetStride;
        for (let componentIndex = 0; componentIndex < sharedStride; componentIndex++) {
            const sourceIndex = sourceOffset + componentIndex;
            if (sourceIndex >= sourceArray.length) {
                break;
            }
            const value = sourceArray[sourceIndex] ?? 0;
            output[outputOffset + componentIndex] = transformValue ? transformValue(value) : value;
        }
        if (options?.trailingDefaults) {
            for (let componentIndex = sharedStride; componentIndex < targetStride; componentIndex++) {
                const defaultValue = options.trailingDefaults[componentIndex];
                if (defaultValue !== undefined) {
                    output[outputOffset + componentIndex] = defaultValue;
                }
            }
        }
    }
    return output;
}
function decodeFloat16Bits(bits) {
    const sign = (bits & 0x8000) !== 0 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x03ff;
    if (exponent === 0) {
        if (fraction === 0) {
            return sign * 0;
        }
        return sign * 2 ** -14 * (fraction / 1024);
    }
    if (exponent === 0x1f) {
        return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
    }
    return sign * 2 ** (exponent - 15) * (1 + (fraction / 1024));
}
function decodeDataUri(uri) {
    const match = uri.match(/^data:.*?;base64,(.*)$/i);
    if (!match) {
        return null;
    }
    try {
        return Uint8Array.from(Buffer.from(match[1], 'base64'));
    }
    catch {
        return null;
    }
}
function loadSourceUvContext(modelPath) {
    if (path.extname(modelPath).toLowerCase() !== '.gltf') {
        return null;
    }
    let sourceJson;
    try {
        sourceJson = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    }
    catch {
        return null;
    }
    const accessors = sourceJson.accessors;
    const bufferViews = sourceJson.bufferViews;
    const gltfBuffers = sourceJson.buffers;
    const meshes = sourceJson.meshes;
    if (!Array.isArray(accessors) || !Array.isArray(bufferViews) || !Array.isArray(gltfBuffers) || !Array.isArray(meshes)) {
        return null;
    }
    const modelDir = path.dirname(modelPath);
    const buffers = [];
    for (const gltfBuffer of gltfBuffers) {
        const uri = gltfBuffer.uri;
        if (typeof uri !== 'string' || uri.length === 0) {
            return null;
        }
        const dataUriBuffer = decodeDataUri(uri);
        if (dataUriBuffer) {
            buffers.push(dataUriBuffer);
            continue;
        }
        const bufferPath = path.resolve(modelDir, decodeURIComponent(uri));
        if (!fs.existsSync(bufferPath)) {
            return null;
        }
        buffers.push(new Uint8Array(fs.readFileSync(bufferPath)));
    }
    return {
        accessors,
        bufferViews,
        buffers,
        meshes,
    };
}
function readTexCoordComponent(view, byteOffset, componentType, normalized) {
    switch (componentType) {
        case 5126:
            return view.getFloat32(byteOffset, true);
        case 5120: {
            const value = view.getInt8(byteOffset);
            return normalized ? Math.max(value / 127, -1) : value;
        }
        case 5121: {
            const value = view.getUint8(byteOffset);
            return normalized ? value / 255 : value;
        }
        case 5122:
            if (normalized) {
                const value = view.getInt16(byteOffset, true);
                return Math.max(value / 32767, -1);
            }
            return decodeFloat16Bits(view.getUint16(byteOffset, true));
        case 5123: {
            const value = view.getUint16(byteOffset, true);
            return normalized ? value / 65535 : value;
        }
        case 5125: {
            const value = view.getUint32(byteOffset, true);
            return normalized ? value / 4294967295 : value;
        }
        default:
            return null;
    }
}
function readTexCoordArrayFromSource(sourceUvContext, meshIndex, primitiveIndex, semantic) {
    const mesh = sourceUvContext.meshes[meshIndex];
    const sourcePrimitive = mesh?.primitives?.[primitiveIndex];
    const accessorIndex = sourcePrimitive?.attributes?.[semantic];
    if (typeof accessorIndex !== 'number' || !Number.isInteger(accessorIndex) || accessorIndex < 0 || accessorIndex >= sourceUvContext.accessors.length) {
        return null;
    }
    const accessor = sourceUvContext.accessors[accessorIndex];
    const bufferViewIndex = accessor.bufferView;
    if (typeof bufferViewIndex !== 'number' || !Number.isInteger(bufferViewIndex) || bufferViewIndex < 0 || bufferViewIndex >= sourceUvContext.bufferViews.length) {
        return null;
    }
    const bufferView = sourceUvContext.bufferViews[bufferViewIndex];
    if (!Number.isInteger(bufferView.buffer) || bufferView.buffer < 0 || bufferView.buffer >= sourceUvContext.buffers.length) {
        return null;
    }
    const bufferData = sourceUvContext.buffers[bufferView.buffer];
    const componentSize = COMPONENT_SIZE_BY_TYPE[accessor.componentType];
    const componentCount = COMPONENT_COUNT_BY_ACCESSOR_TYPE[accessor.type] ?? 0;
    if (!componentSize || componentCount < 2 || accessor.count <= 0) {
        return null;
    }
    const byteStride = bufferView.byteStride ?? (componentSize * componentCount);
    const baseOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const normalized = accessor.normalized ?? false;
    const view = new DataView(bufferData.buffer, bufferData.byteOffset, bufferData.byteLength);
    const texCoords = new Float32Array(accessor.count * 2);
    for (let i = 0; i < accessor.count; i++) {
        const elementOffset = baseOffset + (i * byteStride);
        const u = readTexCoordComponent(view, elementOffset, accessor.componentType, normalized);
        const v = readTexCoordComponent(view, elementOffset + componentSize, accessor.componentType, normalized);
        if (u === null || v === null) {
            return null;
        }
        texCoords[i * 2] = Number.isFinite(u) ? u : 0;
        texCoords[(i * 2) + 1] = Number.isFinite(v) ? 1 - v : 0;
    }
    return texCoords;
}
function fitTexCoordArrayToCount(sourceTexCoords, targetCount) {
    const sourceCount = Math.floor(sourceTexCoords.length / 2);
    if (targetCount <= 0 || targetCount === sourceCount) {
        return sourceTexCoords;
    }
    const output = new Float32Array(targetCount * 2);
    const copyCount = Math.min(targetCount, sourceCount);
    output.set(sourceTexCoords.subarray(0, copyCount * 2));
    return output;
}
function restoreTexCoordsFromOriginalModel(document, sourceUvContext) {
    let restoredAttributes = 0;
    const semantics = ['TEXCOORD_0', 'TEXCOORD_1'];
    const meshes = document.getRoot().listMeshes();
    for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
        const primitiveList = meshes[meshIndex].listPrimitives();
        for (let primitiveIndex = 0; primitiveIndex < primitiveList.length; primitiveIndex++) {
            const primitive = primitiveList[primitiveIndex];
            const positionCount = primitive.getAttribute('POSITION')?.getCount() ?? 0;
            for (const semantic of semantics) {
                const sourceTexCoords = readTexCoordArrayFromSource(sourceUvContext, meshIndex, primitiveIndex, semantic);
                if (!sourceTexCoords) {
                    continue;
                }
                const resolvedTexCoords = fitTexCoordArrayToCount(sourceTexCoords, positionCount > 0 ? positionCount : Math.floor(sourceTexCoords.length / 2));
                const texCoordArray = new Float32Array(resolvedTexCoords);
                const texCoordAccessor = document.createAccessor().setType('VEC2').setArray(texCoordArray);
                primitive.setAttribute(semantic, texCoordAccessor);
                restoredAttributes++;
            }
        }
    }
    return restoredAttributes;
}
function applyAsoboGeometryRepair(document) {
    const stats = {
        primitivesVisited: 0,
        primitivesReindexed: 0,
        normalsFlipped: 0,
        tangentsFlipped: 0,
        degenerateTrianglesDropped: 0,
        outOfRangeTrianglesDropped: 0,
        duplicateTrianglesDropped: 0,
    };
    const toNonNegativeInt = (value, fallback) => {
        const numericValue = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(numericValue) || numericValue < 0) {
            return fallback;
        }
        return Math.trunc(numericValue);
    };
    for (const mesh of document.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
            const extras = primitive.getExtras();
            const asoboPrimitive = extras?.ASOBO_primitive;
            if (!asoboPrimitive || typeof asoboPrimitive !== 'object') {
                continue;
            }
            stats.primitivesVisited++;
            const asoboFields = asoboPrimitive;
            const positionAccessor = primitive.getAttribute('POSITION');
            const vertexCount = positionAccessor?.getCount() ?? 0;
            const normalAccessor = primitive.getAttribute('NORMAL');
            const normalArray = normalAccessor?.getArray();
            if (normalAccessor && normalArray) {
                const flippedNormals = new Float32Array(normalArray.length);
                for (let i = 0; i < normalArray.length; i++) {
                    flippedNormals[i] = -normalArray[i];
                }
                const repairedNormals = document.createAccessor().setType(normalAccessor.getType()).setArray(flippedNormals);
                primitive.setAttribute('NORMAL', repairedNormals);
                stats.normalsFlipped++;
            }
            const tangentAccessor = primitive.getAttribute('TANGENT');
            const tangentArray = tangentAccessor?.getArray();
            if (tangentAccessor && tangentArray) {
                const flippedTangents = new Float32Array(tangentArray.length);
                for (let i = 0; i < tangentArray.length; i++) {
                    flippedTangents[i] = -tangentArray[i];
                }
                const repairedTangents = document.createAccessor().setType(tangentAccessor.getType()).setArray(flippedTangents);
                primitive.setAttribute('TANGENT', repairedTangents);
                stats.tangentsFlipped++;
            }
            const indexAccessor = primitive.getIndices();
            const indexArray = indexAccessor?.getArray();
            if (!indexAccessor || !indexArray) {
                continue;
            }
            const baseVertex = toNonNegativeInt(asoboFields.BaseVertexIndex, 0);
            const startIndex = toNonNegativeInt(asoboFields.StartIndex, 0);
            const declaredPrimitiveCount = toNonNegativeInt(asoboFields.PrimitiveCount, Math.floor(indexArray.length / 3));
            const availablePrimitiveCount = Math.max(0, Math.floor((indexArray.length - startIndex) / 3));
            const primitiveCount = Math.min(declaredPrimitiveCount, availablePrimitiveCount);
            if (primitiveCount <= 0) {
                continue;
            }
            const repairedIndices = [];
            const seenTriangles = new Set();
            let maxIndex = 0;
            for (let primitiveIndex = 0; primitiveIndex < primitiveCount; primitiveIndex++) {
                const offset = startIndex + (primitiveIndex * 3);
                const idx1 = baseVertex + Math.trunc(Number(indexArray[offset] ?? -1));
                const idx2 = baseVertex + Math.trunc(Number(indexArray[offset + 1] ?? -1));
                const idx3 = baseVertex + Math.trunc(Number(indexArray[offset + 2] ?? -1));
                if (idx1 < 0 || idx2 < 0 || idx3 < 0 || idx1 >= vertexCount || idx2 >= vertexCount || idx3 >= vertexCount) {
                    stats.outOfRangeTrianglesDropped++;
                    continue;
                }
                if (idx1 === idx2 || idx2 === idx3 || idx1 === idx3) {
                    stats.degenerateTrianglesDropped++;
                    continue;
                }
                const windingFlipped = [idx1, idx3, idx2];
                const sortedKey = [...windingFlipped].sort((a, b) => a - b).join(':');
                if (seenTriangles.has(sortedKey)) {
                    stats.duplicateTrianglesDropped++;
                    continue;
                }
                seenTriangles.add(sortedKey);
                repairedIndices.push(windingFlipped[0], windingFlipped[1], windingFlipped[2]);
                if (windingFlipped[0] > maxIndex)
                    maxIndex = windingFlipped[0];
                if (windingFlipped[1] > maxIndex)
                    maxIndex = windingFlipped[1];
                if (windingFlipped[2] > maxIndex)
                    maxIndex = windingFlipped[2];
            }
            if (repairedIndices.length === 0) {
                continue;
            }
            let repairedIndexArray;
            if (indexArray instanceof Uint32Array || maxIndex > 65535) {
                repairedIndexArray = new Uint32Array(repairedIndices);
            }
            else if (indexArray instanceof Uint16Array || maxIndex > 255) {
                repairedIndexArray = new Uint16Array(repairedIndices);
            }
            else {
                repairedIndexArray = new Uint8Array(repairedIndices);
            }
            const repairedIndexAccessor = document.createAccessor().setType('SCALAR').setArray(repairedIndexArray);
            primitive.setIndices(repairedIndexAccessor);
            stats.primitivesReindexed++;
        }
    }
    return stats;
}
function printUsage() {
    console.log([
        'Usage:',
        '  gltf-repair repair <modelPath> <issues.json> [outputPath]',
        '  gltf-repair assemble <modelToAddPath> <destinationModelPath> <x> <y> <z> <rotXDeg> <rotYDeg> <rotZDeg> [outputPath]',
        '  gltf-repair optimize <modelPath> [outputPath]',
        '',
        'Notes:',
        '  - repair mode reads validator issues JSON and applies baseline structural cleanup transforms.',
        '  - assemble mode merges modelToAdd into destinationModel and places it using translation + Euler rotation (degrees, XYZ order).',
        '  - optimize mode applies a series of optimization transforms to the model.',
    ].join('\n'));
}
function parseNumber(rawValue, label) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
        throw new Error(`Invalid ${label}: "${rawValue}" is not a finite number.`);
    }
    return value;
}
function parseMat4x4(values, label) {
    if (values.length !== 16) {
        throw new Error(`Invalid ${label}: expected 16 numbers, received ${values.length}.`);
    }
    return [
        parseNumber(values[0], `${label}[0]`),
        parseNumber(values[1], `${label}[1]`),
        parseNumber(values[2], `${label}[2]`),
        parseNumber(values[3], `${label}[3]`),
        parseNumber(values[4], `${label}[4]`),
        parseNumber(values[5], `${label}[5]`),
        parseNumber(values[6], `${label}[6]`),
        parseNumber(values[7], `${label}[7]`),
        parseNumber(values[8], `${label}[8]`),
        parseNumber(values[9], `${label}[9]`),
        parseNumber(values[10], `${label}[10]`),
        parseNumber(values[11], `${label}[11]`),
        parseNumber(values[12], `${label}[12]`),
        parseNumber(values[13], `${label}[13]`),
        parseNumber(values[14], `${label}[14]`),
        parseNumber(values[15], `${label}[15]`),
    ];
}
function withSuffix(filePath, suffix) {
    const ext = path.extname(filePath);
    const base = ext.length > 0 ? filePath.slice(0, -ext.length) : filePath;
    const effectiveExt = ext.length > 0 ? ext : '.gltf';
    return `${base}.${suffix}${effectiveExt}`;
}
function normalizeMsftTextureSources(modelPath) {
    if (path.extname(modelPath).toLowerCase() !== '.gltf') {
        return 0;
    }
    let modelJson;
    try {
        modelJson = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    }
    catch {
        return 0;
    }
    const textures = modelJson['textures'];
    if (!Array.isArray(textures)) {
        return 0;
    }
    let patchedTextureCount = 0;
    for (const texture of textures) {
        if (!texture || typeof texture !== 'object') {
            continue;
        }
        const textureObject = texture;
        if (typeof textureObject['source'] === 'number') {
            continue;
        }
        const extensions = textureObject['extensions'];
        if (!extensions || typeof extensions !== 'object') {
            continue;
        }
        const msftTextureDds = extensions['MSFT_texture_dds'];
        if (!msftTextureDds || typeof msftTextureDds !== 'object') {
            continue;
        }
        const sourceValue = msftTextureDds['source'];
        if (!Number.isInteger(sourceValue) || Number(sourceValue) < 0) {
            continue;
        }
        textureObject['source'] = Number(sourceValue);
        patchedTextureCount++;
    }
    if (patchedTextureCount > 0) {
        fs.writeFileSync(modelPath, JSON.stringify(modelJson, null, 2), 'utf8');
    }
    return patchedTextureCount;
}
function parseCliArgs(args) {
    if (args.length === 0) {
        throw new Error('No mode provided.');
    }
    const mode = args[0].toLowerCase();
    if (mode === 'repair') {
        if (args.length < 3) {
            throw new Error('repair mode requires: <modelPath> <issues.json> [outputPath].');
        }
        const modelPath = path.resolve(args[1]);
        const issuesJsonPath = path.resolve(args[2]);
        const outputPath = path.resolve(args[3] ?? withSuffix(modelPath, 'repaired'));
        return {
            mode,
            modelPath,
            issuesJsonPath,
            outputPath,
        };
    }
    if (mode === 'assemble') {
        if (args.length < 9) {
            throw new Error('assemble mode requires: <modelToAddPath> <destinationModelPath> <matrix 16 numbers> [outputPath].');
        }
        const sourceModelPath = path.resolve(args[1]);
        const destinationModelPath = path.resolve(args[2]);
        const matrix = parseMat4x4(args.slice(3, 19), 'matrix');
        const outputPath = path.resolve(args[19] ?? withSuffix(destinationModelPath, 'assembled'));
        return {
            mode,
            sourceModelPath,
            destinationModelPath,
            matrix,
            outputPath
        };
    }
    if (mode === 'optimize') {
        if (args.length < 3) {
            throw new Error('optimize mode requires: <modelPath> [outputPath].');
        }
        const modelPath = path.resolve(args[1]);
        const outputPath = path.resolve(args[2] ?? withSuffix(modelPath, 'optimized'));
        return {
            mode,
            modelPath,
            outputPath,
        };
    }
    throw new Error(`Unsupported mode "${args[0]}". Expected "repair", "assemble" or "optimize".`);
}
async function runRepairMode(options) {
    if (!fs.existsSync(options.modelPath)) {
        throw new Error(`Model file does not exist: ${options.modelPath}`);
    }
    if (!fs.existsSync(options.issuesJsonPath)) {
        throw new Error(`Issues JSON file does not exist: ${options.issuesJsonPath}`);
    }
    const issues = JSON.parse(fs.readFileSync(options.issuesJsonPath, 'utf8'))["issues"]["messages"];
    const io = new NodeIO();
    const patchedTextureCount = normalizeMsftTextureSources(options.modelPath);
    if (patchedTextureCount > 0) {
        console.log(`Patched ${patchedTextureCount} texture source references from MSFT_texture_dds.`);
    }
    const document = await io.read(options.modelPath);
    const sourceUvContext = loadSourceUvContext(options.modelPath);
    // This may need to be rearranged in the future to be more modular as the list of supported issues grows.
    // For now, handle detected issues on a case-by-case basis.
    for (const issue of issues.filter((issue) => issue.severity === 0)) {
        switch (issue.code) {
            case 'MESH_PRIMITIVE_ATTRIBUTES_ACCESSOR_INVALID_FORMAT': {
                console.log(`Repairing issue: ${issue.code} at ${issue.pointer}`);
                const pointerParts = issue.pointer.split('/');
                const primitive = document.getRoot().listMeshes()[Number(pointerParts[2])].listPrimitives()[Number(pointerParts[4])];
                const attribute = primitive.getAttribute(pointerParts[6]);
                if (attribute) {
                    const oldArray = attribute.getArray() ?? [];
                    const sourceCount = attribute.getCount();
                    const sourceStride = attribute.getElementSize();
                    switch (pointerParts[6]) {
                        case 'POSITION':
                        case 'NORMAL':
                            const newArray = remapAccessorComponents(oldArray, sourceCount, sourceStride, 3, (length) => new Float32Array(length));
                            const newAccessor = document.createAccessor().setType('VEC3').setArray(newArray);
                            primitive.setAttribute(pointerParts[6], newAccessor);
                            break;
                        case 'TANGENT':
                            const newArrayTangent = remapAccessorComponents(oldArray, sourceCount, sourceStride, 4, (length) => new Float32Array(length), {
                                trailingDefaults: [0, 0, 0, 1],
                            });
                            const newAccessorTangent = document.createAccessor().setType('VEC4').setArray(newArrayTangent);
                            primitive.setAttribute(pointerParts[6], newAccessorTangent);
                            break;
                        case 'TEXCOORD_0':
                        case 'TEXCOORD_1':
                            const newArrayTexCoord = remapAccessorComponents(oldArray, sourceCount, sourceStride, 2, (length) => new Float32Array(length));
                            const newAccessorTexCoord = document.createAccessor().setType('VEC2').setArray(newArrayTexCoord);
                            primitive.setAttribute(pointerParts[6], newAccessorTexCoord);
                            break;
                        case 'COLOR_0':
                        case 'COLOR_1':
                            const newArrayColor = remapAccessorComponents(oldArray, sourceCount, sourceStride, 4, (length) => new Float32Array(length), {
                                transformValue: (value) => Math.min(1, Math.max(0, value)),
                                trailingDefaults: [0, 0, 0, 1],
                            });
                            const newAccessorColor = document.createAccessor().setType('VEC4').setArray(newArrayColor);
                            primitive.setAttribute(pointerParts[6], newAccessorColor);
                            break;
                        case 'JOINTS_0':
                        case 'JOINTS_1':
                            const newArrayJoints = remapAccessorComponents(oldArray, sourceCount, sourceStride, 4, (length) => new Uint16Array(length));
                            const newAccessorJoints = document.createAccessor().setType('VEC4').setArray(newArrayJoints);
                            primitive.setAttribute(pointerParts[6], newAccessorJoints);
                            break;
                        case 'WEIGHTS_0':
                        case 'WEIGHTS_1':
                            const newArrayWeights = remapAccessorComponents(oldArray, sourceCount, sourceStride, 4, (length) => new Float32Array(length));
                            const newAccessorWeights = document.createAccessor().setType('VEC4').setArray(newArrayWeights);
                            primitive.setAttribute(pointerParts[6], newAccessorWeights);
                            break;
                        default:
                            console.error(`No repair action defined for attribute: ${pointerParts[6]}`);
                            continue;
                    }
                }
                break;
            }
            case 'MESH_PRIMITIVE_UNEQUAL_ACCESSOR_COUNT': {
                console.log(`Repairing issue: ${issue.code} at ${issue.pointer}`);
                const pointerPartsCount = issue.pointer.split('/');
                const primitive = document.getRoot().listMeshes()[Number(pointerPartsCount[2])].listPrimitives()[Number(pointerPartsCount[4])];
                const positionAccessor = primitive.getAttribute('POSITION');
                if (positionAccessor) {
                    const positionCount = positionAccessor.getCount();
                    for (const attributeName of ['NORMAL', 'TANGENT', 'TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0', 'COLOR_1', 'JOINTS_0', 'JOINTS_1', 'WEIGHTS_0', 'WEIGHTS_1']) {
                        const accessor = primitive.getAttribute(attributeName);
                        if (accessor && accessor.getCount() !== positionCount) {
                            console.log(`Adjusting attribute ${attributeName} count from ${accessor.getCount()} to ${positionCount}`);
                            const newArray = new (accessor.getArray() instanceof Float32Array ? Float32Array : Uint16Array)(positionCount * accessor.getElementSize());
                            newArray.set((accessor.getArray() ?? []).slice(0, Math.min(accessor.getCount(), positionCount) * accessor.getElementSize()));
                            const newAccessor = document.createAccessor().setType(accessor.getType()).setArray(newArray);
                            primitive.setAttribute(attributeName, newAccessor);
                        }
                    }
                }
                break;
            }
            case 'EMPTY_ENTITY': {
                console.log(`Repairing issue: ${issue.code} at ${issue.pointer}`);
                // TODO: Implement repair logic for EMPTY_ENTITY if needed. For now, we just log the issue.
                break;
            }
            case 'VALUE_NOT_IN_RANGE': {
                console.log(`Repairing issue: ${issue.code} at ${issue.pointer}`);
                const pointerPartsRange = issue.pointer.split('/');
                const material = document.getRoot().listMaterials()[Number(pointerPartsRange[2])];
                if (material) {
                    const metallicFactor = material.getMetallicFactor();
                    if (metallicFactor < 0 || metallicFactor > 1) {
                        // Most times we don't want the metallic factor to get maxed out, so wrap it around instead
                        console.log(`Adjusting metallic factor from ${metallicFactor} to be within [0, 1]`);
                        material.setMetallicFactor(metallicFactor % 1);
                        break;
                    }
                    const emissiveFactor = material.getEmissiveFactor();
                    if (emissiveFactor.some((value) => value < 0 || value > 1)) {
                        console.log(`Adjusting emissive factor from [${emissiveFactor}] to be within [0, 1]`);
                        material.setEmissiveFactor([Math.max(0, Math.min(1, emissiveFactor[0])), Math.max(0, Math.min(1, emissiveFactor[1])), Math.max(0, Math.min(1, emissiveFactor[2]))]);
                        break;
                    }
                    const baseColorFactor = material.getBaseColorFactor();
                    if (baseColorFactor.some((value) => value < 0 || value > 1)) {
                        console.log(`Adjusting base color factor from [${baseColorFactor}] to be within [0, 1]`);
                        material.setBaseColorFactor([Math.max(0, Math.min(1, baseColorFactor[0])), Math.max(0, Math.min(1, baseColorFactor[1])), Math.max(0, Math.min(1, baseColorFactor[2])), Math.max(0, Math.min(1, baseColorFactor[3]))]);
                        break;
                    }
                }
                break;
            }
            default:
                console.error(`No repair action defined for issue: ${issue.code} at ${issue.pointer}`);
        }
    }
    const restoredTexCoordAttributes = sourceUvContext
        ? restoreTexCoordsFromOriginalModel(document, sourceUvContext)
        : 0;
    const rootExtras = document.getRoot().getExtras();
    if (rootExtras?.['asobo-repair'] !== false) {
        const asoboRepairStats = applyAsoboGeometryRepair(document);
        document.getRoot().setExtras({ 'asobo-repair': asoboRepairStats });
        console.log('ASOBO primitives visited:', asoboRepairStats.primitivesVisited);
        console.log('ASOBO primitives reindexed:', asoboRepairStats.primitivesReindexed);
        console.log('Normals flipped:', asoboRepairStats.normalsFlipped);
        console.log('Tangents flipped:', asoboRepairStats.tangentsFlipped);
        console.log('Degenerate triangles dropped:', asoboRepairStats.degenerateTrianglesDropped);
        console.log('Out-of-range triangles dropped:', asoboRepairStats.outOfRangeTrianglesDropped);
        console.log('Duplicate triangles dropped:', asoboRepairStats.duplicateTrianglesDropped);
    }
    // Run structural cleanup after issue-specific and ASOBO repairs.
    await document.transform(weld(), dedup(), prune({ keepAttributes: true }), unpartition());
    // Clean up all scenes except for the default scene
    const root = document.getRoot();
    const defaultScene = root.getDefaultScene();
    for (const scene of root.listScenes()) {
        if (scene !== defaultScene) {
            scene.dispose();
        }
    }
    await io.write(options.outputPath, document);
    const errorCount = issues.filter((issue) => issue.severity === 0).length;
    console.log('Mode: repair');
    console.log('Input model:', options.modelPath);
    console.log('Issues JSON:', options.issuesJsonPath);
    console.log('Parsed issues:', issues.length);
    console.log('Errors:', errorCount);
    console.log('Source TEXCOORD attributes restored:', restoredTexCoordAttributes);
    console.log('Applied repairs: source-texcoord-restore, asobo-primitive-geometry, weld, dedup, prune(keepAttributes), unpartition');
    console.log('Wrote model:', options.outputPath);
}
async function runAssembleMode(options) {
    if (!fs.existsSync(options.sourceModelPath)) {
        throw new Error(`Source model file does not exist: ${options.sourceModelPath}`);
    }
    const io = new NodeIO();
    const sourceDocument = await io.read(options.sourceModelPath);
    var destinationDocument = new Document();
    if (fs.existsSync(options.destinationModelPath)) {
        destinationDocument = await io.read(options.destinationModelPath);
    }
    const sourceScene = sourceDocument.getRoot().listScenes()[0];
    if (!sourceScene) {
        throw new Error(`Source model has no scene: ${options.sourceModelPath}`);
    }
    const map = mergeDocuments(destinationDocument, sourceDocument);
    const mergedSourceScene = map.get(sourceScene);
    for (const child of mergedSourceScene?.listChildren() ?? []) {
        child.setMatrix(options.matrix);
    }
    await destinationDocument.transform(prune({ keepAttributes: true }));
    await io.write(options.outputPath, destinationDocument);
    console.log('Mode: assemble');
    console.log('Model to add:', options.sourceModelPath);
    console.log('Destination model:', options.destinationModelPath);
    console.log('Transformation matrix:', options.matrix);
    console.log('Wrote model:', options.outputPath);
}
async function runOptimizeMode(options) {
    if (!fs.existsSync(options.modelPath)) {
        throw new Error(`Model file does not exist: ${options.modelPath}`);
    }
    const io = new NodeIO();
    const patchedTextureCount = normalizeMsftTextureSources(options.modelPath);
    if (patchedTextureCount > 0) {
        console.log(`Patched ${patchedTextureCount} texture source references from MSFT_texture_dds.`);
    }
    const document = await io.read(options.modelPath);
    const sourceUvContext = loadSourceUvContext(options.modelPath);
    const restoredTexCoordAttributes = sourceUvContext
        ? restoreTexCoordsFromOriginalModel(document, sourceUvContext)
        : 0;
    // Apply optimization transforms.
    await document.transform(dedup(), instance(), flatten(), join(), weld(), resample(), sparse(), prune({ keepAttributes: true }), unpartition());
    await io.write(options.outputPath, document);
    console.log('Mode: optimize');
    console.log('Input model:', options.modelPath);
    console.log('Source TEXCOORD attributes restored:', restoredTexCoordAttributes);
    console.log('Applied optimizations: dedup, instance, flatten, join, weld, resample, sparse, prune(keepAttributes), unpartition');
    console.log('Wrote model:', options.outputPath);
}
//# sourceMappingURL=gltf-tools.js.map