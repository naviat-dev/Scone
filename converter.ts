import { getTileIndexFromCoord, getCoordFromTileIndex, getAltitude } from './terrain.ts';
import * as fs from 'fs';
import * as path from 'path';

export function convertScenery(inputPath, outputPath, isGltf, isAc3d) {
	if (!fs.existsSync(inputPath)) {
		throw new Error(`Input path does not exist: ${inputPath}`);
	}

	const allBglFiles = fs.readdirSync(inputPath).filter(file => path.extname(file).toLowerCase() === '.bgl');
	let totalLibraryObjects = 0;
	for (const file of allBglFiles) {
		console.log(`Processing file: ${file}`);
		const fileBuffer: ArrayBuffer = fs.readFileSync(file).buffer;
		const fileView = new DataView(fileBuffer);
	}
}