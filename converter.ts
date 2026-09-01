import { getTileIndexFromCoord, getCoordFromTileIndex, getAltitude } from './terrain.js';
import { LibraryObject, SimObject, Flags, Airport, Tower, Runway, RunwayStart, TaxiwayPoint, TaxiwayParking, TaxiwayPath, TaxiwayPathType, Apron, TaxiwaySign, PaintedLine, PaintedHatchedArea, ApronEdgeLights, Helipad, ProjectedMesh, ModelReference } from './structures.js'
import { config } from './config.js';
import { applyAsoboGeometryRepair, repairDocument, optimizeDocument } from './repair.js';
import * as fs from 'fs';
import * as path from 'path';
import { create } from 'xmlbuilder2';
import { vec3, mat4 } from 'gl-matrix';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Document, NodeIO } from '@gltf-transform/core';

const execFileAsync = promisify(execFile);

export type ConversionAbortMode = 'save' | 'discard';

export type ConversionControl = {
	shouldAbort?: () => ConversionAbortMode | null;
	onStatus?: (status: string) => void;
};

export class ConversionAbortedError extends Error {
	public readonly mode: ConversionAbortMode;

	constructor(mode: ConversionAbortMode) {
		super(`Conversion aborted (${mode})`);
		this.name = 'ConversionAbortedError';
		this.mode = mode;
	}
}

function reportStatus(control: ConversionControl | undefined, status: string): void {
	control?.onStatus?.(status);
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

function buildLibraryObject(fileView: DataView, address: number): LibraryObject {
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
	return { position: [longitude, latitude, altitude], flags, orientation: [pitch, bank, heading], imageComplexity, guid, scale };
}

function buildSimObject(fileView: DataView, address: number): SimObject {
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
	const containerPath = new TextDecoder().decode(getViewBytes(fileView, address + 52 + containerTitleLength, containerPathLength));
	return { position: [longitude, latitude, altitude], flags, orientation: [pitch, bank, heading], imageComplexity, containerTitle, containerPath, scale };
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

function parseValidatorErrorCount(report: unknown): number {
	const messages = (report as { issues?: { messages?: Array<{ severity?: number }>; numErrors?: number } })?.issues?.messages;
	if (Array.isArray(messages)) {
		return messages.filter((message) => message?.severity === 0).length;
	}

	const numErrors = (report as { issues?: { numErrors?: number } })?.issues?.numErrors;
	return typeof numErrors === 'number' ? numErrors : 0;
}

async function runGltfValidator(validatorExecutable: string, modelPath: string, reportPath: string): Promise<number> {
	let stdoutText = '';
	let stderrText = '';
	let executionErrorMessage = '';

	try {
		const result = await execFileAsync(validatorExecutable, ['--no-validate-resources', '-a', modelPath], {
			maxBuffer: 10 * 1024 * 1024,
		});
		stdoutText = `${result.stdout ?? ''}`;
		stderrText = `${result.stderr ?? ''}`;
	} catch (error) {
		const execError = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
		stdoutText = `${execError.stdout ?? ''}`;
		stderrText = `${execError.stderr ?? execError.message ?? ''}`;
		executionErrorMessage = execError.message ?? '';
	}

	if (stderrText.trim().length > 0) {
		console.error(`Validator stderr: ${stderrText}`);
	}

	const reportText = stdoutText.trim().length > 0
		? stdoutText
		: fs.existsSync(reportPath)
			? fs.readFileSync(reportPath, 'utf-8')
			: '{}';

	if (stdoutText.trim().length === 0 && !fs.existsSync(reportPath) && executionErrorMessage.length > 0) {
		throw new Error(`Failed to run glTF validator at ${validatorExecutable}: ${executionErrorMessage}`);
	}

	let report: unknown;
	try {
		report = JSON.parse(reportText) as unknown;
	} catch {
		if (fs.existsSync(reportPath)) {
			report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as unknown;
		} else {
			throw new Error(`glTF validator did not produce valid JSON output for ${modelPath}`);
		}
	}

	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
	return parseValidatorErrorCount(report);
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

function createPlacementTransform(center: vec3, position: vec3, orientation: vec3, scale: vec3): mat4 {
	const deg2rad = Math.PI / 180.0;
	const transform = mat4.create();
	const lonOffsetMeters = -(position[1] - center[1]) * 111320.0 * Math.cos(center[0] * deg2rad);
	const latOffsetMeters = (position[0] - center[0]) * 110540.0;
	mat4.translate(transform, transform, vec3.fromValues(latOffsetMeters, lonOffsetMeters, position[2] - center[2]));
	mat4.rotateZ(transform, transform, orientation[2] * deg2rad);
	mat4.rotateX(transform, transform, orientation[0] * deg2rad);
	mat4.rotateY(transform, transform, orientation[1] * deg2rad);
	mat4.scale(transform, transform, scale);
	return transform;
}

function resolveAbsoluteTexturePath(inputPath: string, file: string, textureUri: string): string {
	textureUri = textureUri.replace(/\//g, path.sep);
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

async function assembleModel(inputPath: string, outputPath: string, tileIndex: number, modelReferences: ModelReference[], center: vec3, libraryObjects: Map<string, LibraryObject[]>, control?: ConversionControl) {
	const tempTilePath = path.join(config.tempDir, `tile_${tileIndex}_${Date.now()}`);
	const tempBinPath = path.join(tempTilePath, 'temp.bin');
	const tempGltfPath = path.join(tempTilePath, 'temp.gltf');
	const tempReportPath = path.join(tempTilePath, 'temp.gltf.report.json');
	const validatorExecutable = config.gltfValidationPath;
	fs.mkdirSync(tempTilePath, { recursive: true });
	try {
		for (const modelRef of modelReferences) {
			checkAbort(control);
			reportStatus(control, `Processing model source ${path.basename(modelRef.file)}...`);
			// TODO: increase the model count here, without making this object-oriented
			const libraryObjectsForModel = libraryObjects.get(modelRef.guid) || [];
			const modelFileBuffer = fs.readFileSync(modelRef.file);
			if (modelRef.offset < 0 || modelRef.offset + modelRef.size > modelFileBuffer.byteLength) {
				console.warn(`Model reference out of bounds for ${modelRef.file}: offset=0x${modelRef.offset.toString(16)} size=${modelRef.size}`);
				continue;
			}

			const fileBuffer = modelFileBuffer.subarray(modelRef.offset, modelRef.offset + modelRef.size);
			const fileView: DataView = new DataView(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);
			console.debug(`Model reference: ${modelRef.file} at offset 0x${modelRef.offset.toString(16)} size ${modelRef.size} guid ${modelRef.guid}`);
			let name = '';
			const chunkID: string = readFourCC(fileBuffer, 0);
			if (chunkID !== 'RIFF') {
				continue;
			}

			// Enter this model and get LOD info, GLB files, and mesh data
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
					reportStatus(control, `Converting ${name || modelRef.guid}...`);
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
						if (sig === 'GLB\0') {
							const glbSize: number = fileView.getUint32(j + 4, true);
							if (j + 8 + glbSize > fileBuffer.byteLength) {
								console.warn(`Invalid GLB payload size ${glbSize} for model ${modelRef.guid}`);
								break;
							}

							const glbBytes = fileBuffer.subarray(j + 8, j + 8 + glbSize);
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

							const jsonBytes = glbBytes.subarray(jsonStart, jsonEnd);
							for (let k = 0; k < jsonBytes.length; k++) {
								if (jsonBytes[k] < 32 || jsonBytes[k] > 126) {
									jsonBytes[k] = 32; // replace non-printable characters with space
								}
							}

							const json: Record<string, unknown> = JSON.parse(Buffer.from(jsonBytes).toString('utf-8').trim());
							const meshes = Array.isArray(json.meshes) ? json.meshes : [];
							const accessors = Array.isArray(json.accessors) ? json.accessors : [];
							const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : [];
							if (bufferViews.length === 0 || accessors.length === 0 || meshes.length === 0) {
								console.info(`GLB in model ${name} (${modelRef.guid}) has no mesh data; skipping.`);
								// Advance j past this GLB record (type[4] + size[4] + payload[glbSize])
								j += 8 + glbSize;
								continue;
							}

							const binChunkHeader = jsonEnd;
							if (binChunkHeader + 8 > glbBytes.byteLength) {
								console.warn(`GLB missing BIN chunk for model ${modelRef.guid}`);
								j += 8 + glbSize;
								continue;
							}

							const binChunkLength = glbView.getUint32(binChunkHeader, true);
							const binStart = binChunkHeader + 8;
							const binEnd = binStart + binChunkLength;
							if (binEnd > glbBytes.byteLength) {
								console.warn(`GLB BIN chunk exceeds payload bounds for model ${modelRef.guid}`);
								j += 8 + glbSize;
								continue;
							}

							const glbBinBytes = glbBytes.subarray(binStart, binEnd);
							if (Array.isArray(json.buffers) && json.buffers.length > 0 && typeof json.buffers[0] === 'object' && json.buffers[0] !== null) {
								(json.buffers[0] as Record<string, unknown>).uri = 'temp.bin';
							}
							delete (json as { extensionsRequired?: unknown }).extensionsRequired;

							const images = Array.isArray(json.images) ? json.images : [];
							for (const image of images) {
								if (!image || typeof image !== 'object') {
									continue;
								}

								const imageRecord = image as Record<string, unknown>;
								const uri = typeof imageRecord.uri === 'string' ? imageRecord.uri : '';
								if (uri.length === 0) {
									continue;
								}

								const outputUri = `${path.basename(uri, path.extname(uri))}.DDS`;
								imageRecord.uri = outputUri;
								const extras = (imageRecord.extras && typeof imageRecord.extras === 'object')
									? imageRecord.extras as Record<string, unknown>
									: {};
								const absoluteTexturePath = resolveAbsoluteTexturePath(inputPath, modelRef.file, uri);
								extras.absolutePath = absoluteTexturePath;
								imageRecord.extras = extras;

								const outputTexturePath = path.join(tempTilePath, outputUri);
								if (!fs.existsSync(outputTexturePath)) {
									if (absoluteTexturePath.length > 0 && fs.existsSync(absoluteTexturePath)) {
										fs.copyFileSync(absoluteTexturePath, outputTexturePath);
									} else {
										console.warn(`Texture file not found: ${uri}`);
										const fallbackTexturePath = path.join(process.cwd(), 'Assets', 'dummy_tex.dds');
										if (fs.existsSync(fallbackTexturePath)) {
											fs.copyFileSync(fallbackTexturePath, outputTexturePath);
										}
									}
								}
							}

							fs.writeFileSync(tempGltfPath, JSON.stringify(json), 'utf-8');
							fs.writeFileSync(tempBinPath, glbBinBytes);

							const document: Document = await new NodeIO().read(tempGltfPath);
							// Repair Asobo-specific geometry issues, then re-export for validation
							applyAsoboGeometryRepair(document);
							await new NodeIO().write(tempGltfPath, document);

							let errorCount = await runGltfValidator(validatorExecutable, tempGltfPath, tempReportPath);
							let tries = 0;
							while (tries < config.maxRepairRetries && errorCount > 0) {
								checkAbort(control);
								tries++;
								console.warn(`Attempt ${tries} to repair geometry for model ${name} (${modelRef.guid})`);
								repairDocument(document, tempGltfPath, tempReportPath);
								await new NodeIO().write(tempGltfPath, document);
								errorCount = await runGltfValidator(validatorExecutable, tempGltfPath, tempReportPath);
							}

							if (errorCount > 0) {
								console.error(`Failed to repair geometry for model ${name} (${modelRef.guid}) after ${tries} attempts`);
								const issues = JSON.parse(fs.readFileSync(tempReportPath, 'utf-8')).issues?.messages ?? [];
								for (const error of issues) {
									if (error.severity === 0) {
										console.error(`${error.code} at ${error.pointer}: ${error.message}`);
									}
								}
								j += 8 + glbSize;
								continue;
							}

							for (const libObj of libraryObjectsForModel) {
								if (getTileIndexFromCoord(libObj.position[1], libObj.position[0]) === tileIndex) {
									const transform: mat4 = createPlacementTransform(center, libObj.position, libObj.orientation, [libObj.scale]);
								}
							}

							glbIndex++;
							j += 8 + glbSize;
						} else {
							j += 4;
						}
					}

					i += size;
				}
			}
		}
	} finally {
		fs.rmSync(tempTilePath, { recursive: true, force: true });
	}
}

export async function convertScenery(inputPath: string, outputPath: string, control?: ConversionControl): Promise<void> {
	if (!fs.existsSync(inputPath)) {
		throw new Error(`Input path does not exist: ${inputPath}`);
	}
	reportStatus(control, 'Scanning scenery files...');

	const libraryObjects: Map<string, LibraryObject[]> = new Map();
	const simObjects: Map<string, SimObject[]> = new Map();
	const airports: Airport[] = [];
	const guidsWithModels: Set<string> = new Set();
	const modelReferencesByTile: Map<number, ModelReference[]> = new Map();
	const allBglFiles: string[] = getFilesRecursive(inputPath, '.bgl', false);

	let totalModelCount: number = 0;

	let totalLibraryObjects: number = 0;
	for (const file of allBglFiles) {
		checkAbort(control);
		reportStatus(control, `Looking for placements in ${path.basename(file)}...`);
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
				const id = fileView.getUint16(address, true);
				address += 2;
				const size = fileView.getUint16(address, true);
				address += 2;
				if (id === 0x0B) { // LibraryObject
					address -= 4; // Reverse back to get all of the bytes
					const libraryObject = buildLibraryObject(fileView, address);
					if (!libraryObjects.has(libraryObject.guid)) {
						libraryObjects.set(libraryObject.guid, []);
					}
					libraryObjects.get(libraryObject.guid)!.push(libraryObject);
				} else if (id === 0x19) { //SimObject
					address -= 4; // Reverse back to get all of the bytes
					const simObject = buildSimObject(fileView, address);
					if (!simObjects.has(simObject.containerPath)) {
						simObjects.set(simObject.containerPath, []);
					}
					simObjects.get(simObject.containerPath)!.push(simObject);
				} else {
					console.warn(`Unexpected subrecord type at offset 0x${(subrecord[0] + bytesRead).toString(16)}: 0x${id.toString(16)}, skipping ${size} bytes`);
					bytesRead += size;
					// AI says this should be bytesRead instead of size
					address = subrecord[0] + size;
					continue;
				}
				totalLibraryObjects++;
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
				const id = fileView.getUint16(address, true);
				address += 2;
				if (id !== 0x0056) { // Airport subrecord type
					const skip = fileView.getUint32(address, true);
					console.warn(`Unexpected airport subrecord type at offset 0x${(subrecord[0] + bytesRead).toString(16)}: 0x${id.toString(16)}, skipping ${skip} bytes`);
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
				const runwayCt = fileView.getUint8(address);
				address += 1;
				const comCt = fileView.getUint8(address);
				address += 1;
				const startCt = fileView.getUint8(address);
				address += 1;
				const appCt = fileView.getUint8(address);
				address += 1;
				const legacyApronCt = fileView.getUint8(address);
				address += 1;
				const helipadCt = fileView.getUint8(address);
				address += 1;
				airport.longitude = (fileView.getUint32(address, true) * (360.0 / 805306368.0)) - 180.0;
				address += 4;
				airport.latitude = 90.0 - (fileView.getUint32(address, true) * (180.0 / 536870912.0));
				address += 4;
				airport.altitude = fileView.getInt32(address, true) / 1000.0;
				address += 4;
				airport.tower = {
					latitude: 90.0 - (fileView.getInt32(address, true) * (180.0 / 536870912.0)),
					longitude: (fileView.getInt32(address + 4, true) * (360.0 / 805306368.0)) - 180.0,
					altitude: fileView.getInt32(address + 8, true) / 1000.0
				};
				address += 12;
				airport.magvar = fileView.getUint8(address);
				address += 1;
				airport.icao = convertIcaoBytesToString(fileView.getUint32(address, true));
				address += 4;
				airport.regIdent = convertIcaoBytesToString(fileView.getUint32(address, true));
				address = subrecord[0] + bytesRead + 0x37; // Skip ahead to departure count
				const departureCt = fileView.getUint8(address);
				address = subrecord[0] + bytesRead + 0x39; // Skip ahead to arrival count
				const arrivalCt = fileView.getUint8(address);
				address = subrecord[0] + bytesRead + 0x3c; // Skip ahead to remaining useful records
				const apronCt = fileView.getUint16(address, true);
				address += 2;
				const paintedLineCt = fileView.getUint16(address, true);
				address += 2;
				const paintedPolygonCt = fileView.getUint16(address, true);
				address += 2;
				const paintedHatchedAreaCt = fileView.getUint16(address, true);
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
							airport.runways.push(runway);
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
							airport.runwayStarts.push(runwayStart);
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
								airport.taxiwayPoints.push(taxiwayPoint);
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
								airport.taxiwayParkings.push(taxiwayParking);
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
								airport.taxiwayPaths.push(taxiwayPath);
							}
							break;
						case 0x001d: // TaxiName
							const taxiNameCount = fileView.getUint16(address, true);
							address += 2;
							for (let j = 0; j < taxiNameCount; j++) {
								airport.taxiNames.push(new TextDecoder().decode(getViewBytes(fileView, address, 8)));
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
							airport.aprons.push(apron);
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
							airport.taxiwaySigns.push(taxiwaySign);
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
							airport.paintedLines.push(paintedLine);
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
							airport.paintedHatchedAreas.push(paintedHatchedArea);
							break;
						case 0x00de: // Jetway
							airport.jetways.push({
								parkingNumber: fileView.getUint16(address, true),
								gateName: fileView.getUint16(address + 2, true),
								suffix: fileView.getUint16(address + 4, true),
							});
							address += 8; // Skip unknown field
							const sceneryObjectLength1 = fileView.getUint16(address, true);
							address += 2;
							const sceneryObjectLength2 = fileView.getUint16(address, true);
							address += 2;
							if (sceneryObjectLength1 > 0) {
								const sceneryObjectBytes = getViewBytes(fileView, address, sceneryObjectLength1);
								if (new DataView(sceneryObjectBytes.buffer, sceneryObjectBytes.byteOffset, sceneryObjectBytes.byteLength).getUint16(0, true) == 0x000b) {
									const libObj: LibraryObject = buildLibraryObject(fileView, address);
									if (libraryObjects.has(libObj.guid)) {
										libraryObjects.get(libObj.guid)!.push(libObj);
									}
									else {
										libraryObjects.set(libObj.guid, [libObj]);
									}
								}
								else if (new DataView(sceneryObjectBytes.buffer, sceneryObjectBytes.byteOffset, sceneryObjectBytes.byteLength).getUint16(0, true) == 0x0019) {
									const simObj = buildSimObject(fileView, address);
									if (simObjects.has(simObj.containerPath)) {
										simObjects.get(simObj.containerPath)!.push(simObj);
									}
									else {
										simObjects.set(simObj.containerPath, [simObj]);
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
									const libObj: LibraryObject = buildLibraryObject(fileView, address);
									if (libraryObjects.has(libObj.guid)) {
										libraryObjects.get(libObj.guid)!.push(libObj);
									}
									else {
										libraryObjects.set(libObj.guid, [libObj]);
									}
								}
								else if (new DataView(sceneryObjectBytes.buffer, sceneryObjectBytes.byteOffset, sceneryObjectBytes.byteLength).getUint16(0, true) == 0x0019) {
									const simObj = buildSimObject(fileView, address);
									if (simObjects.has(simObj.containerPath)) {
										simObjects.get(simObj.containerPath)!.push(simObj);
									}
									else {
										simObjects.set(simObj.containerPath, [simObj]);
									}
								}
								else {
									console.warn(`Unexpected scenery object type in jetway record at offset 0x${(subrecord[0] + bytesRead + airportBytesRead).toString(16)}: 0x${new DataView(sceneryObjectBytes.buffer, sceneryObjectBytes.byteOffset, sceneryObjectBytes.byteLength).getUint16(0, true).toString(16).padStart(4, '0')}`);
								}
								address += sceneryObjectLength2;
							}
							break;
						case 0x0057: // LightSupport
							address += 2; // Skip unknown field
							airport.lightSupports.push({
								latitude: 90.0 - (fileView.getUint32(address, true) * (180.0 / 536870912.0)),
								longitude: (fileView.getUint32(address + 4, true) * (360.0 / 805306368.0)) - 180.0,
								altitude: fileView.getInt32(address + 8, true) / 1000.0,
								altitude2: fileView.getInt32(address + 12, true) / 1000.0,
								heading: fileView.getFloat32(address + 16, true) * (360.0 / 65536.0),
								width: fileView.getFloat32(address + 20, true),
								length: fileView.getFloat32(address + 24, true),
							});
							address += 28; // Move past the entire LightSupport structure
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
							airport.apronEdgeLights.push(apronEdgeLights);
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
							airport.helipads.push(helipad);
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
								projectedMesh.libraryObject = buildLibraryObject(fileView, address);
							}
							address += subRecordSize;
							airport.projectedMeshes.push(projectedMesh);
							break;
						default:
							console.warn(`Unexpected airport record type at offset 0x${(subrecord[0] + bytesRead + airportBytesRead).toString(16)}: 0x${recordId.toString(16).padStart(4, '0')}, skipping ${recordSize} bytes`);
							// Skip unknown record types
							address += recordSize;
							break;
					}
					airportBytesRead += recordSize;
				}
				airports.push(airport);
				bytesRead += size;
			}
		}
	}

	// Look for models after placements have been gathered
	for (const file of allBglFiles) {
		checkAbort(control);
		reportStatus(control, `Looking for models in ${path.basename(file)}...`);
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
			const subrecordCount = fileView.getUint32(address, true);
			address += 4;
			const startSubsection = fileView.getUint32(address, true);
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
				}
				address = subrecord[0] + startModelDataOffset + modelDataSize;
				bytesRead += modelDataSize + 24;
				objectsRead++;
			}
		}
	}

	totalModelCount = Array.from(modelReferencesByTile.values()).reduce((sum, l) => sum + l.length, 0);
	console.info(`Found ${totalModelCount} models`);
	if (totalModelCount === 0) {
		return;
	}

	for (const [tileIndex, modelReferences] of modelReferencesByTile.entries()) {
		checkAbort(control);
		reportStatus(control, `Converting tile ${tileIndex}...`);
		const animations = [];
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
		const modelRefs: ModelReference[] = modelReferences.sort((a, b) => b.size - a.size);
		console.info(`Tile ${tileIndex} has ${modelRefs.length} model references and ${simObjectsForTile.length} sim objects`);
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

		await assembleModel(inputPath, outputPath, tileIndex, modelRefs, center, libraryObjects, control);
	}
}