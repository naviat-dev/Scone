#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Document, NodeIO, Scene } from '@gltf-transform/core';
import { dedup, instance, palette, flatten, join, weld, resample, prune, sparse, mergeDocuments, unpartition } from '@gltf-transform/functions';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

type CliOptions = RepairOptions | AssembleOptions | OptimizeOptions;

interface RepairOptions {
    mode: 'repair';
    modelPath: string;
    issuesJsonPath: string;
    outputPath: string;
}

interface AssembleOptions {
    mode: 'assemble';
    sourceModelPath: string;
    destinationModelPath: string;
    outputPath: string;
    position: Vec3;
    rotation: Quat;
    rotationEulerDeg: Vec3;
}

interface OptimizeOptions {
    mode: 'optimize';
    modelPath: string;
    outputPath: string;
}

interface RepairIssue {
    code: string;
    message: string;
    pointer: string;
    severity: number;
}

function printUsage(): void {
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


function parseNumber(rawValue: string, label: string): number {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
        throw new Error(`Invalid ${label}: "${rawValue}" is not a finite number.`);
    }
    return value;
}

function parseVec3(values: string[], label: string): Vec3 {
    if (values.length !== 3) {
        throw new Error(`Invalid ${label}: expected 3 numbers, received ${values.length}.`);
    }

    return [
        parseNumber(values[0], `${label}.x`),
        parseNumber(values[1], `${label}.y`),
        parseNumber(values[2], `${label}.z`),
    ];
}

function normalizeQuat([x, y, z, w]: Quat): Quat {
    const magnitude = Math.hypot(x, y, z, w);
    if (magnitude === 0) {
        return [0, 0, 0, 1];
    }

    return [x / magnitude, y / magnitude, z / magnitude, w / magnitude];
}

function eulerDegreesToQuaternionXYZ(rotationDeg: Vec3): Quat {
    const [xDeg, yDeg, zDeg] = rotationDeg;
    const x = (xDeg * Math.PI) / 180;
    const y = (yDeg * Math.PI) / 180;
    const z = (zDeg * Math.PI) / 180;

    const cx = Math.cos(x / 2);
    const sx = Math.sin(x / 2);
    const cy = Math.cos(y / 2);
    const sy = Math.sin(y / 2);
    const cz = Math.cos(z / 2);
    const sz = Math.sin(z / 2);

    return normalizeQuat([
        sx * cy * cz + cx * sy * sz,
        cx * sy * cz - sx * cy * sz,
        cx * cy * sz + sx * sy * cz,
        cx * cy * cz - sx * sy * sz,
    ]);
}

function withSuffix(filePath: string, suffix: string): string {
    const ext = path.extname(filePath);
    const base = ext.length > 0 ? filePath.slice(0, -ext.length) : filePath;
    const effectiveExt = ext.length > 0 ? ext : '.gltf';
    return `${base}.${suffix}${effectiveExt}`;
}

function parseCliArgs(args: string[]): CliOptions {
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
            throw new Error('assemble mode requires: <modelToAddPath> <destinationModelPath> <x> <y> <z> <rotXDeg> <rotYDeg> <rotZDeg> [outputPath].');
        }

        const sourceModelPath = path.resolve(args[1]);
        const destinationModelPath = path.resolve(args[2]);
        const position = parseVec3(args.slice(3, 6), 'position');
        const rotationEulerDeg = parseVec3(args.slice(6, 9), 'rotation');
        const rotation = eulerDegreesToQuaternionXYZ(rotationEulerDeg);
        const outputPath = path.resolve(args[9] ?? withSuffix(destinationModelPath, 'assembled'));

        return {
            mode,
            sourceModelPath,
            destinationModelPath,
            outputPath,
            position,
            rotation,
            rotationEulerDeg,
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

async function runRepairMode(options: RepairOptions): Promise<void> {
    if (!fs.existsSync(options.modelPath)) {
        throw new Error(`Model file does not exist: ${options.modelPath}`);
    }

    if (!fs.existsSync(options.issuesJsonPath)) {
        throw new Error(`Issues JSON file does not exist: ${options.issuesJsonPath}`);
    }

    const issues = JSON.parse(fs.readFileSync(options.issuesJsonPath, 'utf8'))["issues"]["messages"] as RepairIssue[];
    const io = new NodeIO();
    const document = await io.read(options.modelPath);

    // This may need to be rearranged in the future to be more modular as the list of supported issues grows.
    // For now, handle detected issues on a case-by-case basis.
    for (const issue of issues.filter((issue) => issue.severity === 0)) {
        switch (issue.code) {
            case 'MESH_PRIMITIVE_ATTRIBUTES_ACCESSOR_INVALID_FORMAT':
                console.log(`Repairing issue: ${issue.code} at ${issue.pointer}`);
                const pointerParts = issue.pointer.split('/');
                const attribute = document.getRoot().listMeshes()[Number(pointerParts[2])].listPrimitives()[Number(pointerParts[4])].getAttribute(pointerParts[6]);
                if (attribute) {
                    const oldArray = attribute.getArray() ?? [];
                    const sourceCount = attribute.getCount();
                    switch (pointerParts[6]) {
                        case 'POSITION':
                        case 'NORMAL':
                            const newArray = new Float32Array(3 * sourceCount);
                            for (let i = 0; i < Math.min(oldArray.length, 3 * sourceCount); i++) {
                                newArray[i] = oldArray[(i % 3) + Math.floor(i / 3) * 3];
                            }
                            const newAccessor = document.createAccessor().setType('VEC3').setArray(newArray);
                            document.getRoot().listMeshes()[Number(pointerParts[2])].listPrimitives()[Number(pointerParts[4])].setAttribute(pointerParts[6], newAccessor);
                            break;
                        case 'TANGENT':
                            const newArrayTangent = new Float32Array(4 * sourceCount);
                            for (let i = 0; i < Math.min(oldArray.length, 4 * sourceCount); i++) {
                                newArrayTangent[i] = oldArray[i];
                            }
                            const newAccessorTangent = document.createAccessor().setType('VEC4').setArray(newArrayTangent);
                            document.getRoot().listMeshes()[Number(pointerParts[2])].listPrimitives()[Number(pointerParts[4])].setAttribute(pointerParts[6], newAccessorTangent);
                            break;
                        case 'TEXCOORD_0':
                        case 'TEXCOORD_1':
                            const newArrayTexCoord = new Float32Array(2 * sourceCount);
                            for (let i = 0; i < Math.min(oldArray.length, 2 * sourceCount); i++) {
                                newArrayTexCoord[i] = oldArray[i];
                            }
                            const newAccessorTexCoord = document.createAccessor().setType('VEC2').setArray(newArrayTexCoord);
                            document.getRoot().listMeshes()[Number(pointerParts[2])].listPrimitives()[Number(pointerParts[4])].setAttribute(pointerParts[6], newAccessorTexCoord);
                            break;
                        case 'COLOR_0':
                        case 'COLOR_1':
                            const newArrayColor = new Float32Array(4 * sourceCount);
                            for (let i = 0; i < Math.min(oldArray.length, 4 * sourceCount); i++) {
                                newArrayColor[i] = oldArray[i] % 1; // Ensure values are in the range [0, 1]
                            }
                            const newAccessorColor = document.createAccessor().setType('VEC4').setArray(newArrayColor);
                            document.getRoot().listMeshes()[Number(pointerParts[2])].listPrimitives()[Number(pointerParts[4])].setAttribute(pointerParts[6], newAccessorColor);
                            break;
                        case 'JOINTS_0':
                        case 'JOINTS_1':
                            const newArrayJoints = new Uint16Array(4 * sourceCount);
                            for (let i = 0; i < Math.min(oldArray.length, 4 * sourceCount); i++) {
                                newArrayJoints[i] = oldArray[i];
                            }
                            const newAccessorJoints = document.createAccessor().setType('VEC4').setArray(newArrayJoints);
                            document.getRoot().listMeshes()[Number(pointerParts[2])].listPrimitives()[Number(pointerParts[4])].setAttribute(pointerParts[6], newAccessorJoints);
                            break;
                        case 'WEIGHTS_0':
                        case 'WEIGHTS_1':
                            const newArrayWeights = new Float32Array(4 * sourceCount);
                            for (let i = 0; i < Math.min(oldArray.length, 4 * sourceCount); i++) {
                                newArrayWeights[i] = oldArray[i];
                            }
                            const newAccessorWeights = document.createAccessor().setType('VEC4').setArray(newArrayWeights);
                            document.getRoot().listMeshes()[Number(pointerParts[2])].listPrimitives()[Number(pointerParts[4])].setAttribute(pointerParts[6], newAccessorWeights);
                            break;
                        default:
                            console.error(`No repair action defined for attribute: ${pointerParts[6]}`);
                            continue;
                    }
                }
                break;
            case 'MESH_PRIMITIVE_UNEQUAL_ACCESSOR_COUNT':
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
            default:
                console.error(`No repair action defined for issue: ${issue.code} at ${issue.pointer}`);
        }
    }
    await io.write(options.outputPath, document);

    const errorCount = issues.filter((issue) => issue.severity === 0).length;

    console.log('Mode: repair');
    console.log('Input model:', options.modelPath);
    console.log('Issues JSON:', options.issuesJsonPath);
    console.log('Parsed issues:', issues.length);
    console.log('Errors:', errorCount);
    console.log('Applied repairs: dedup, prune, unpartition');
    console.log('Wrote model:', options.outputPath);
}

function getOrCreatePrimaryScene(document: Document): Scene {
    const root = document.getRoot();
    const existingScene = root.listScenes()[0];
    if (existingScene) {
        return existingScene;
    }

    return document.createScene('Scene');
}

function attachMergedSceneAtTransform(
    destinationDocument: Document,
    mergedSourceScene: Scene | undefined,
    sourceModelPath: string,
    position: Vec3,
    rotation: Quat,
): void {
    if (!mergedSourceScene) {
        throw new Error('Unable to locate merged source scene in destination document.');
    }

    const destinationScene = getOrCreatePrimaryScene(destinationDocument);
    const instanceName = path.basename(sourceModelPath, path.extname(sourceModelPath)) || 'assembled-model';

    const placementNode = destinationDocument
        .createNode(`${instanceName}-placement`)
        .setTranslation(position)
        .setRotation(rotation);

    const sceneChildren = [...mergedSourceScene.listChildren()];
    for (const child of sceneChildren) {
        placementNode.addChild(child);
    }

    destinationScene.addChild(placementNode);
    mergedSourceScene.dispose();
}

async function runAssembleMode(options: AssembleOptions): Promise<void> {
    if (!fs.existsSync(options.sourceModelPath)) {
        throw new Error(`Source model file does not exist: ${options.sourceModelPath}`);
    }

    if (!fs.existsSync(options.destinationModelPath)) {
        throw new Error(`Destination model file does not exist: ${options.destinationModelPath}`);
    }

    const io = new NodeIO();
    const sourceDocument = await io.read(options.sourceModelPath);
    const destinationDocument = await io.read(options.destinationModelPath);

    const sourceScene = sourceDocument.getRoot().listScenes()[0];
    if (!sourceScene) {
        throw new Error(`Source model has no scene: ${options.sourceModelPath}`);
    }

    const map = mergeDocuments(destinationDocument, sourceDocument);
    const mergedSourceScene = map.get(sourceScene) as Scene | undefined;

    attachMergedSceneAtTransform(
        destinationDocument,
        mergedSourceScene,
        options.sourceModelPath,
        options.position,
        options.rotation,
    );

    await destinationDocument.transform(prune());
    await io.write(options.outputPath, destinationDocument);

    console.log('Mode: assemble');
    console.log('Model to add:', options.sourceModelPath);
    console.log('Destination model:', options.destinationModelPath);
    console.log('Position:', options.position.join(', '));
    console.log('Euler rotation XYZ (deg):', options.rotationEulerDeg.join(', '));
    console.log('Quaternion XYZW:', options.rotation.join(', '));
    console.log('Wrote model:', options.outputPath);
}

async function runOptimizeMode(options: OptimizeOptions): Promise<void> {
    if (!fs.existsSync(options.modelPath)) {
        throw new Error(`Model file does not exist: ${options.modelPath}`);
    }

    const io = new NodeIO();
    const document = await io.read(options.modelPath);

    // Apply optimization transforms.
    await document.transform(dedup(), instance(), palette(), flatten(), join(), weld(), resample(), sparse(), prune(), unpartition());
    await io.write(options.outputPath, document);

    console.log('Mode: optimize');
    console.log('Input model:', options.modelPath);
    console.log('Applied optimizations: dedup, instance, palette, flatten, join, weld, resample, sparse, prune, unpartition');
    console.log('Wrote model:', options.outputPath);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printUsage();
        process.exit(0);
    }

    if (args.length === 0) {
        printUsage();
        process.exit(2);
    }

    const options = parseCliArgs(args);

    if (options.mode === 'repair') {
        await runRepairMode(options);
        return;
    } else if (options.mode === 'assemble') {
        await runAssembleMode(options);
        return;
    } else if (options.mode === 'optimize') {
        await runOptimizeMode(options);
        return;
    }
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`gltf-repair failed: ${message}`);
    if (error instanceof Error && error.stack) {
        console.error(error.stack);
    }
    process.exit(1);
});

