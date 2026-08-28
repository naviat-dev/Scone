import { getTileIndexFromCoord, getCoordFromTileIndex, getAltitude } from './terrain.js';
import { LibraryObject, SimObject, Flags, Airport, Tower, Runway } from './structures.js'
import * as fs from 'fs';
import * as path from 'path';

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
	const guid = getGuidFromBytes(new Uint8Array(fileView.buffer, fileView.byteOffset + address + 44, 16));
	const scale = fileView.getFloat32(address + 60, true);
	return { longitude, latitude, altitude, flags, pitch, bank, heading, imageComplexity, guid, scale };
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
	const containerTitle = new TextDecoder().decode(new Uint8Array(fileView.buffer, fileView.byteOffset + address + 52, containerTitleLength));
	const containerPath = new TextDecoder().decode(new Uint8Array(fileView.buffer, fileView.byteOffset + address + 52 + containerTitleLength, containerPathLength));
	return { longitude, latitude, altitude, flags, pitch, bank, heading, imageComplexity, containerTitle, containerPath, scale };
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

export function convertScenery(inputPath: string, outputPath: string, isGltf: boolean, isAc3d: boolean): void {
	if (!fs.existsSync(inputPath)) {
		throw new Error(`Input path does not exist: ${inputPath}`);
	}

	const libraryObjects: Map<string, LibraryObject[]> = new Map();
	const simObjects: Map<string, SimObject[]> = new Map();

	const allBglFiles: string[] = fs.readdirSync(inputPath).filter((file: string): boolean => path.extname(file).toLowerCase() === '.bgl');
	let totalLibraryObjects: number = 0;
	for (const file of allBglFiles) {
		console.log(`Processing file: ${file}`);
		const fileBuffer: ArrayBuffer = fs.readFileSync(file).buffer;
		const fileView: DataView = new DataView(fileBuffer);
		const magicNumber1: number = fileView.getUint32(0, true);
		const magicNumber2: number = fileView.getUint32(0x10, true);
		if (magicNumber1 !== 0x19920201 || magicNumber2 !== 0x08051803) {
			continue;
		}
		const recordCt = fileView.getUint32(0x14, true);

		const sceneryObjectOffsets: number[] = [];
		const airportOffsets: number[] = [];
		let address: number = 0x38; // all binary indexing should use this variable
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
					console.warn(`Unexpected subrecord type at offset 0x${subrecord[0] + bytesRead.toString(16)}: 0x${id.toString(16)}, skipping ${size} bytes`);
					bytesRead += size;
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
					console.warn(`Unexpected airport subrecord type at offset 0x${subrecord[0] + bytesRead.toString(16)}: 0x${id.toString(16)}, skipping ${skip} bytes`);
					bytesRead += skip;
					continue;
				}
				let airport: Airport = {
					longitude: -1,
					latitude: -1,
					altitude: -1,
					tower: {} as Tower,
					magvar: -1,
					icao: "",
					regIdent: "",
					name: "",
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
				const apronCt = fileView.getUint16(address);
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
					const recordSize = fileView.getUint16(address, true);
					address += 2; // Move past the record size
					switch (recordId) {
						case 0x0019: // Airport Name
							airport.name = new TextDecoder('utf-8').decode(new Uint8Array(fileView.buffer, address, recordSize));
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
								coloration: [-1 , -1, -1, -1], // RGBA bytes
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

							for (let j = 0; j < 16; j++)
							{
								if (((markingValue >> j) & 1) != 0)
								{
									runway.markingTypes.push(j);
								}
							}

							if ((lightValue & (1 << 5)) != 0)
							{
								runway.markingTypes.push(16);
							}
							if ((lightValue & (1 << 6)) != 0)
							{
								runway.markingTypes.push(17);
							}
							if ((lightValue & (1 << 7)) != 0)
							{
								runway.markingTypes.push(18);
							}

							const edgeLightsValue = lightValue & 0b11;
							runway.lightTypes.push(edgeLightsValue);

							const centerLightsValue = (lightValue >> 2) & 0b11;
							runway.lightTypes.push(4 + centerLightsValue);

							if ((lightValue & (1 << 4)) != 0)
							{
								runway.lightTypes.push(8);
							}

							if ((patternValue & (1 << 0)) != 0)
							{
								runway.patternTypes.push(0);
							}
							if ((patternValue & (1 << 1)) != 0)
							{
								runway.patternTypes.push(1);
							}
							if ((patternValue & (1 << 2)) != 0)
							{
								runway.patternTypes.push(2);
							}
							if ((patternValue & (1 << 3)) != 0)
							{
								runway.patternTypes.push(3);
							}
							if ((patternValue & (1 << 4)) != 0)
							{
								runway.patternTypes.push(4);
							}
							if ((patternValue & (1 << 5)) != 0)
							{
								runway.patternTypes.push(5);
							}
							runway.groundMerging = (patternValue & (1 << 6)) != 0;
							runway.excludeVegetationAround = (patternValue & (1 << 7)) != 0;
							address += 0x14;
							runway.falloff = fileView.getFloat32(address, true);
							address += 4;
							runway.surface = getGuidFromBytes(new Uint8Array(fileView.buffer, address, 16));
							address += 16;
							runway.coloration = [
								fileView.getUint8(address),
								fileView.getUint8(address + 1),
								fileView.getUint8(address + 2),
								fileView.getUint8(address + 3)
							];
							address += 4;
							let runwayBytesRead = 0x60;
							while (runwayBytesRead < recordSize)
								{
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
											surface: getGuidFromBytes(new Uint8Array(fileView.buffer, address + 4, 16)),
											length: fileView.getFloat32(address + 20, true),
											width: fileView.getFloat32(address + 24, true),
										});
										address += 28
									}
									else if (runwayRecordId == 0x0007 || runwayRecordId == 0x0008) // BlastPad
									{
										runway.blastPads.push({
											fsXSurface: fileView.getFloat32(address, true),
											surface: getGuidFromBytes(new Uint8Array(fileView.buffer, address + 4, 16)),
											length: fileView.getFloat32(address + 20, true),
											width: fileView.getFloat32(address + 24, true),
										});
										address += 28;
									}
									else if (runwayRecordId == 0x0065 || runwayRecordId == 0x0066) // Overrun
									{
										runway.overruns.push({
											fsXSurface: fileView.getFloat32(address, true),
											surface: getGuidFromBytes(new Uint8Array(fileView.buffer, address + 4, 16)),
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
											guid: getGuidFromBytes(new Uint8Array(fileView.buffer, address + 1, 16)),
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
						default:
							// Skip unknown record types
							break;
						
					}
				}
			}
		}
	}
}