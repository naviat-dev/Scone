#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NodeIO } from '@gltf-transform/core';

function printUsage(): void {
    console.log('Usage: gltf-repair <input.gltf|input.glb> <output.gltf|output.glb>');
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        printUsage();
        process.exit(0);
    }

    if (args.length !== 2) {
        printUsage();
        process.exit(2);
    }

    const inputPath = path.resolve(args[0]);
    const outputPath = path.resolve(args[1]);

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file does not exist: ${inputPath}`);
        process.exit(1);
    }

    const outputDirectory = path.dirname(outputPath);
    if (!fs.existsSync(outputDirectory)) {
        fs.mkdirSync(outputDirectory, { recursive: true });
    }

    const io = new NodeIO();
    const document = await io.read(inputPath);
    await io.write(outputPath, document);

    console.log('Loaded model:', inputPath);
    console.log('Exported glTF:', outputPath);
    console.log('Scenes:', document.getRoot().listScenes().length);
    console.log('Nodes:', document.getRoot().listNodes().length);
    console.log('Meshes:', document.getRoot().listMeshes().length);
    console.log('Materials:', document.getRoot().listMaterials().length);
    console.log('Textures:', document.getRoot().listTextures().length);
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`gltf-repair failed: ${message}`);
    if (error instanceof Error && error.stack) {
        console.error(error.stack);
    }
    process.exit(1);
});

