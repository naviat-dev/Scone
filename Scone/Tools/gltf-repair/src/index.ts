#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Document, NodeIO, Scene } from '@gltf-transform/core';
import { dedup, mergeDocuments, prune, unpartition } from '@gltf-transform/functions';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

type CliOptions = RepairOptions | AssembleOptions;

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

interface RepairIssue {
    code: string;
    message: string;
    pointer: string;
    severity: string;
}

function printUsage(): void {
    console.log([
        'Usage:',
        '  gltf-repair repair <modelPath> <issues.json> [outputPath]',
        '  gltf-repair assemble <modelToAddPath> <destinationModelPath> <x> <y> <z> <rotXDeg> <rotYDeg> <rotZDeg> [outputPath]',
        '',
        'Notes:',
        '  - repair mode reads validator issues JSON and applies baseline structural cleanup transforms.',
        '  - assemble mode merges modelToAdd into destinationModel and places it using translation + Euler rotation (degrees, XYZ order).',
    ].join('\n'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
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

function assertFileExists(filePath: string, kind: string): void {
    if (!fs.existsSync(filePath)) {
        throw new Error(`${kind} file does not exist: ${filePath}`);
    }
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

    throw new Error(`Unsupported mode "${args[0]}". Expected "repair" or "assemble".`);
}

function normalizeSeverity(value: unknown): string {
    if (typeof value === 'number') {
        return String(value);
    }

    if (typeof value === 'string') {
        return value.trim().toLowerCase();
    }

    return '';
}

function normalizeIssue(input: unknown): RepairIssue {
    if (!isRecord(input)) {
        return { code: '', message: '', pointer: '', severity: '' };
    }

    const code = typeof input.code === 'string' ? input.code : '';
    const message = typeof input.message === 'string' ? input.message : '';
    const pointer = typeof input.pointer === 'string' ? input.pointer : '';
    const severity = normalizeSeverity(input.severity);

    return { code, message, pointer, severity };
}

function parseIssuesFromJson(payload: unknown): RepairIssue[] {
    if (Array.isArray(payload)) {
        return payload.map(normalizeIssue);
    }

    if (!isRecord(payload)) {
        return [];
    }

    if (isRecord(payload.issues) && Array.isArray(payload.issues.messages)) {
        return payload.issues.messages.map(normalizeIssue);
    }

    if (Array.isArray(payload.messages)) {
        return payload.messages.map(normalizeIssue);
    }

    if (Array.isArray(payload.errors)) {
        return payload.errors.map(normalizeIssue);
    }

    return [];
}

function readRepairIssues(issuesJsonPath: string): RepairIssue[] {
    const raw = fs.readFileSync(issuesJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parseIssuesFromJson(parsed);
}

async function runRepairMode(options: RepairOptions): Promise<void> {
    assertFileExists(options.modelPath, 'Model');
    assertFileExists(options.issuesJsonPath, 'Issues JSON');

    const issues = readRepairIssues(options.issuesJsonPath);
    const io = new NodeIO();
    const document = await io.read(options.modelPath);

    // Conservative cleanup transforms that often resolve duplicate/orphan resource issues.
    await document.transform(dedup(), prune(), unpartition());
    await io.write(options.outputPath, document);

    const errorCount = issues.filter((issue) => issue.severity === 'error').length;
    const warningCount = issues.filter((issue) => issue.severity === 'warning').length;

    console.log('Mode: repair');
    console.log('Input model:', options.modelPath);
    console.log('Issues JSON:', options.issuesJsonPath);
    console.log('Parsed issues:', issues.length);
    console.log('Errors:', errorCount);
    console.log('Warnings:', warningCount);
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
    assertFileExists(options.sourceModelPath, 'Source model');
    assertFileExists(options.destinationModelPath, 'Destination model');

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
    }

    await runAssembleMode(options);
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`gltf-repair failed: ${message}`);
    if (error instanceof Error && error.stack) {
        console.error(error.stack);
    }
    process.exit(1);
});

