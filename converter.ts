import { getTileIndexFromCoord, getCoordFromTileIndex, getAltitude } from './terrain.ts';
import * as fs from 'fs';
import * as path from 'path';

export function convertScenery(inputPath: string, outputPath: string, isGltf: boolean, isAc3d: boolean): void {
	if (!fs.existsSync(inputPath)) {
		throw new Error(`Input path does not exist: ${inputPath}`);
	}

	const allBglFiles: string[] = fs.readdirSync(inputPath).filter((file: string): boolean => path.extname(file).toLowerCase() === '.bgl');
	let totalLibraryObjects: number = 0;
	for (const file of allBglFiles) {
		console.log(`Processing file: ${file}`);
		const fileBuffer: ArrayBuffer = fs.readFileSync(file).buffer;
		const fileView: DataView = new DataView(fileBuffer);
	}
}