import { dummyTexturePath } from './assets.js';
import { getTileIndexFromCoord, getCoordFromTileIndex, getFilePathFromTileIndex, getAltitude } from './terrain.js';
import { PlacementObject, LibraryObject, SimObject, Flags, Airport, Tower, Runway, RunwayStart, TaxiwayPoint, TaxiwayParking, TaxiwayPath, TaxiwayPathType, Apron, TaxiwaySign, PaintedLine, PaintedHatchedArea, ApronEdgeLights, Helipad, ProjectedMesh, ModelReference } from './structures.js'
import { config } from './config.js';
import { applyAsoboGeometryRepair, repairDocument } from './repair.js';
import { convertToDDS } from './texconv.js'
import * as fs from 'fs';
import * as path from 'path';
import { totalmem } from 'node:os';
import { create } from 'xmlbuilder2';
import { vec3, quat } from 'gl-matrix';
import { Document, NodeIO, PropertyType, Scene } from '@gltf-transform/core';
import { dedup, flatten, weld, resample, prune, unpartition, mergeDocuments } from '@gltf-transform/functions';
import { DOMParser } from "@xmldom/xmldom";
// @ts-expect-error gltf-validator does not provide TypeScript declarations.
import validator from 'gltf-validator';
import type { ConversionProgressItem, ConversionProgressState } from './task-types.js';
import { decompress } from 'fzstd';


export type ConversionAbortMode = 'save' | 'discard';

export type ConversionControl = {
	conversionId?: string;
	shouldAbort?: () => ConversionAbortMode | null;
	onStatus?: (status: string) => void;
	onProgress?: (progressItems: ConversionProgressItem[]) => void;
};

export class ConversionAbortedError extends Error {
	public readonly mode: ConversionAbortMode;

	constructor(mode: ConversionAbortMode) {
		super(`Conversion aborted (${mode})`);
		this.name = 'ConversionAbortedError';
		this.mode = mode;
	}
}

// progressItems holds the state of every model being repaired and added
// When a model begins processing, it finds the first task that is pending and makes that one its own
// When it has finished processing, or fails processing, it adjusts the status of its task and exits
interface ConversionInformation {
	readonly id: string;
	readonly inputPath: string;
	readonly outputPath: string;
	readonly logPath: string;
	readonly progressItems: ConversionProgressItem[];
	readonly placements: PlacementObject[];
	status: string;
}

export const conversions: Record<string, ConversionInformation> = {};

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;
const MEMORY_CHECK_INTERVAL = 64;
let memoryCheckCount = 0;
let heapUsedAfterLastCollection = 0;
let rssAfterLastCollection = 0;

function collectConversionGarbageIfNeeded(force = false): void {
	if (typeof global.gc !== 'function') {
		return;
	}
	if (!force && ++memoryCheckCount < MEMORY_CHECK_INTERVAL) {
		return;
	}
	memoryCheckCount = 0;

	const before = process.memoryUsage();
	const heapGrowth = before.heapUsed - heapUsedAfterLastCollection;
	const rssGrowth = before.rss - rssAfterLastCollection;
	if (!force && (
		(before.heapUsed < GIBIBYTE && before.rss < totalmem() / 4)
		|| (heapGrowth < 256 * MEBIBYTE && rssGrowth < 512 * MEBIBYTE)
	)) {
		return;
	}

	global.gc();
	const after = process.memoryUsage();
	heapUsedAfterLastCollection = after.heapUsed;
	rssAfterLastCollection = after.rss;
	const reclaimedMiB = Math.max(0, before.heapUsed - after.heapUsed) / MEBIBYTE;
	if (reclaimedMiB >= 256) {
		console.info(`Memory maintenance reclaimed ${Math.round(reclaimedMiB)} MiB from the JavaScript heap.`);
	}
}

function getConversion(id: string): ConversionInformation {
	const conversion = conversions[id];
	if (!conversion) {
		throw new Error(`Conversion ${id} is not registered.`);
	}
	return conversion;
}

function reportStatus(id: string, control: ConversionControl | undefined, status: string): void {
	getConversion(id).status = status;
	control?.onStatus?.(status);
	collectConversionGarbageIfNeeded();
}

function reportProgress(id: string, control: ConversionControl | undefined): void {
	if (!control?.onProgress) {
		return;
	}

	control.onProgress(getConversion(id).progressItems.map((item) => ({ ...item })));
}

function setProgressState(
	id: string,
	control: ConversionControl | undefined,
	index: number,
	state: ConversionProgressState,
): void {
	if (index < 0) {
		return;
	}

	getConversion(id).progressItems[index].state = state;
	reportProgress(id, control);
}

function getProgressSize(filePath: string, description: string): number {
	if (!filePath) {
		console.warn(`Unable to determine progress size for ${description}: no source file was resolved.`);
		return 1;
	}

	try {
		const fileStats = fs.statSync(filePath);
		if (!fileStats.isFile()) {
			console.warn(`Unable to determine progress size for ${description}: ${filePath} is not a file.`);
			return 1;
		}
		return Math.max(fileStats.size, 1);
	} catch (error) {
		console.warn(`Unable to determine progress size for ${description}: ${filePath}`, error);
		return 1;
	}
}

function checkAbort(control: ConversionControl | undefined): void {
	const mode = control?.shouldAbort?.() ?? null;
	if (mode) {
		throw new ConversionAbortedError(mode);
	}
}

function getViewBytes(fileView: DataView, address: number, length: number): Uint8Array {
	return new Uint8Array(fileView.buffer, fileView.byteOffset + address, length);
}

async function buildLibraryObject(fileView: DataView, address: number): Promise<LibraryObject> {
	const longitude = (fileView.getInt32(address + 4, true) * (360.0 / 805306368.0)) - 180.0;
	const latitude = 90.0 - (fileView.getInt32(address + 8, true) * (180.0 / 536870912.0));
	let altitude = fileView.getInt32(address + 12, true) / 1000;
	const flags = Object.values(Flags)
		.filter((value): value is number => typeof value === 'number')
		.filter(value => (fileView.getInt16(address + 16, true) & (1 << value)) !== 0);
	const pitch = fileView.getInt16(address + 18, true) * (360.0 / 65536.0);
	const bank = fileView.getInt16(address + 20, true) * (360.0 / 65536.0);
	const heading = fileView.getInt16(address + 22, true) * (360.0 / 65536.0);
	const imageComplexity = fileView.getUint16(address + 24, true);
	const guid = getGuidFromBytes(getViewBytes(fileView, address + 44, 16));
	const scale = fileView.getFloat32(address + 60, true);
	if (flags.includes(Flags.IsAboveAGL)) {
		altitude += await getAltitude(latitude, longitude, 2);
	}
	return { position: [longitude, latitude, altitude], flags, orientation: [pitch, bank, heading], imageComplexity, guid, scale };
}

async function buildSimObject(fileView: DataView, address: number, inputPath: string, configPathsByTitle: Map<string, string[]>): Promise<SimObject> {
	const longitude = (fileView.getInt32(address + 4, true) * (360.0 / 805306368.0)) - 180.0;
	const latitude = 90.0 - (fileView.getInt32(address + 8, true) * (180.0 / 536870912.0));
	let altitude = fileView.getInt32(address + 12, true) / 1000;
	const flags = Object.values(Flags)
		.filter((value): value is number => typeof value === 'number')
		.filter(value => (fileView.getInt16(address + 16, true) & (1 << value)) !== 0);
	const pitch = fileView.getInt16(address + 18, true) * (360.0 / 65536.0);
	const bank = fileView.getInt16(address + 20, true) * (360.0 / 65536.0);
	const heading = fileView.getInt16(address + 22, true) * (360.0 / 65536.0);
	const imageComplexity = fileView.getUint16(address + 24, true);
	const scale = fileView.getFloat32(address + 44, true);
	const containerTitleLength = fileView.getUint16(address + 48, true);
	const containerPathLength = fileView.getUint16(address + 50, true);
	const containerTitle = new TextDecoder().decode(getViewBytes(fileView, address + 52, containerTitleLength));
	let containerPath = new TextDecoder().decode(getViewBytes(fileView, address + 52 + containerTitleLength, containerPathLength));
	if (flags.includes(Flags.IsAboveAGL)) {
		altitude += await getAltitude(latitude, longitude, 2);
	}
	// Attempt to resolve the absolute path of the sim.cfg file
	const matches = configPathsByTitle.get(containerTitle) ?? [];
	let mostLikelyMatchScore = -1;
	let mostLikelyMatch: string = '';
	for (const match of matches) {
		let i: number = 0;
		while (i < match.length && i < inputPath.length && match[i] === inputPath[i]) {
			i++;
		}
		if (i > mostLikelyMatchScore) {
			mostLikelyMatchScore = i;
			mostLikelyMatch = match;
		}
	}
	containerPath = fs.existsSync(mostLikelyMatch) ? mostLikelyMatch : containerPath;
	let simObj: SimObject = {
		position: [longitude, latitude, altitude],
		flags,
		orientation: [pitch, bank, heading],
		imageComplexity,
		containerTitle,
		containerPath,
		scale,
		model: '',
		texture: '',
		xmlPath: '',
		gltfPath: '',
		binPath: '',
	}

	// Fill in additional helper properties for progress indication
	if (!fs.existsSync(containerPath)) {
		if (containerPath !== '') {
			console.warn(`Container path does not exist: ${containerPath}`);
		}
		return simObj;
	}
	const containerFolder: string = path.dirname(containerPath);
	const containerText: string = fs.readFileSync(containerPath, 'utf-8');
	const simObjRegex: RegExp = new RegExp(`title=${containerTitle}(?:\r\n|\r|\n)model=(.*)(?:\r\n|\r|\n)texture=(.*)`, 'i');
	const simObjMatch: RegExpExecArray | null = simObjRegex.exec(containerText);
	if (simObjMatch == null) {
		console.warn(`Unable to find model/texture for sim object ${containerTitle} in ${mostLikelyMatch}`);
		return simObj;
	}
	let modelIndex: string = simObjMatch[1].trim();
	if (modelIndex !== '') {
		modelIndex = `.${modelIndex}`
	}
	let textureIndex: string = simObjMatch[2].trim();
	if (textureIndex !== '') {
		textureIndex = `.${textureIndex}`
	}
	const modelCfgPath: string = path.join(containerFolder, `model${modelIndex}`, 'model.CFG');
	if (!fs.existsSync(modelCfgPath)) {
		console.warn(`Model CFG does not exist for model ${containerTitle}: ${modelCfgPath}`);
		return simObj;
	}
	const xmlNames = fs.readFileSync(modelCfgPath, 'utf-8').split('\n').filter(line => line.trim().startsWith('normal=') && line.trim().endsWith('.xml'));
	if (xmlNames.length === 0) {
		console.warn(`No XML name found in model CFG for model ${containerTitle}: ${modelCfgPath}`);
		return simObj;
	}
	const xmlName = xmlNames[0].split('=')[1].trim();
	const xmlPath = path.resolve(path.join(containerFolder, `model${modelIndex}`, xmlName).replace(/\\/g, path.sep).replace(/\//g, path.sep));
	if (!fs.existsSync(xmlPath)) {
		console.warn(`XML file does not exist for model ${containerTitle}: ${xmlPath}`);
		return simObj;
	}
	let xmlDoc = null;
	try {
		xmlDoc = new DOMParser().parseFromString(fs.readFileSync(xmlPath, 'utf-8').trim(), 'application/xml');
	} catch (error) {
		console.warn(`Failed to parse XML for model ${containerTitle}: ${xmlPath}`);
		return simObj;
	}
	const lodsRoot = xmlDoc.getElementsByTagName('LODS')[0];
	if (!lodsRoot) {
		console.warn(`No LODS section found for model ${containerTitle}: ${xmlPath}`);
		return simObj;
	}
	const lods = lodsRoot.getElementsByTagName('LOD');
	if (!lods || lods.length === 0) {
		console.warn(`No LOD entries found for model ${containerTitle}: ${xmlPath}`);
		return simObj;
	}
	let maxLod: number = -1;
	let gltfPath: string = '';
	for (let lodIndex = 0; lodIndex < lods.length; lodIndex++) {
		const lod = lods.item(lodIndex);
		if (!lod) {
			continue;
		}
		const lodLevel = parseInt(lod.getAttribute('MinSize') || '0', 10);
		if (lodLevel > maxLod) {
			maxLod = lodLevel;
			gltfPath = lod.getAttribute('ModelFile') || '';
		}
		if (maxLod === 0) {
			break;
		}
	}
	const gltfJsonPath: string = path.resolve(path.join(path.dirname(xmlPath), gltfPath));
	if (!fs.existsSync(gltfJsonPath) || gltfPath === '') {
		console.warn(`GLTF JSON file does not exist for model ${containerTitle}: ${gltfJsonPath}`);
		return simObj;
	}
	simObj.gltfPath = gltfJsonPath;
	const json = JSON.parse(fs.readFileSync(gltfJsonPath, 'utf-8'));
	const binaryBufferName: string = (json.buffers as Array<{ uri: string }>)[0].uri;
	const binBufferPath: string = path.resolve(path.join(path.dirname(gltfJsonPath), binaryBufferName));
	if (!fs.existsSync(binBufferPath) || binaryBufferName === '') {
		console.warn(`Binary buffer file does not exist for model ${containerTitle}: ${binBufferPath}`);
		return simObj;
	}
	simObj.binPath = binBufferPath;
	return simObj;
}

function convertIcaoBytesToString(icaoBytes: number): string {
	let sb: string[] = [];
	icaoBytes >>= 5;
	while (icaoBytes > 1) {
		let charVal = icaoBytes % 38;
		icaoBytes = (icaoBytes - charVal) / 38;
		const c = charVal == 0 ? ' ' :
			charVal > 1 && charVal < 12 ? String.fromCharCode('0'.charCodeAt(0) + charVal - 2) :
				String.fromCharCode('A'.charCodeAt(0) + charVal - 12);
		sb.unshift(c);
	}
	return sb.join('');
}

function getGuidFromBytes(guidBytes: Uint8Array): string {
	return Array.from(guidBytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function readFourCC(buffer: Uint8Array, offset: number): string {
	if (offset < 0 || offset + 4 > buffer.length) {
		return '';
	}
	return Buffer.from(buffer.subarray(offset, offset + 4)).toString('ascii');
}

function getFilesRecursive(dir: string, extension: string, caseSensitive: boolean): string[] {
	const result: string[] = [];
	const files = fs.readdirSync(dir);
	for (const file of files) {
		const fullPath = path.join(dir, file);
		if (fs.statSync(fullPath).isDirectory()) {
			result.push(...getFilesRecursive(fullPath, extension, caseSensitive));
		} else if ((caseSensitive ? path.extname(fullPath) === extension : path.extname(fullPath).toLowerCase() === extension.toLowerCase())) {
			result.push(fullPath);
		}
	}
	return result;
}

function resolveAbsoluteTexturePath(inputPath: string, file: string, textureUri: string): string {
	textureUri = textureUri.replace(/\\/g, path.sep).replace(/\//g, path.sep);
	const fileName: string = path.basename(textureUri);
	let mostLikelyMatch: string = "";
	const extension = path.extname(fileName);
	const imageMatches: string[] = extension.length > 0
		? getFilesRecursive(inputPath, extension, false)
			.filter((match) => path.basename(match).toLowerCase() === fileName.toLowerCase())
		: [];
	let mostLikelyMatchScore = -1;
	for (const match of imageMatches) {
		let i: number = 0;
		while (i < match.length && i < file.length && match[i] === file[i]) {
			i++;
		}
		if (i > mostLikelyMatchScore) {
			mostLikelyMatchScore = i;
			mostLikelyMatch = match;
		}
	}
	return mostLikelyMatch;
}

function findCaseInsensitive(inputPath: string): string | null {
	const absolutePath = path.resolve(inputPath);
	const parsed = path.parse(absolutePath);

	let current = parsed.root;

	for (const part of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		if (!fs.existsSync(current)) {
			return null;
		}

		const match = fs.readdirSync(current).find(
			entry => entry.toLowerCase() === part.toLowerCase()
		);

		if (!match) {
			return null;
		}

		current = path.join(current, match);
	}

	return current;
}

function requireRange(data: Buffer, offset: number, length: number, label: string) {
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > data.length) {
		throw new Error(`Truncated ${label}`);
	}
}

function zstdFrameLength(data: Buffer) {
	requireRange(data, 0, 5, 'Zstandard frame header');
	if (data.readUInt32LE(0) !== 0xfd2fb528) throw new Error('Not a Zstandard frame');
	const descriptor = data[4];
	if (descriptor & 8) throw new Error('Reserved Zstandard header bit set');
	const singleSegment = (descriptor & 32) !== 0;
	const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >>> 6];
	let cursor = 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + contentSizeBytes;
	requireRange(data, 0, cursor, 'Zstandard frame header');
	let last = false;
	while (!last) {
		requireRange(data, cursor, 3, 'Zstandard block header');
		const header = data.readUIntLE(cursor, 3);
		cursor += 3;
		last = (header & 1) !== 0;
		const type = (header >>> 1) & 3;
		if (type === 3) throw new Error('Reserved Zstandard block type');
		const blockBytes = type === 1 ? 1 : header >>> 3;
		requireRange(data, cursor, blockBytes, 'Zstandard block');
		cursor += blockBytes;
	}
	if (descriptor & 4) {
		requireRange(data, cursor, 4, 'Zstandard checksum');
		cursor += 4;
	}
	return cursor;
}

async function assembleModel(id: string, inputPath: string, outputPath: string, tileIndex: number, modelReferences: any[], center: vec3, libraryObjects: Map<string, LibraryObject[]>, control?: ConversionControl) {
	const tempTilePath = path.join(config.tempDir, `tile_${tileIndex}_${Date.now()}`);
	fs.mkdirSync(tempTilePath, { recursive: true });
	const tileDocument: Document = new Document();

	try {
		for (let modelRef of modelReferences) {
			const taskIndex = getConversion(id).progressItems.findIndex(item => item.state === 'pending');
			try {
				setProgressState(id, control, taskIndex, 'running');
				let json: Record<string, unknown> = {};
				let binary: Buffer<ArrayBuffer> = Buffer.alloc(0);
				let name: string = '';
				let guid: string = '';
				const libraryObjectsForModel: (LibraryObject | SimObject)[] = [];

				if (modelRef.guid !== undefined && modelRef.file !== undefined && modelRef.offset !== undefined && modelRef.size !== undefined) {
					modelRef = modelRef as ModelReference;
					guid = modelRef.guid;
					const modelFileBuffer = fs.readFileSync(modelRef.file);
					if (modelRef.offset < 0 || modelRef.offset + modelRef.size > modelFileBuffer.byteLength) {
						console.warn(`Model reference out of bounds for ${modelRef.file}: offset=0x${modelRef.offset.toString(16)} size=${modelRef.size}`);
						continue;
					}
					const fileBuffer = modelFileBuffer.subarray(modelRef.offset, modelRef.offset + modelRef.size);
					const fileView: DataView = new DataView(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);
					console.debug(`Model reference: ${modelRef.file} at offset 0x${modelRef.offset.toString(16)} size ${modelRef.size} guid ${modelRef.guid}`);
					const chunkID: string = readFourCC(fileBuffer, 0);
					if (chunkID !== 'RIFF') {
						continue;
					}
					for (let i = 8; i + 8 <= fileBuffer.byteLength; i += 4) {
						const chunk = readFourCC(fileBuffer, i);
						let glbIndex = 0; // for unique filenames per GLB in this chunk
						if (chunk === 'GXML') {
							const size: number = fileView.getUint32(i + 4, true);
							if (i + 8 + size > fileBuffer.byteLength) {
								console.warn(`Invalid GXML chunk size ${size} for model ${modelRef.guid}`);
								break;
							}

							const gxmlContent = Buffer.from(fileBuffer.subarray(i + 8, i + 8 + size)).toString('utf-8');
							try {
								create(gxmlContent);
								const match = /<ModelInfo[^>]*name="([^"]+)"/i.exec(gxmlContent);
								name = match?.[1]?.replace(/\.gltf$/i, '').replace(/ /g, '_') ?? 'Unnamed_Model';
							} catch (error) {
								console.error(`Failed to process GXML chunk at offset 0x${i.toString(16)} in file: ${modelRef.file}`, error);
							}
							i += size;
						} else if (chunk === 'GLBD') {
							if (glbIndex >= 1) {
								console.info(`More than one LOD present for ${name}; skipping remaining GLB in chunk.`);
								glbIndex = 0;
								// The highest LOD is the first GLB; break after processing it
								break;
							}

							reportStatus(id, control, `Converting ${name || modelRef.guid}...`);
							console.info(`Processing GLBD chunk for model ${name} (${modelRef.guid}) in ${modelRef.file}`);
							const size: number = fileView.getUint32(i + 4, true);
							// Scan GLBD payload and skip past each GLB block once processed
							for (let j = i + 8; j < i + 8 + size;) {
								checkAbort(control);
								// Ensure there are at least 8 bytes for type + size
								if (j + 8 > fileBuffer.byteLength) {
									break;
								}

								const sig: string = readFourCC(fileBuffer, j);
								let glbBytes: Buffer = Buffer.alloc(0);
								let glbSize: number = 0;
								if (sig === 'GLB\0') {
									glbSize = fileView.getUint32(j + 4, true);
									if (j + 8 + glbSize > fileBuffer.byteLength) {
										console.warn(`Invalid GLB payload size ${glbSize} for model ${modelRef.guid}`);
										break;
									}
									glbBytes = fileBuffer.subarray(j + 8, j + 8 + glbSize);
								} else if (sig === 'GLBZ') {
									if (glbIndex >= 1) {
										console.info(`More than one LOD present for ${name}; skipping remaining GLB in chunk.`);
										glbIndex = 0;
										// The highest LOD is the first GLB; break after processing it
										break;
									}

									reportStatus(id, control, `Converting ${name || modelRef.guid}...`);
									console.info(`Processing GLBZ chunk for model ${name} (${modelRef.guid}) in ${modelRef.file}`);
									const size: number = fileView.getUint32(j + 4, true) - 4;
									let compressedData = new Uint8Array(fileBuffer.subarray(j + 12, j + 12 + size));
									if (size < 4) {
										throw new Error('GLBZ missing uncompressed size');
									}
									const expectedLength = fileView.getUint32(j + 8, true);
									// Prototype limit; a production implementation should use project policy.
									if (expectedLength < 20 || expectedLength > 256 * 1024 * 1024) {
										throw new Error('Invalid GLBZ uncompressed size');
									}
									const frameAndPadding = fileBuffer.subarray(j + 12, j + 12 + size);
									const frameLength = zstdFrameLength(frameAndPadding);
									let padding = frameAndPadding.length - frameLength;
									if (padding > 3 || frameAndPadding.subarray(frameLength).some(byte => byte !== 0)) {
										throw new Error('Unexpected data after Zstandard frame');
									}
									const decompressedData: Uint8Array = decompress(frameAndPadding.subarray(0, frameLength));
									if (decompressedData.length !== expectedLength) {
										throw new Error('GLBZ uncompressed size mismatch');
									}
									glbBytes = Buffer.from(decompressedData);
									glbSize = glbBytes.length;
								} else {
									j += 4;
								}
								if (glbBytes.length !== 0) {
									const glbView = new DataView(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength);

									if (glbBytes.byteLength < 0x14) {
										j += 8 + glbSize;
										continue;
									}

									// Fill the end of the JSON chunk with spaces, and replace non-printable characters with spaces.
									const jsonLength: number = glbView.getUint32(0x0C, true);
									const jsonStart = 0x14;
									const jsonEnd = jsonStart + jsonLength;
									if (jsonEnd > glbBytes.byteLength) {
										console.warn(`GLB JSON chunk exceeds payload bounds for model ${modelRef.guid}`);
										j += 8 + glbSize;
										continue;
									}

									const binChunkHeader = jsonEnd;
									if (binChunkHeader + 8 > glbBytes.byteLength) {
										console.warn(`GLB missing BIN chunk for model ${modelRef.guid}`);
										j += 8 + glbSize;
										continue;
									}

									const jsonBytes = glbBytes.subarray(jsonStart, jsonEnd);
									for (let k = 0; k < jsonBytes.length; k++) {
										if (jsonBytes[k] < 32 || jsonBytes[k] > 126) {
											jsonBytes[k] = 32; // replace non-printable characters with space
										}
									}

									const binChunkLength = glbView.getUint32(binChunkHeader, true);
									const binStart = binChunkHeader + 8;
									const binEnd = binStart + binChunkLength;
									if (binEnd > glbBytes.byteLength) {
										console.warn(`GLB BIN chunk exceeds payload bounds for model ${modelRef.guid}`);
										j += 8 + glbSize;
										continue;
									}

									json = JSON.parse(Buffer.from(jsonBytes).toString('utf-8').trim());
									binary = Buffer.from(glbBytes.subarray(binStart, binEnd));
									j += 8 + glbSize;
									break;
								}
							}
							glbIndex++;
							i += size;
						}
					}
					libraryObjectsForModel.push(...libraryObjects.get(guid) || []);
				} else if (fs.existsSync(modelRef.gltfPath) && fs.existsSync(modelRef.binPath)) {
					modelRef = modelRef as SimObject;
					name = modelRef.containerTitle;
					json = JSON.parse(fs.readFileSync(modelRef.gltfPath, 'utf-8').trim());
					binary = fs.readFileSync(modelRef.binPath);
					const containerFolder = path.dirname(modelRef.containerPath);
					for (const image of (json.images || []) as Array<any>) {
						// Look for the texture files in either possible texture directory
						if (!image || typeof image !== 'object') {
							continue;
						}

						let uri: string = typeof image.uri === 'string' ? image.uri : '';
						uri = decodeURIComponent(uri.replace(/\\/g, path.sep).replace(/\//g, path.sep));
						if (uri.length === 0) {
							continue;
						} else if (uri.startsWith(`TEXTURE${path.sep}`)) {
							uri = uri.replace(`TEXTURE${path.sep}`, '');
						} else if (uri.startsWith(`texture${path.sep}`)) {
							uri = uri.replace(`texture${path.sep}`, '');
						}

						const texturePathCandidates = [findCaseInsensitive(path.resolve(path.join(containerFolder, `texture${modelRef.textureIndex}`, uri))), findCaseInsensitive(path.resolve(path.join(containerFolder, `texture`, uri)))];
						if (fs.existsSync(texturePathCandidates[0] || '')) {
							image.extras = { absolutePath: texturePathCandidates[0] };
							image.uri = `${path.basename(image.uri, path.extname(image.uri))}${modelRef.textureIndex}${path.extname(image.uri)}`;
						} else if (fs.existsSync(texturePathCandidates[1] || '')) {
							image.extras = { absolutePath: texturePathCandidates[1] };
							image.uri = `${path.basename(image.uri, path.extname(image.uri))}${modelRef.textureIndex}${path.extname(image.uri)}`;
						} else {
							console.warn(`Texture file does not exist for model ${modelRef.containerTitle}: ${uri}`);
						}
					}
					// This seems wasteful as we'll end up processing SimObjects over and over again
					// Currently though, it makes things like different liveries much simpler to handle.
					libraryObjectsForModel.push(modelRef);
				} else {
					console.warn(`Model ${guid} is missing required properties.`);
				}

				const tempBinPath = path.join(tempTilePath, `temp-${guid}.bin`);
				const tempGltfPath = path.join(tempTilePath, `temp-${guid}.gltf`);
				checkAbort(control);
				reportStatus(id, control, `Processing model source ${name}...`);

				const meshes = Array.isArray(json.meshes) ? json.meshes : [];
				const accessors = Array.isArray(json.accessors) ? json.accessors : [];
				const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : [];
				const images = Array.isArray(json.images) ? json.images : [];
				const textures = Array.isArray(json.textures) ? json.textures : [];
				const nodes = Array.isArray(json.nodes) ? json.nodes : [];
				const materials = Array.isArray(json.materials) ? json.materials : [];

				if (bufferViews.length === 0 || accessors.length === 0 || meshes.length === 0) {
					console.info(`GLB in model ${name} (${guid}) has no mesh data; skipping.`);
					// Advance j past this GLB record (type[4] + size[4] + payload[glbSize])
					continue;
				}

				if (Array.isArray(json.buffers) && json.buffers.length > 0 && typeof json.buffers[0] === 'object' && json.buffers[0] !== null) {
					(json.buffers[0] as Record<string, unknown>).uri = `temp-${guid}.bin`;
				}
				delete (json as { extensionsRequired?: unknown }).extensionsRequired;

				// Preprocess images to convert to DDS and update URIs
				for (const image of images) {
					if (!image || typeof image !== 'object') {
						continue;
					}

					let uri: string = typeof image.uri === 'string' ? image.uri : '';
					uri = decodeURIComponent(uri.replace(/\\/g, path.sep).replace(/\//g, path.sep));
					if (uri.length === 0) {
						continue;
					}

					const outputUri = `${path.basename(uri, path.extname(uri))}.DDS`;
					image.uri = outputUri;
					const outputTexturePath = path.join(tempTilePath, outputUri);
					if (image.extras && fs.existsSync(image.extras.absolutePath || '')) {
						// This is a SimObject whose custom textures have already been assigned earlier
						convertToDDS(image.extras.absolutePath, outputTexturePath);
						continue;
					}

					const extras = (image.extras && typeof image.extras === 'object')
						? image.extras
						: {};
					const absoluteTexturePath = resolveAbsoluteTexturePath(inputPath, modelRef.file, uri);
					extras.absolutePath = absoluteTexturePath;
					image.extras = extras;

					if (!fs.existsSync(outputTexturePath)) {
						if (fs.existsSync(absoluteTexturePath)) {
							// Using the actual texture files here takes tons of RAM
							// Copy the dummy texture first, keep the absolute path for later conversion
							// TODO: Make an actually distinct dummy texture for each missing texture to avoid conflicts
							fs.copyFileSync(dummyTexturePath, outputTexturePath);
						} else {
							console.warn(`Texture file not found: ${uri}`);
							const fallbackTexturePath = dummyTexturePath;
							if (fs.existsSync(fallbackTexturePath)) {
								fs.copyFileSync(fallbackTexturePath, outputTexturePath);
							}
						}
					}
				}

				// Preprocess textures to handle MSFT_texture_dds extension
				for (const texture of textures) {
					if (texture.extensions && texture.extensions.MSFT_texture_dds) {
						texture.source = texture.extensions.MSFT_texture_dds.source;
						delete texture.extensions.MSFT_texture_dds;
					}
				}

				// Preprocess nodes to handle non-uniform scaling, and remove invisible objects
				for (const node of nodes) {
					if (node.mesh && meshes[node.mesh]) {
						for (const primitive of meshes[node.mesh].primitives) {
							if (
								primitive.material
								&& materials[primitive.material]
								&& materials[primitive.material].extensions
								&& (materials[primitive.material].extensions.ASOBO_material_environment_occluder || materials[primitive.material].extensions.ASOBO_material_invisible)
							) {
								delete node.mesh;
								break;
							}
						}
					}
					if (node.scale && Array.isArray(node.scale) && node.scale.length === 3) {
						const scale = (node.scale[0] + node.scale[1] + node.scale[2]) / 3;
						node.scale = [scale, scale, scale];
					}
				}

				fs.writeFileSync(tempGltfPath, JSON.stringify(json), 'utf-8');
				fs.writeFileSync(tempBinPath, binary);

				let document: Document = await new NodeIO().read(tempGltfPath);
				// Repair Asobo-specific geometry issues, then re-export for validation
				applyAsoboGeometryRepair(document);
				await new NodeIO().write(tempGltfPath, document);

				const ignoredIssues = ['IO_ERROR', 'TEXTURE_INVALID_IMAGE_MIME_TYPE', 'UNSATISFIED_DEPENDENCY'];
				let validation: any = await validator.validateString(JSON.stringify(json), {
					ignoredIssues: ignoredIssues
				});
				let tries = 0;
				while (tries < config.maxRepairRetries && validation.issues.numErrors > 0) {
					checkAbort(control);
					tries++;
					console.warn(`Attempt ${tries} to fix ${validation.issues.numErrors} errors for model ${name} (${modelRef.guid})`);
					await repairDocument(document, tempGltfPath, validation.issues.messages);
					await new NodeIO().write(tempGltfPath, document);
					validation = await validator.validateString(fs.readFileSync(tempGltfPath, 'utf-8'), {
						ignoredIssues: ignoredIssues
					});
				}

				if (validation.issues.numErrors > 0) {
					console.error(`Failed to repair geometry for model ${name} (${modelRef.guid}) after ${tries} attempts`);
					const issues = validation.issues.messages ?? [];
					for (const error of issues) {
						if (error.severity === 0) {
							console.error(`${error.code} at ${error.pointer}: ${error.message}`);
						}
					}
					continue;
				}

				for (const libObj of libraryObjectsForModel) {
					if (getTileIndexFromCoord(libObj.position[1], libObj.position[0]) !== tileIndex) {
						continue;
					}

					const scale = Number.isFinite(libObj.scale) ? libObj.scale : 1;

					const map = mergeDocuments(tileDocument, document);
					const sourceScene = document.getRoot().listScenes()[0];
					if (!sourceScene) {
						continue;
					}

					// Find original Scene.
					const sceneA = tileDocument.getRoot().listScenes()[0] ?? tileDocument.createScene();

					// Find counterpart of the source Scene in the target Document.
					const sceneB = map.get(sourceScene);
					if (!(sceneB instanceof Scene)) {
						continue;
					}

					// Create a Node, and append source Scene's direct children.

					const lonOffsetMeters = -(libObj.position[0] - center[0]) * 111320.0 * Math.cos(center[1] * Math.PI / 180.0);
					const latOffsetMeters = (libObj.position[1] - center[1]) * 110540.0;
					const altOffsetMeters = libObj.position[2] - center[2];
					const rotation: quat = quat.fromEuler(quat.create(), libObj.orientation[0], -libObj.orientation[2], libObj.orientation[1]);
					const rootNode = tileDocument.createNode().setName(name)
						.setTranslation([lonOffsetMeters, altOffsetMeters, latOffsetMeters])
						.setRotation([rotation[0], rotation[1], rotation[2], rotation[3]])
						.setScale([scale, scale, scale]);

					for (const node of sceneB.listChildren()) {
						rootNode.addChild(node);
					}

					// Append Node to original Scene, and dispose the empty Scene.
					sceneA.addChild(rootNode);
					if (sceneB !== sceneA) {
						sceneB.dispose();
					}
				}
				setProgressState(id, control, taskIndex, 'completed');
			} catch (error) {
				console.error(`Error processing library objects for model: ${error}`);
				setProgressState(id, control, taskIndex, 'failed');
			} finally {
				if (taskIndex !== -1 && getConversion(id).progressItems[taskIndex].state === 'running') {
					setProgressState(id, control, taskIndex, 'completed');
				}
			}
		}
	} finally {
		fs.rmSync(tempTilePath, { recursive: true, force: true });
	}

	const tileOutputPath = path.join(outputPath, 'Objects', getFilePathFromTileIndex(tileIndex));
	fs.mkdirSync(tileOutputPath, { recursive: true });
	// Skin dedup compares joint Nodes recursively; deeply-nested jetway/skeleton hierarchies can overflow the call stack, so skip it.
	reportStatus(id, control, 'Running dedup...');
	try {
		await tileDocument.transform(dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.TEXTURE, PropertyType.MATERIAL] }));
	} catch (error) {
		console.error(`Dedup failed: ${error}`);
	}
	reportStatus(id, control, 'Running weld...');
	try {
		await tileDocument.transform(weld());
	} catch (error) {
		console.error(`Weld failed: ${error}`);
	}
	reportStatus(id, control, 'Running flatten...');
	try {
		await tileDocument.transform(flatten());
	} catch (error) {
		console.error(`Flatten failed: ${error}`);
	}
	reportStatus(id, control, 'Running resample...');
	try {
		await tileDocument.transform(resample());
	} catch (error) {
		console.error(`Resample failed: ${error}`);
	}
	reportStatus(id, control, 'Running prune...');
	try {
		await tileDocument.transform(prune({ keepAttributes: true }));
	} catch (error) {
		console.error(`Prune failed: ${error}`);
	}
	reportStatus(id, control, 'Running unpartition...');
	try {
		await tileDocument.transform(unpartition());
	} catch (error) {
		console.error(`Unpartition failed: ${error}`);
	}
	const root = tileDocument.getRoot();
	for (const accessor of root.listAccessors()) {
		// NodeIO expands implicit zeros and sparse overrides when reading. Disable
		// sparse serialization so FG never receives an accessor without bufferView.
		accessor.setSparse(false);
		// Accessors read without a base bufferView may not belong to a buffer yet.
		if (!accessor.getBuffer()) {
			accessor.setBuffer(root.listBuffers()[0] ?? tileDocument.createBuffer());
		}
	}

	reportStatus(id, control, 'Writing to disk...');
	await new NodeIO().write(path.join(tileOutputPath, `${tileIndex}.gltf`), tileDocument);
	// Reread JSON and copy texture files
	const jsonPath = path.join(tileOutputPath, `${tileIndex}.gltf`);
	const json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
	if (json.images) {
		for (const image of json.images) {
			if (image.extras.absolutePath && image.uri) {
				const texturePath = path.join(tileOutputPath, image.uri);
				if (fs.existsSync(texturePath)) {
					fs.unlinkSync(texturePath);
					convertToDDS(image.extras.absolutePath, texturePath);
				}
			}
		}
	}
	fs.renameSync(
		path.join(tileOutputPath, json.buffers[0].uri),
		path.join(tileOutputPath, `${tileIndex}.bin`)
	);
	if (json.buffers && json.buffers[0]) {
		json.buffers[0].uri = `${tileIndex}.bin`;
	}
	fs.writeFileSync(jsonPath, JSON.stringify(json, null, 4));
	fs.writeFileSync(
		path.join(tileOutputPath, `${tileIndex}.stg`),
		`OBJECT_STATIC ${tileIndex}.gltf ${center[0]} ${center[1]} ${center[2]} 270 0 90`
	);
}


export async function convertScenery(inputPath: string, outputPath: string, control?: ConversionControl): Promise<void> {
	const id = control?.conversionId ?? Date.now().toString(36);
	conversions[id] = {
		id,
		inputPath,
		outputPath,
		logPath: path.join(config.storeDir, 'logs', `${id}.log`),
		progressItems: [],
		placements: [],
		status: 'Initializing'
	};
	conversions[id].progressItems.push({
		size: 1,
		state: 'running'
	});
	reportProgress(id, control);
	const progressItems: ConversionProgressItem[] = [];
	if (!fs.existsSync(inputPath)) {
		throw new Error(`Input path does not exist: ${inputPath}`);
	}

	const libraryObjects: Map<string, LibraryObject[]> = new Map();
	const simObjects: Map<string, SimObject[]> = new Map();
	const guidsWithModels: Set<string> = new Set();
	const modelReferencesByTile: Map<number, ModelReference[]> = new Map();
	reportStatus(id, control, 'Scanning scenery files...');
	const allBglFiles: string[] = getFilesRecursive(inputPath, '.bgl', false);
	reportStatus(id, control, 'Scanning config files...');
	const configPathsByTitle = new Map<string, string[]>();
	for (const file of getFilesRecursive(inputPath, '.cfg', false)) {
		for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
			const match = /^title=(.*)$/.exec(line.trim());
			if (match) {
				const paths = configPathsByTitle.get(match[1]) ?? [];
				paths.push(file);
				configPathsByTitle.set(match[1], paths);
			}
		}
	}

	let totalModelCount: number = 0;
	let totalLibraryObjects: number = 0;

	for (const file of allBglFiles) {
		checkAbort(control);
		reportStatus(id, control, `Looking for placements in ${path.basename(file)}...`);
		console.log(`Processing file: ${file}`);
		const fileBuffer = fs.readFileSync(file);
		const fileView: DataView = new DataView(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);
		let address: number = 0; // all binary indexing should use this variable
		const magicNumber1: number = fileView.getUint32(address, true);
		address = 0x10;
		const magicNumber2: number = fileView.getUint32(address, true);
		address += 4;
		if (magicNumber1 !== 0x19920201 || magicNumber2 !== 0x08051803) {
			console.warn(`Invalid BGL header in model data file: ${path.basename(file)}`);
			continue;
		}
		const recordCt = fileView.getUint32(0x14, true);

		const sceneryObjectOffsets: number[] = [];
		const airportOffsets: number[] = [];
		address = 0x38;
		for (let i = 0; i < recordCt; i++) {
			const recType = fileView.getUint32(address, true);
			address += 8;
			const subrecordCount = fileView.getUint32(address, true);
			address += 4;
			const startSubsection = fileView.getUint32(address, true);
			address += 8;
			if (recType === 0x0025) { // SceneryObject
				for (let j = 0; j < subrecordCount; j++) {
					sceneryObjectOffsets.push(startSubsection + j * 16);
				}
			} else if (recType === 0x0003) { // Airport
				for (let j = 0; j < subrecordCount; j++) {
					airportOffsets.push(startSubsection + j * 16);
				}
			}
		}

		// TODO: can this part be folded into the loop above?
		// Parse SceneryObject subrecords
		const sceneryObjectSubrecords: number[][] = [];
		for (const sceneryOffset of sceneryObjectOffsets) {
			address = sceneryOffset + 8;
			sceneryObjectSubrecords.push([fileView.getUint32(address, true), fileView.getUint32(address + 4, true)]);
		}

		for (const subrecord of sceneryObjectSubrecords) {
			let bytesRead = 0;
			while (bytesRead < subrecord[1]) {
				address = subrecord[0] + bytesRead;
				const recordType = fileView.getUint16(address, true);
				address += 2;
				const size = fileView.getUint16(address, true);
				address += 2;
				if (recordType === 0x0B) { // LibraryObject
					address -= 4; // Reverse back to get all of the bytes
					const libObj = await buildLibraryObject(fileView, address);
					if (!libraryObjects.has(libObj.guid)) {
						libraryObjects.set(libObj.guid, []);
					}
					libraryObjects.get(libObj.guid)!.push(libObj);
					conversions[id].placements.push(libObj);
				} else if (recordType === 0x19) { //SimObject
					address -= 4; // Reverse back to get all of the bytes
					const simObj = await buildSimObject(fileView, address, file, configPathsByTitle);
					if (simObj.containerPath !== '') {
						if (!simObjects.has(simObj.containerTitle)) {
							simObjects.set(simObj.containerTitle, []);
						}
						simObjects.get(simObj.containerTitle)!.push(simObj);
						conversions[id].placements.push(simObj);
						progressItems.push({
							size: getProgressSize(simObj.binPath, `sim object ${simObj.containerTitle}`),
							state: 'pending'
						});
					}
				} else {
					console.warn(`Unexpected subrecord type at offset 0x${(subrecord[0] + bytesRead).toString(16)}: 0x${recordType.toString(16)}, skipping ${size} bytes`);
					bytesRead += size;
					// AI says this should be bytesRead instead of size
					address = subrecord[0] + size;
					continue;
				}
				totalLibraryObjects++;
				reportStatus(id, control, `Looking for placements in ${path.basename(file)}... found ${totalLibraryObjects}`);
				bytesRead += size;
			}
		}

		// Parse Airport subrecords
		const airportSubrecords: number[][] = [];
		for (const airportOffset of airportOffsets) {
			address = airportOffset + 8;
			airportSubrecords.push([fileView.getUint32(address, true), fileView.getUint32(address + 4, true)]);
		}

		for (const subrecord of airportSubrecords) {
			let bytesRead = 0;
			while (bytesRead < subrecord[1]) {
				address = subrecord[0] + bytesRead;
				const recordType = fileView.getUint16(address, true);
				address += 2;
				if (recordType !== 0x0056) { // Airport subrecord type
					const skip = fileView.getUint32(address, true);
					console.warn(`Unexpected airport subrecord type at offset 0x${(subrecord[0] + bytesRead).toString(16)}: 0x${recordType.toString(16)}, skipping ${skip} bytes`);
					bytesRead += skip;
					continue;
				}
				let airport: Airport = {
					longitude: -1,
					latitude: -1,
					altitude: -1,
					tower: {} as Tower,
					magvar: -1,
					icao: '',
					regIdent: '',
					name: '',
					runways: [],
					runwayStarts: [],
					taxiwayPoints: [],
					taxiwayParkings: [],
					taxiwayPaths: [],
					taxiNames: [],
					aprons: [],
					taxiwaySigns: [],
					paintedLines: [],
					paintedHatchedAreas: [],
					jetways: [],
					lightSupports: [],
					approaches: [],
					apronEdgeLights: [],
					helipads: [],
					projectedMeshes: []
				};
				const size = fileView.getUint32(address, true);
				address += 4;
				address += 1;
				address += 1;
				address += 1;
				address += 1;
				address += 1;
				address += 1;
				airport.longitude = (fileView.getUint32(address, true) * (360.0 / 805306368.0)) - 180.0;
				address += 4;
				airport.latitude = 90.0 - (fileView.getUint32(address, true) * (180.0 / 536870912.0));
				address += 4;
				airport.altitude = fileView.getInt32(address, true) / 1000.0;
				address += 4;
				airport.tower = {
					latitude: 90.0 - (fileView.getUint32(address, true) * (180.0 / 536870912.0)),
					longitude: (fileView.getUint32(address + 4, true) * (360.0 / 805306368.0)) - 180.0,
					altitude: fileView.getInt32(address + 8, true) / 1000.0
				};
				address += 12;
				airport.magvar = fileView.getFloat32(address, true);
				address += 4;
				airport.icao = convertIcaoBytesToString(fileView.getUint32(address, true));
				address += 4;
				airport.regIdent = convertIcaoBytesToString(fileView.getUint32(address, true));
				address = subrecord[0] + bytesRead + 0x37; // Skip ahead to departure count
				address = subrecord[0] + bytesRead + 0x39; // Skip ahead to arrival count
				address = subrecord[0] + bytesRead + 0x3c; // Skip ahead to remaining useful records
				address += 2;
				address += 2;
				address += 2;
				address += 2;
				let airportBytesRead = 0x44; // Start with 0x44 bytes we've already read

				while (airportBytesRead < size) {
					// This shouldn't be necessary, but it puts you back on the straight and narrow if something goes wrong in the parsing and we get off-track
					address = subrecord[0] + bytesRead + airportBytesRead;

					const recordId = fileView.getUint16(address, true);
					address += 2; // Move past the record ID
					const recordSize = fileView.getUint32(address, true);
					address += 4; // Move past the record size
					switch (recordId) {
						case 0x0019: // Airport Name
							airport.name = new TextDecoder('utf-8').decode(getViewBytes(fileView, address, recordSize));
							break;
						case 0x00ce: // Runway
							address += 2;
							let runway: Runway = {
								primaryNumber: fileView.getUint8(address),
								primaryDesignator: fileView.getUint8(address + 1),
								secondaryNumber: fileView.getUint8(address + 2),
								secondaryDesignator: fileView.getUint8(address + 3),
								primaryILSIdent: convertIcaoBytesToString(fileView.getUint32(address + 4, true)),
								secondaryILSIdent: convertIcaoBytesToString(fileView.getUint32(address + 8, true)),
								longitude: (fileView.getUint32(address + 12, true) * (360.0 / 805306368.0)) - 180.0,
								latitude: 90.0 - (fileView.getUint32(address + 16, true) * (180.0 / 536870912.0)),
								altitude: fileView.getInt32(address + 20, true) / 1000.0,
								length: fileView.getUint32(address + 24, true) / 1000.0,
								width: fileView.getUint32(address + 28, true) / 1000.0,
								heading: Math.round(fileView.getFloat32(address + 32, true) * (360.0 / 65536.0) * 1000) / 1000,
								patternAltitude: fileView.getFloat32(address + 36, true) / 1000.0,
								groundMerging: false,
								excludeVegetationAround: false,
								falloff: -1,
								surface: '',
								coloration: [-1, -1, -1, -1], // RGBA bytes
								markingTypes: [],
								lightTypes: [],
								patternTypes: [],
								vasis: [],
								offsetThresholds: [],
								blastPads: [],
								overruns: [],
								approachLights: [],
								facilityMaterial: {
									opacity: -1,
									guid: '',
									tilingU: -1,
									tilingV: -1,
									width: -1,
									falloff: -1
								}
							};
							address += 40;
							const markingValue = fileView.getUint16(address, true);
							address += 2;
							const lightValue = fileView.getUint8(address);
							address += 1;
							const patternValue = fileView.getUint8(address);
							address += 1;

							for (let j = 0; j < 16; j++) {
								if (((markingValue >> j) & 1) != 0) {
									runway.markingTypes.push(j);
								}
							}

							if ((lightValue & (1 << 5)) != 0) {
								runway.markingTypes.push(16);
							}
							if ((lightValue & (1 << 6)) != 0) {
								runway.markingTypes.push(17);
							}
							if ((lightValue & (1 << 7)) != 0) {
								runway.markingTypes.push(18);
							}

							const edgeLightsValue = lightValue & 0b11;
							runway.lightTypes.push(edgeLightsValue);

							const centerLightsValue = (lightValue >> 2) & 0b11;
							runway.lightTypes.push(4 + centerLightsValue);

							if ((lightValue & (1 << 4)) != 0) {
								runway.lightTypes.push(8);
							}

							if ((patternValue & (1 << 0)) != 0) {
								runway.patternTypes.push(0);
							}
							if ((patternValue & (1 << 1)) != 0) {
								runway.patternTypes.push(1);
							}
							if ((patternValue & (1 << 2)) != 0) {
								runway.patternTypes.push(2);
							}
							if ((patternValue & (1 << 3)) != 0) {
								runway.patternTypes.push(3);
							}
							if ((patternValue & (1 << 4)) != 0) {
								runway.patternTypes.push(4);
							}
							if ((patternValue & (1 << 5)) != 0) {
								runway.patternTypes.push(5);
							}
							runway.groundMerging = (patternValue & (1 << 6)) != 0;
							runway.excludeVegetationAround = (patternValue & (1 << 7)) != 0;
							address += 0x14;
							runway.falloff = fileView.getFloat32(address, true);
							address += 4;
							runway.surface = getGuidFromBytes(getViewBytes(fileView, address, 16));
							address += 16;
							runway.coloration = [
								fileView.getUint8(address),
								fileView.getUint8(address + 1),
								fileView.getUint8(address + 2),
								fileView.getUint8(address + 3)
							];
							address += 4;
							let runwayBytesRead = 0x60;
							while (runwayBytesRead < recordSize) {
								address = subrecord[0] + bytesRead + airportBytesRead + runwayBytesRead;
								const runwayRecordId = fileView.getUint16(address, true);
								address += 2;
								const runwayRecordSize = fileView.getUint32(address, true);
								address += 4;
								if (runwayRecordId >= 0x000b && runwayRecordId <= 0x000e) // VASI
								{
									runway.vasis.push({
										childType: runwayRecordId - 0x000b,
										type: runwayRecordId - 0x000b,
										biasX: fileView.getFloat32(address, true),
										biasZ: fileView.getFloat32(address + 4, true),
										spacing: fileView.getFloat32(address + 8, true),
										pitch: fileView.getFloat32(address + 12, true),
									});
									address += 16
								}
								else if (runwayRecordId == 0x0005) // OffsetThreshold
								{
									runway.offsetThresholds.push({
										fsXSurface: fileView.getFloat32(address, true),
										surface: getGuidFromBytes(getViewBytes(fileView, address + 4, 16)),
										length: fileView.getFloat32(address + 20, true),
										width: fileView.getFloat32(address + 24, true),
									});
									address += 28
								}
								else if (runwayRecordId == 0x0007 || runwayRecordId == 0x0008) // BlastPad
								{
									runway.blastPads.push({
										fsXSurface: fileView.getFloat32(address, true),
										surface: getGuidFromBytes(getViewBytes(fileView, address + 4, 16)),
										length: fileView.getFloat32(address + 20, true),
										width: fileView.getFloat32(address + 24, true),
									});
									address += 28;
								}
								else if (runwayRecordId == 0x0065 || runwayRecordId == 0x0066) // Overrun
								{
									runway.overruns.push({
										fsXSurface: fileView.getFloat32(address, true),
										surface: getGuidFromBytes(getViewBytes(fileView, address + 4, 16)),
										length: fileView.getFloat32(address + 20, true),
										width: fileView.getFloat32(address + 24, true),
									});
									address += 28;
								}
								else if (runwayRecordId == 0x00df || runwayRecordId == 0x00e0) // ApproachLights
								{
									const typeValue = fileView.getUint8(address);
									address += 1;
									runway.approachLights.push({
										type: typeValue & 0b1111,
										endLights: (typeValue & 0b10000) != 0,
										reil: (typeValue & 0b100000) != 0,
										touchdown: (typeValue & 0b1000000) != 0,
										strobes: fileView.getUint8(address),
										spacing: fileView.getFloat32(address + 1, true),
										offset: fileView.getFloat32(address + 5, true),
										slope: fileView.getFloat32(address + 9, true),
									});
									address += 17; // Skip unknown field
								}
								else if (runwayRecordId == 0x00cb) // FacilityMaterial
								{
									address++; // Skip unknown field
									runway.facilityMaterial = {
										opacity: fileView.getUint8(address),
										guid: getGuidFromBytes(getViewBytes(fileView, address + 1, 16)),
										tilingU: fileView.getFloat32(address + 21, true),
										tilingV: fileView.getFloat32(address + 25, true),
										width: fileView.getFloat32(address + 29, true),
										falloff: fileView.getFloat32(address + 33, true),
									};
									address += 37;
								}
								runwayBytesRead += runwayRecordSize;
							}
							break;
						case 0x0011: // Start
							let runwayStart: RunwayStart = {
								runwayNumber: fileView.getUint8(address),
								designator: 0,
								type: 0,
								longitude: 0,
								latitude: 0,
								altitude: 0,
								heading: 0
							};
							address += 1;
							const value = fileView.getUint8(address);
							address += 1;
							runwayStart.designator = value & 0b1111;
							runwayStart.type = (value >> 4) & 0b1111;
							runwayStart.longitude = (fileView.getUint32(address, true) * (360.0 / 805306368.0)) - 180.0;
							address += 4;
							runwayStart.latitude = 90.0 - (fileView.getUint32(address, true) * (180.0 / 536870912.0));
							address += 4;
							runwayStart.altitude = fileView.getInt32(address, true) / 1000.0;
							address += 4;
							runwayStart.heading = fileView.getFloat32(address, true) * (360.0 / 65536.0);
							address += 4;
							break;
						case 0x001a: // TaxiwayPoint
							const taxiwayPointCount = fileView.getUint16(address, true);
							address += 2;
							for (let j = 0; j < taxiwayPointCount; j++) {
								let taxiwayPoint: TaxiwayPoint = {
									type: fileView.getUint8(address),
									orientation: fileView.getUint8(address + 1),
									longitude: 0,
									latitude: 0
								};
								address += 4; // Skip unknown field and the two bytes already read
								taxiwayPoint.longitude = (fileView.getUint32(address, true) * (360.0 / 805306368.0)) - 180.0;
								address += 4;
								taxiwayPoint.latitude = 90.0 - (fileView.getUint32(address, true) * (180.0 / 536870912.0));
								address += 4;
							}
							break;
						case 0x00e7: // TaxiwayParking
							const taxiwayParkingCount = fileView.getUint16(address, true);
							address += 2;
							for (let j = 0; j < taxiwayParkingCount; j++) {
								const value = fileView.getInt32(address, true);
								address += 4;
								let taxiwayParking: TaxiwayParking = {
									name: value & 0b111111,
									pushback: (value >> 6) & 0b11,
									type: (value >> 8) & 0b1111,
									number: (value >> 12) & 0xFFF,
									airlineCodes: new Array(value >> 24 & 0xFF),
									radius: fileView.getFloat32(address, true),
									heading: fileView.getFloat32(address + 4, true) * (360.0 / 65536.0),
									teeOffset1: fileView.getFloat32(address + 8, true),
									teeOffset2: fileView.getFloat32(address + 12, true),
									teeOffset3: fileView.getFloat32(address + 16, true),
									teeOffset4: fileView.getFloat32(address + 20, true),
									longitude: (fileView.getUint32(address + 24, true) * (360.0 / 805306368.0)) - 180.0,
									latitude: 90.0 - (fileView.getUint32(address + 28, true) * (180.0 / 536870912.0)),
									numberMarking: false,
									suffix: 0,
									numberBiasX: 0,
									numberBiasZ: 0,
									numberHeading: 0,
								};
								address += 32;
								for (let k = 0; k < taxiwayParking.airlineCodes.length; k++) {
									taxiwayParking.airlineCodes[k] = new TextDecoder().decode(getViewBytes(fileView, address, 4));
									address += 4;
								}
								taxiwayParking.numberMarking = fileView.getUint8(address) !== 0;
								address += 1;
								taxiwayParking.suffix = fileView.getUint8(address);
								address += 1;
								address += 5; // Skip unknown fields
								taxiwayParking.numberBiasX = fileView.getFloat32(address, true);
								address += 4;
								taxiwayParking.numberBiasZ = fileView.getFloat32(address, true);
								address += 4;
								taxiwayParking.numberHeading = fileView.getFloat32(address, true) * (360.0 / 65536.0);
								address += 4;
							}
							break;
						case 0x00d4: // TaxiwayPath
							const taxiwayPathCount = fileView.getUint16(address, true);
							address += 2;
							for (let j = 0; j < taxiwayPathCount; j++) {
								let taxiwayPath: TaxiwayPath = {
									start: fileView.getUint16(address, true),
									legacyEnd: 0,
									designator: 0,
									type: 0,
									enhanced: false,
									drawSurface: false,
									drawDetail: false,
									runwayNumber: 0,
									name: 0,
									centerLine: false,
									centerLineLighted: false,
									leftEdge: 0,
									leftEdgeLighted: false,
									rightEdge: 0,
									rightEdgeLighted: false,
									fsXSurface: 0,
									width: 0,
									weightLimit: 0,
									surface: '',
									coloration: [],
									materials: [],
									groundMerging: false,
									excludeVegetationAround: false,
									excludeVegetationInside: false,
									end: 0,
								};
								address += 2;
								let value1 = fileView.getInt16(address, true);
								address += 2;
								let value2 = fileView.getUint8(address);
								address += 1;
								taxiwayPath.legacyEnd = value1 & 0x7FF;
								taxiwayPath.designator = (value1 >> 11) & 0b1111;
								taxiwayPath.type = value2 & 0b111;
								taxiwayPath.enhanced = (value2 & 0b1000) == 0b1000;
								taxiwayPath.drawSurface = (value2 & 0b10000) == 0b10000;
								taxiwayPath.drawDetail = (value2 & 0b100000) == 0b100000;
								if (taxiwayPath.type == TaxiwayPathType.Runway) {
									taxiwayPath.runwayNumber = fileView.getUint8(address);
									address += 1;
								}
								else {
									taxiwayPath.name = fileView.getUint8(address);
									address += 1;
								}
								let value3 = fileView.getUint8(address);
								address += 1;
								taxiwayPath.centerLine = (value3 & 0b1) == 1;
								taxiwayPath.centerLineLighted = (value3 & 0b10) !== 0;
								taxiwayPath.leftEdge = (value3 >> 2) & 0b11;
								taxiwayPath.leftEdgeLighted = (value3 & 0b10000) !== 0;
								taxiwayPath.rightEdge = (value3 >> 5) & 0b11;
								taxiwayPath.rightEdgeLighted = (value3 & 0b10000000) !== 0;
								taxiwayPath.fsXSurface = fileView.getUint8(address);
								address += 1;
								taxiwayPath.width = fileView.getFloat32(address, true);
								address += 4;
								taxiwayPath.weightLimit = fileView.getUint32(address, true);
								address += 12; // Skip unknown field
								taxiwayPath.surface = getGuidFromBytes(getViewBytes(fileView, address, 16));
								address += 16;
								taxiwayPath.coloration = [fileView.getUint8(address), fileView.getUint8(address + 1), fileView.getUint8(address + 2), fileView.getUint8(address + 3)];
								address += 4;
								let materialCt = fileView.getUint8(address);
								address += 1;
								let value4 = fileView.getUint8(address);
								address += 1;
								taxiwayPath.groundMerging = (value4 & 0b1) == 1;
								taxiwayPath.excludeVegetationAround = (value4 & 0b10) == 0;
								taxiwayPath.excludeVegetationInside = (value4 & 0b100) == 0;
								taxiwayPath.end = fileView.getUint16(address, true);
								address += 2;
								taxiwayPath.materials = [];
								for (let k = 0; k < materialCt; k++) {
									const materialRecordId = fileView.getInt16(address, true);
									address += 2;
									if (materialRecordId == 0x00d5) // TaxiwayPathMaterial
									{
										address += 4; // The record size, but it's the same every time
										taxiwayPath.materials.push({
											type: fileView.getUint8(address),
											opacity: fileView.getUint8(address + 1),
											surface: getGuidFromBytes(getViewBytes(fileView, address + 2, 16)),
											materialType: fileView.getUint32(address + 18, true),
											tilingU: fileView.getFloat32(address + 22, true),
											tilingV: fileView.getFloat32(address + 26, true),
											width: fileView.getFloat32(address + 30, true),
											falloff: fileView.getFloat32(address + 34, true)
										});
										address += 38;
									}
								}
							}
							break;
						case 0x001d: // TaxiName
							const taxiNameCount = fileView.getUint16(address, true);
							address += 2;
							for (let j = 0; j < taxiNameCount; j++) {
								address += 8;
							}
							break;
						case 0x00d3: // Apron
							const valueApron = fileView.getUint8(address);
							address++;
							let apron: Apron = {
								drawSurface: (valueApron & 0b1) !== 0,
								drawDetail: (valueApron & 0b10) !== 0,
								localUV: (valueApron & 0b100) !== 0,
								stretchUV: (valueApron & 0b1000) !== 0,
								groundMerging: (valueApron & 0b10000) === 0,
								excludeVegetationAround: (valueApron & 0b100000) === 0,
								excludeVegetationInside: (valueApron & 0b1000000) === 0,
								opacity: fileView.getUint8(address),
								coloration: [fileView.getUint8(address + 1), fileView.getUint8(address + 2), fileView.getUint8(address + 3), fileView.getUint8(address + 4)],
								surface: getGuidFromBytes(getViewBytes(fileView, address + 5, 16)),
								tiling: fileView.getFloat32(address + 21, true),
								heading: fileView.getFloat32(address + 25, true) * (360.0 / 65536.0),
								falloff: fileView.getFloat32(address + 29, true),
								priority: fileView.getInt32(address + 33, true),
								vertices: [],
								tris: []
							};
							address += 37;
							const vertexCt = fileView.getUint16(address, true);
							address += 2;
							const triangleCt = fileView.getUint16(address, true);
							address += 2;
							for (let j = 0; j < vertexCt; j++) {
								apron.vertices.push([
									((fileView.getUint32(address, true) * (360.0 / 805306368.0)) - 180.0),
									(90.0 - (fileView.getUint32(address + 4, true) * (180.0 / 536870912.0)))
								]);
								address += 8;
							}
							for (let j = 0; j < triangleCt; j++) {
								apron.tris.push([
									fileView.getUint16(address, true),
									fileView.getUint16(address + 2, true),
									fileView.getUint16(address + 4, true)
								]);
								address += 6;
							}
							break;
						case 0x00d9: // TaxiwaySign
							address += 2; // Skip record size, it's always the same
							const taxiwaySign: TaxiwaySign = {
								longitude: (fileView.getUint32(address, true) * (360.0 / 805306368.0)) - 180.0,
								latitude: 90.0 - (fileView.getUint32(address + 4, true) * (180.0 / 536870912.0)),
								heading: fileView.getFloat32(address + 8, true) * (360.0 / 65536.0),
								size: fileView.getUint8(address + 12),
								justificationRight: (fileView.getUint8(address + 13) & 0b1) == 1,
								label: new TextDecoder().decode(getViewBytes(fileView, address + 14, 0x3e)),
							};
							address += 14 + 0x3e;
							break;
						case 0x00cf: // PaintedLine
							const paintedLine: PaintedLine = {
								type: fileView.getUint8(address),
								trueAngle: fileView.getUint8(address + 1),
								vertices: [],
								surface: ''
							};
							address += 2;
							const vertexCtPaintedLine = fileView.getUint32(address, true);
							address += 4;
							paintedLine.surface = getGuidFromBytes(getViewBytes(fileView, address, 16));
							address += 16;
							for (let j = 0; j < vertexCtPaintedLine; j++) {
								paintedLine.vertices.push([
									((fileView.getUint32(address, true) * (360.0 / 805306368.0)) - 180.0),
									(90.0 - (fileView.getUint32(address + 4, true) * (180.0 / 536870912.0)))
								]);
								address += 8;
							}
							break;
						case 0x00d8: // PaintedHatchedArea
							const paintedHatchedArea: PaintedHatchedArea = {
								type: fileView.getUint8(address),
								vertices: [],
								heading: 0,
								spacing: 0,
								vertexCount: 0
							};
							address += 1;
							paintedHatchedArea.vertexCount = fileView.getUint16(address, true);
							address += 2;
							paintedHatchedArea.heading = fileView.getFloat32(address, true) * (360.0 / 65536.0);
							address += 4;
							paintedHatchedArea.spacing = fileView.getFloat32(address, true);
							address += 4;
							for (let j = 0; j < paintedHatchedArea.vertexCount; j++) {
								paintedHatchedArea.vertices.push([
									((fileView.getUint32(address, true) * (360.0 / 805306368.0)) - 180.0),
									(90.0 - (fileView.getUint32(address + 4, true) * (180.0 / 536870912.0)))
								]);
								address += 8;
							}
							break;
						case 0x00de: // Jetway
							address += 8; // Skip unknown field
							const sceneryObjectLength1 = fileView.getUint16(address, true);
							address += 2;
							const sceneryObjectLength2 = fileView.getUint16(address, true);
							address += 2;
							if (sceneryObjectLength1 > 0) {
								const sceneryObjectBytes = getViewBytes(fileView, address, sceneryObjectLength1);
								if (new DataView(sceneryObjectBytes.buffer, sceneryObjectBytes.byteOffset, sceneryObjectBytes.byteLength).getUint16(0, true) == 0x000b) {
									const libObj: LibraryObject = await buildLibraryObject(fileView, address);
									if (libraryObjects.has(libObj.guid)) {
										libraryObjects.get(libObj.guid)!.push(libObj);
									}
									else {
										libraryObjects.set(libObj.guid, [libObj]);
									}
								}
								else if (new DataView(sceneryObjectBytes.buffer, sceneryObjectBytes.byteOffset, sceneryObjectBytes.byteLength).getUint16(0, true) == 0x0019) {
									const simObj = await buildSimObject(fileView, address, file, configPathsByTitle);
									if (simObj.containerPath !== '') {
										if (simObjects.has(simObj.containerTitle)) {
											simObjects.get(simObj.containerTitle)!.push(simObj);
										}
										else {
											simObjects.set(simObj.containerTitle, [simObj]);
										}
										progressItems.push({
											size: getProgressSize(simObj.binPath, `sim object ${simObj.containerTitle}`),
											state: 'pending'
										});
									}
								}
								else {
									console.warn(`Unexpected scenery object type in jetway record at offset 0x${(subrecord[0] + bytesRead + airportBytesRead).toString(16)}: 0x${new DataView(sceneryObjectBytes.buffer, sceneryObjectBytes.byteOffset, sceneryObjectBytes.byteLength).getUint16(0, true).toString(16).padStart(4, '0')}`);
								}
								address += sceneryObjectLength1;
							}
							if (sceneryObjectLength2 > 0) {
								const sceneryObjectBytes = getViewBytes(fileView, address, sceneryObjectLength2);
								if (new DataView(sceneryObjectBytes.buffer, sceneryObjectBytes.byteOffset, sceneryObjectBytes.byteLength).getUint16(0, true) == 0x000b) {
									const libObj: LibraryObject = await buildLibraryObject(fileView, address);
									if (libraryObjects.has(libObj.guid)) {
										libraryObjects.get(libObj.guid)!.push(libObj);
									}
									else {
										libraryObjects.set(libObj.guid, [libObj]);
									}
								}
								else if (new DataView(sceneryObjectBytes.buffer, sceneryObjectBytes.byteOffset, sceneryObjectBytes.byteLength).getUint16(0, true) == 0x0019) {
									const simObj = await buildSimObject(fileView, address, file, configPathsByTitle);
									if (simObj.containerPath !== '') {
										if (simObjects.has(simObj.containerTitle)) {
											simObjects.get(simObj.containerTitle)!.push(simObj);
										}
										else {
											simObjects.set(simObj.containerTitle, [simObj]);
										}
										progressItems.push({
											size: getProgressSize(simObj.binPath, `sim object ${simObj.containerTitle}`),
											state: 'pending'
										});
									}
								}
								else {
									console.warn(`Unexpected scenery object type in jetway record at offset 0x${(subrecord[0] + bytesRead + airportBytesRead).toString(16)}: 0x${new DataView(sceneryObjectBytes.buffer, sceneryObjectBytes.byteOffset, sceneryObjectBytes.byteLength).getUint16(0, true).toString(16).padStart(4, '0')}`);
								}
								address += sceneryObjectLength2;
							}
							break;
						case 0x0057: // LightSupport
							address += 30; // Skip the unknown field and LightSupport structure.
							break;
						case 0x0024: // Approach
							// This has taken far too long to implement properly, so we'll skip it for now.
							address += recordSize;
							break;
						case 0x0031: // ApronEdgeLights
							address += 2; // Skip unknown record
							const vertexCtApronEdgeLights = fileView.getUint16(address, true);
							address += 2;
							const edgeCt = fileView.getUint16(address, true);
							address += 2;
							const apronEdgeLights: ApronEdgeLights = {
								coloration: [fileView.getUint8(address), fileView.getUint8(address + 1), fileView.getUint8(address + 2), fileView.getUint8(address + 3)],
								scale: fileView.getFloat32(address + 4, true),
								falloff: fileView.getFloat32(address + 8, true),
								vertices: [],
								edges: []
							};
							address += 12;
							for (let j = 0; j < vertexCtApronEdgeLights; j++) {
								apronEdgeLights.vertices.push([
									(fileView.getUint32(address, true) * (360.0 / 805306368.0)) - 180.0,
									90.0 - (fileView.getUint32(address + 4, true) * (180.0 / 536870912.0))
								]);
								address += 8;
							}
							for (let j = 0; j < edgeCt; j++) {
								apronEdgeLights.edges.push([
									fileView.getFloat32(address, true),
									fileView.getUint16(address + 4, true),
									fileView.getUint16(address + 6, true)
								]);
								address += 8;
							}
							break;
						case 0x0026: // Helipad
							const helipad: Helipad = {
								surface: fileView.getUint8(address),
								type: 0,
								transparent: false,
								closed: false,
								color: [0, 0, 0, 0],
								longitude: 0,
								latitude: 0,
								altitude: 0,
								length: 0,
								width: 0,
								heading: 0
							};
							address += 1;
							const valueHelipad = fileView.getUint8(address);
							address += 1;
							helipad.type = valueHelipad & 0b1111;
							helipad.transparent = (valueHelipad & 0b10000) !== 0;
							helipad.closed = (valueHelipad & 0b100000) !== 0;
							helipad.color = [
								fileView.getUint8(address),
								fileView.getUint8(address + 1),
								fileView.getUint8(address + 2),
								fileView.getUint8(address + 3)
							];
							address += 4;
							helipad.longitude = (fileView.getUint32(address, true) * (360.0 / 805306368.0)) - 180.0;
							address += 4;
							helipad.latitude = 90.0 - (fileView.getUint32(address, true) * (180.0 / 536870912.0));
							address += 4;
							helipad.altitude = fileView.getInt32(address, true) / 1000.0;
							address += 4;
							helipad.length = fileView.getFloat32(address, true);
							address += 4;
							helipad.width = fileView.getFloat32(address, true);
							address += 4;
							helipad.heading = fileView.getFloat32(address, true) * (360.0 / 65536.0);
							address += 4;
							break;
						case 0x00e8: // ProjectedMesh
							const projectedMesh: ProjectedMesh = {
								priority: fileView.getUint8(address),
								groundMerging: false,
								libraryObject: {} as LibraryObject
							};
							address += 2; // Skip unknown field
							const valueProjectedMesh = fileView.getInt32(address, true);
							address += 4;
							projectedMesh.groundMerging = (valueProjectedMesh & 0b1) == 1;
							const subRecordSize = fileView.getUint16(address, true);
							address += 2;
							if (fileView.getInt16(address, true) == 0x000b) {
								projectedMesh.libraryObject = await buildLibraryObject(fileView, address);
							}
							address += subRecordSize;
							break;
						default:
							console.warn(`Unexpected airport record type at offset 0x${(subrecord[0] + bytesRead + airportBytesRead).toString(16)}: 0x${recordId.toString(16).padStart(4, '0')}, skipping ${recordSize} bytes`);
							// Skip unknown record types
							address += recordSize;
							break;
					}
					airportBytesRead += recordSize;
					collectConversionGarbageIfNeeded();
				}
				bytesRead += size;
				collectConversionGarbageIfNeeded(true);
			}
		}
	}

	// Look for models after placements have been gathered
	for (const file of allBglFiles) {
		checkAbort(control);
		reportStatus(id, control, `Looking for models in ${path.basename(file)}...`);
		console.log(`Processing file: ${file}`);
		const fileBuffer = fs.readFileSync(file);
		const fileView: DataView = new DataView(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);
		let address: number = 0; // all binary indexing should use this variable
		const magicNumber1: number = fileView.getUint32(address, true);
		address = 0x10;
		const magicNumber2: number = fileView.getUint32(address, true);
		address += 4;
		if (magicNumber1 !== 0x19920201 || magicNumber2 !== 0x08051803) {
			console.warn(`Invalid BGL header in model data file: ${path.basename(file)}`);
			continue;
		}
		const recordCt = fileView.getUint32(0x14, true);

		const mdlDataOffsets: number[] = [];
		address = 0x38;
		for (let i = 0; i < recordCt; i++) {
			const recType = fileView.getUint32(address, true);
			address += 0x0C;
			const startSubsection = fileView.getUint32(address, true);
			address += 4;
			address += 8;
			if (recType === 0x002B) { // ModelData
				mdlDataOffsets.push(startSubsection);
			}
		}

		let bytesRead = 0;

		// Parse ModelData subrecords
		const modelDataSubrecords: [number, number][] = [];
		for (const mdlDataOffset of mdlDataOffsets) {
			address = mdlDataOffset + 8;
			const subrecOffset = fileView.getInt32(address, true);
			address += 4;
			const size = fileView.getInt32(address, true);
			modelDataSubrecords.push([subrecOffset, size]);
		}
		for (const subrecord of modelDataSubrecords) {
			// Reset per-subrecord counters so all subrecords are processed
			let objectsRead = 0;
			bytesRead = 0;
			while (bytesRead < subrecord[1]) {
				address = subrecord[0] + (24 * objectsRead);
				const guid: string = getGuidFromBytes(getViewBytes(fileView, address, 16));
				address += 16;
				const startModelDataOffset: number = fileView.getInt32(address, true);
				address += 4;
				const modelDataSize: number = fileView.getInt32(address, true);
				if (!libraryObjects.has(guid)) {
					console.info(`Model GUID ${guid}, size ${modelDataSize} at offset 0x${startModelDataOffset.toString(16)} not found in placements; skipping.`);
					bytesRead += modelDataSize + 24;
					objectsRead++;
					continue;
				}

				// Mark this GUID as having a model
				guidsWithModels.add(guid);
				const tileIndices: Set<number> = new Set(libraryObjects.get(guid)!.map(obj => getTileIndexFromCoord(obj.position[1], obj.position[0])));
				for (const tileIndex of tileIndices) {
					if (!modelReferencesByTile.has(tileIndex)) {
						modelReferencesByTile.set(tileIndex, []);
					}

					modelReferencesByTile.get(tileIndex)!.push({
						guid: guid,
						file: file,
						offset: startModelDataOffset + 0x80, // Why the 0x80-byte offset? Who knows?
						size: modelDataSize
					});
					progressItems.push({
						size: modelDataSize,
						state: 'pending'
					});
				}
				totalModelCount++;
				reportStatus(id, control, `Looking for models in ${path.basename(file)}... found ${totalModelCount}`);
				address = subrecord[0] + startModelDataOffset + modelDataSize;
				bytesRead += modelDataSize + 24;
				objectsRead++;
			}
		}
	}

	if (progressItems.length > 0) {
		getConversion(id).progressItems.splice(0, getConversion(id).progressItems.length, ...progressItems);
		reportProgress(id, control);
	}

	totalModelCount = Array.from(modelReferencesByTile.values()).reduce((sum, l) => sum + l.length, 0);
	console.info(`Found ${totalModelCount} models`);
	if (totalModelCount === 0) {
		return;
	}

	for (const [tileIndex, modelReferences] of modelReferencesByTile.entries()) {
		checkAbort(control);
		reportStatus(id, control, `Converting tile ${tileIndex}...`);
		const simObjectsForTile: SimObject[] = [];
		let center: vec3 = [0, 0, 0];
		for (const simObject of simObjects) {
			for (const simObjectPlacement of simObject[1]) {
				if (getTileIndexFromCoord(simObjectPlacement.position[1], simObjectPlacement.position[0]) === tileIndex) {
					simObjectsForTile.push(simObjectPlacement);
					center[0] += simObjectPlacement.position[0];
					center[1] += simObjectPlacement.position[1];
					center[2] += simObjectPlacement.position[2];
				}
			}
		}
		console.info(`Tile ${tileIndex} has ${modelReferences.length} model references and ${simObjectsForTile.length} sim objects`);
		const libraryObjectsForTile: LibraryObject[] = [];
		for (const guid of guidsWithModels) {
			const objects = libraryObjects.get(guid);
			if (objects) {
				for (const obj of objects) {
					if (getTileIndexFromCoord(obj.position[1], obj.position[0]) === tileIndex) {
						libraryObjectsForTile.push(obj);
						center[0] += obj.position[0];
						center[1] += obj.position[1];
						center[2] += obj.position[2];
					}
				}
			}
		}
		const placementCount = simObjectsForTile.length + libraryObjectsForTile.length;
		if (placementCount > 0) {
			center[0] /= placementCount;
			center[1] /= placementCount;
			center[2] /= placementCount;
		} else {
			const coord = getCoordFromTileIndex(tileIndex);
			center = [coord.lon, coord.lat, 0];
		}

		await assembleModel(id, inputPath, outputPath, tileIndex, [...simObjectsForTile, ...modelReferences], center, libraryObjects, control);
		collectConversionGarbageIfNeeded(true);
	}
}
