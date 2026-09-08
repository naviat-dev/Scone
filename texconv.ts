import fs from 'fs';
import path from 'path';

export function convertToDDS(inputFilePath: string, outputFilePath: string) {
	const type = path.extname(inputFilePath);
	const pixelArray: number[][][] = [];
	switch (type.toLowerCase()) {
		case '.png':
			pixelArray.push(...convertPNGtoArray(fs.readFileSync(inputFilePath)));
			break;
		case '.kxt':
		case '.kxt2':
			pixelArray.push(...convertKXTtoArray(fs.readFileSync(inputFilePath)));
			break;
		default:
			throw new Error(`Unsupported file type: ${type}`);
	}
}

function convertPNGtoArray(inputBuffer: Buffer): number[][][] {
	return [];
}

function convertKXTtoArray(inputBuffer: Buffer): number[][][] {
	return [];
}