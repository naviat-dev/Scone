import fs from 'node:fs';
import zlib from 'node:zlib';

type Coordinates = { lat: number; lon: number };
type BtgData = {
	version: number;
	epoch: number;
	center: [number, number, number];
	vertexOffsets: Array<[number, number, number]>;
	triangles: Array<[number, number, number]>;
};
type Vertex = Coordinates & { alt: number };
type TileTriangle = {
	a: number;
	b: number;
	c: number;
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
};
type TileModel = { vertices: Vertex[]; triangles: TileTriangle[] };
type HeightFieldTile = {
	columns: number;
	rows: number;
	originLon: number;
	originLat: number;
	originAlt: number;
	xInterval: number;
	yInterval: number;
	heights: Float32Array;
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
};
type HeightFieldModel = { tiles: HeightFieldTile[] };

type BtgProperty = { type: number; data: Buffer };
type BtgElement = { byteLength: number; data: Buffer };

const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;
const OSG_HEADER_LOW = 0x6c910ea1;
const OSG_HEADER_HIGH = 0x1afb4545;
const OSG_ATTR_CUSTOM_DOMAINS = 0x1;
const OSG_ATTR_SCHEMA_DATA = 0x2;
const OSG_FLOAT_ARRAY = 6;

class Reader {
	private offset = 0;

	constructor(private readonly buffer: Buffer) {}

	readU8(): number {
		const value = this.buffer.readUInt8(this.offset);
		this.offset += 1;
		return value;
	}

	readU16(): number {
		const value = this.buffer.readUInt16LE(this.offset);
		this.offset += 2;
		return value;
	}

	readU32(): number {
		const value = this.buffer.readUInt32LE(this.offset);
		this.offset += 4;
		return value;
	}

	readI32(): number {
		const value = this.buffer.readInt32LE(this.offset);
		this.offset += 4;
		return value;
	}

	readU64(): number {
		const value = this.buffer.readBigUInt64LE(this.offset);
		this.offset += 8;
		const asNumber = Number(value);
		if (!Number.isSafeInteger(asNumber)) {
			throw new Error('Encountered 64-bit value outside Number safe integer range.');
		}
		return asNumber;
	}

	readBool(): boolean {
		return this.readU8() !== 0;
	}

	readString(): string {
		const length = this.readI32();
		if (length < 0) {
			throw new Error('Negative string length in OSGB stream.');
		}
		if (length === 0) {
			return '';
		}
		return this.readBytes(length).toString('utf-8');
	}

	readF32(): number {
		const value = this.buffer.readFloatLE(this.offset);
		this.offset += 4;
		return value;
	}

	readF64(): number {
		const value = this.buffer.readDoubleLE(this.offset);
		this.offset += 8;
		return value;
	}

	readBytes(length: number): Buffer {
		const value = this.buffer.subarray(this.offset, this.offset + length);
		this.offset += length;
		return value;
	}

	tell(): number {
		return this.offset;
	}

	seek(offset: number): void {
		if (offset < 0 || offset > this.buffer.length) {
			throw new Error(`Reader seek out of bounds: ${offset}`);
		}
		this.offset = offset;
	}
}

function getIndexTypes(properties: BtgProperty[], defaultBits: number): number {
	const property = properties.find(({ type, data }) => type === 1 && data.byteLength > 0);
	return property ? property.data[0] : defaultBits;
}

function vertexIndexPosition(indexTypes: number): number {
	let position = 0;
	for (const bit of [0, 1, 2, 3]) {
		if (indexTypes & (1 << bit)) {
			if (bit === 0) return position;
			position += 1;
		}
	}
	return 0;
}

function parseBtg(buffer: Buffer): BtgData {
	const reader = new Reader(buffer);
	const version = reader.readU16();
	const magic = reader.readU16();
	const epoch = reader.readU32();
	const uses32BitLayout = version >= 10;
	const objectCount = uses32BitLayout ? reader.readU32() : reader.readU16();

	if (magic !== 0x5347) throw new Error('Invalid BTG magic');

	let center: [number, number, number] = [0, 0, 0];
	const vertexOffsets: Array<[number, number, number]> = [];
	const triangles: Array<[number, number, number]> = [];

	for (let objectIndex = 0; objectIndex < objectCount; objectIndex += 1) {
		const type = reader.readU8();
		const propertyCount = uses32BitLayout ? reader.readU32() : reader.readU16();
		const elementCount = uses32BitLayout ? reader.readU32() : reader.readU16();
		const properties: BtgProperty[] = [];

		for (let index = 0; index < propertyCount; index += 1) {
			const propertyType = reader.readU8();
			const byteLength = reader.readU32();
			properties.push({ type: propertyType, data: reader.readBytes(byteLength) });
		}

		const elements: BtgElement[] = [];
		for (let index = 0; index < elementCount; index += 1) {
			const byteLength = reader.readU32();
			elements.push({ byteLength, data: reader.readBytes(byteLength) });
		}

		if (type === 0) {
			for (const element of elements) {
				const elementReader = new Reader(element.data);
				center = [elementReader.readF64(), elementReader.readF64(), elementReader.readF64()];
				elementReader.readF32();
			}
			continue;
		}

		if (type === 1) {
			for (const element of elements) {
				const elementReader = new Reader(element.data);
				for (let offset = 0; offset + 12 <= element.byteLength; offset += 12) {
					vertexOffsets.push([elementReader.readF32(), elementReader.readF32(), elementReader.readF32()]);
				}
			}
			continue;
		}

		if (type < 10 || type > 12) continue;

		const indexTypes = getIndexTypes(properties, 1 | 8);
		const indexByteLength = uses32BitLayout ? 4 : 2;
		const tupleIndexCount = Math.max(1, [0, 1, 2, 3].filter((bit) => indexTypes & (1 << bit)).length);
		const tupleByteLength = tupleIndexCount * indexByteLength;
		const vertexPosition = vertexIndexPosition(indexTypes);

		for (const element of elements) {
			const elementReader = new Reader(element.data);
			const tupleCount = Math.floor(element.byteLength / tupleByteLength);
			const vertices: number[] = [];

			for (let tupleIndex = 0; tupleIndex < tupleCount; tupleIndex += 1) {
				let vertexIndex = 0;
				for (let tupleElement = 0; tupleElement < tupleIndexCount; tupleElement += 1) {
					const value = uses32BitLayout ? elementReader.readU32() : elementReader.readU16();
					if (tupleElement === vertexPosition) vertexIndex = value;
				}
				vertices.push(vertexIndex);
			}

			if (type === 10) {
				for (let index = 0; index + 2 < vertices.length; index += 3) {
					triangles.push([vertices[index], vertices[index + 1], vertices[index + 2]]);
				}
			} else if (type === 11) {
				for (let index = 2; index < vertices.length; index += 1) {
					triangles.push(index % 2 === 0
						? [vertices[index - 2], vertices[index - 1], vertices[index]]
						: [vertices[index - 1], vertices[index - 2], vertices[index]]);
				}
			} else {
				for (let index = 2; index < vertices.length; index += 1) {
					triangles.push([vertices[0], vertices[index - 1], vertices[index]]);
				}
			}
		}
	}

	return { version, epoch, center, vertexOffsets, triangles };
}

function ecefToLla(x: number, y: number, z: number): Coordinates & { alt: number } {
	const semiMinorAxis = WGS84_A * Math.sqrt(1 - WGS84_E2);
	const secondEccentricitySquared = (WGS84_A ** 2 - semiMinorAxis ** 2) / semiMinorAxis ** 2;
	const horizontalDistance = Math.hypot(x, y);
	const theta = Math.atan2(WGS84_A * z, semiMinorAxis * horizontalDistance);
	const lon = Math.atan2(y, x);
	const lat = Math.atan2(
		z + secondEccentricitySquared * semiMinorAxis * Math.sin(theta) ** 3,
		horizontalDistance - WGS84_E2 * WGS84_A * Math.cos(theta) ** 3,
	);
	const sinLat = Math.sin(lat);
	const primeVerticalRadius = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
	const alt = horizontalDistance / Math.cos(lat) - primeVerticalRadius;

	return { lat: lat * 180 / Math.PI, lon: lon * 180 / Math.PI, alt };
}

function buildTileModel(btg: BtgData): TileModel {
	const vertices = btg.vertexOffsets.map(([deltaX, deltaY, deltaZ]) => {
		const position = ecefToLla(
			btg.center[0] + deltaX,
			btg.center[1] + deltaY,
			btg.center[2] + deltaZ,
		);
		return position;
	});

	const triangles = btg.triangles.flatMap(([a, b, c]): TileTriangle[] => {
		const first = vertices[a];
		const second = vertices[b];
		const third = vertices[c];
		if (!first || !second || !third) return [];
		return [{
			a,
			b,
			c,
			minLat: Math.min(first.lat, second.lat, third.lat),
			maxLat: Math.max(first.lat, second.lat, third.lat),
			minLon: Math.min(first.lon, second.lon, third.lon),
			maxLon: Math.max(first.lon, second.lon, third.lon),
		}];
	});

	return { vertices, triangles };
}

function barycentric(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
	cx: number,
	cy: number,
): { u: number; v: number; w: number } | null {
	const edge0X = bx - ax;
	const edge0Y = by - ay;
	const edge1X = cx - ax;
	const edge1Y = cy - ay;
	const pointX = px - ax;
	const pointY = py - ay;
	const dot00 = edge0X * edge0X + edge0Y * edge0Y;
	const dot01 = edge0X * edge1X + edge0Y * edge1Y;
	const dot11 = edge1X * edge1X + edge1Y * edge1Y;
	const dot20 = pointX * edge0X + pointY * edge0Y;
	const dot21 = pointX * edge1X + pointY * edge1Y;
	const denominator = dot00 * dot11 - dot01 * dot01;
	if (Math.abs(denominator) < Number.EPSILON) return null;

	const v = (dot11 * dot20 - dot01 * dot21) / denominator;
	const w = (dot00 * dot21 - dot01 * dot20) / denominator;
	const u = 1 - v - w;
	return u >= -1e-6 && v >= -1e-6 && w >= -1e-6 ? { u, v, w } : null;
}

function sampleAltitudeMeters(model: TileModel, lat: number, lon: number): number | null {
	for (const triangle of model.triangles) {
		if (lat < triangle.minLat || lat > triangle.maxLat || lon < triangle.minLon || lon > triangle.maxLon) {
			continue;
		}

		const first = model.vertices[triangle.a];
		const second = model.vertices[triangle.b];
		const third = model.vertices[triangle.c];
		const weights = barycentric(lon, lat, first.lon, first.lat, second.lon, second.lat, third.lon, third.lat);
		if (weights) {
			return weights.u * first.alt + weights.v * second.alt + weights.w * third.alt;
		}
	}

	return null;
}

function readMarkedBlockEnd(reader: Reader, fileVersion: number): number {
	const blockStart = reader.tell();
	const blockSize = fileVersion > 148 ? reader.readU64() : reader.readU32();
	const blockEnd = blockStart + blockSize;
	if (!Number.isFinite(blockEnd) || blockEnd < reader.tell()) {
		throw new Error('Invalid marked block size in OSGB stream.');
	}
	return blockEnd;
}

function skipOsgObject(reader: Reader, fileVersion: number): void {
	const className = reader.readString();
	if (className === 'NULL') {
		return;
	}
	const blockEnd = readMarkedBlockEnd(reader, fileVersion);
	reader.seek(blockEnd);
}

function readFloatArray(reader: Reader, fileVersion: number, expectedSize: number): Float32Array {
	reader.readU32(); // ArrayID
	const arrayType = reader.readI32(); // ArrayType map entry
	if (arrayType !== OSG_FLOAT_ARRAY) {
		throw new Error(`Unsupported OSGB height array type: ${arrayType}`);
	}
	const size = reader.readI32();
	if (size < 0) {
		throw new Error('Negative OSGB array size encountered.');
	}
	if (expectedSize > 0 && size !== expectedSize) {
		throw new Error(`Unexpected OSGB array size: expected ${expectedSize}, got ${size}`);
	}
	const blockEnd = readMarkedBlockEnd(reader, fileVersion);
	const values = new Float32Array(size);
	for (let index = 0; index < size; index += 1) {
		values[index] = reader.readF32();
	}
	reader.seek(blockEnd);
	return values;
}

function parseHeightFieldAt(buffer: Buffer, objectStart: number, fileVersion: number): HeightFieldTile | null {
	const reader = new Reader(buffer);
	reader.seek(objectStart);
	const className = reader.readString();
	if (className !== 'osg::HeightField') {
		return null;
	}
	const objectEnd = readMarkedBlockEnd(reader, fileVersion);
	reader.readU32(); // UniqueID

	reader.readString(); // osg::Object::Name
	reader.readI32(); // osg::Object::DataVariance
	const hasUserDataContainer = reader.readBool();
	if (hasUserDataContainer) {
		skipOsgObject(reader, fileVersion);
	}

	const hasArea = reader.readBool();
	if (!hasArea) {
		reader.seek(objectEnd);
		return null;
	}

	const columns = reader.readU32();
	const rows = reader.readU32();
	if (columns < 2 || rows < 2) {
		reader.seek(objectEnd);
		return null;
	}

	const originLon = reader.readF32();
	const originLat = reader.readF32();
	const originAlt = reader.readF32();
	const xInterval = reader.readF32();
	const yInterval = reader.readF32();
	reader.readF32(); // SkirtHeight
	reader.readU32(); // BorderWidth
	reader.readF64(); // Rotation quaternion x
	reader.readF64(); // Rotation quaternion y
	reader.readF64(); // Rotation quaternion z
	reader.readF64(); // Rotation quaternion w

	const hasHeights = reader.readBool();
	if (!hasHeights) {
		reader.seek(objectEnd);
		return null;
	}

	const heights = readFloatArray(reader, fileVersion, columns * rows);
	reader.seek(objectEnd);

	const endLon = originLon + xInterval * (columns - 1);
	const endLat = originLat + yInterval * (rows - 1);
	return {
		columns,
		rows,
		originLon,
		originLat,
		originAlt,
		xInterval,
		yInterval,
		heights,
		minLat: Math.min(originLat, endLat),
		maxLat: Math.max(originLat, endLat),
		minLon: Math.min(originLon, endLon),
		maxLon: Math.max(originLon, endLon),
	};
}

function parseOsgbHeightFields(buffer: Buffer): HeightFieldModel {
	const reader = new Reader(buffer);
	const headerLow = reader.readU32();
	const headerHigh = reader.readU32();
	if (headerLow !== OSG_HEADER_LOW || headerHigh !== OSG_HEADER_HIGH) {
		throw new Error('Invalid OSGB header.');
	}

	reader.readU32(); // Read type
	const fileVersion = reader.readU32();
	const attributes = reader.readU32();
	if ((attributes & OSG_ATTR_CUSTOM_DOMAINS) !== 0) {
		const numDomains = reader.readU32();
		for (let index = 0; index < numDomains; index += 1) {
			reader.readString();
			reader.readI32();
		}
	}

	const compressorName = reader.readString();
	if (compressorName !== '0') {
		throw new Error(`Unsupported OSGB compressor "${compressorName}".`);
	}

	if ((attributes & OSG_ATTR_SCHEMA_DATA) !== 0) {
		reader.readString();
	}

	const searchStart = reader.tell();
	const classToken = Buffer.from('osg::HeightField', 'utf-8');
	const tiles: HeightFieldTile[] = [];
	let scanOffset = searchStart;
	while (scanOffset < buffer.length) {
		const classOffset = buffer.indexOf(classToken, scanOffset);
		if (classOffset === -1) {
			break;
		}

		const objectStart = classOffset - 4;
		if (objectStart >= searchStart && objectStart >= 0 && buffer.readInt32LE(objectStart) === classToken.length) {
			const tile = parseHeightFieldAt(buffer, objectStart, fileVersion);
			if (tile) {
				tiles.push(tile);
			}
		}
		scanOffset = classOffset + classToken.length;
	}

	return { tiles };
}

function sampleHeightFieldTileAltitude(tile: HeightFieldTile, lat: number, lon: number): number | null {
	const tolerance = 1e-9;
	if (
		lat < tile.minLat - tolerance
		|| lat > tile.maxLat + tolerance
		|| lon < tile.minLon - tolerance
		|| lon > tile.maxLon + tolerance
	) {
		return null;
	}

	if (Math.abs(tile.xInterval) < Number.EPSILON || Math.abs(tile.yInterval) < Number.EPSILON) {
		return null;
	}

	let u = (lon - tile.originLon) / tile.xInterval;
	let v = (lat - tile.originLat) / tile.yInterval;
	if (!Number.isFinite(u) || !Number.isFinite(v)) {
		return null;
	}

	const maxU = tile.columns - 1;
	const maxV = tile.rows - 1;
	if (u < -tolerance || u > maxU + tolerance || v < -tolerance || v > maxV + tolerance) {
		return null;
	}

	u = Math.max(0, Math.min(maxU, u));
	v = Math.max(0, Math.min(maxV, v));
	const baseColumn = Math.min(tile.columns - 2, Math.max(0, Math.floor(u)));
	const baseRow = Math.min(tile.rows - 2, Math.max(0, Math.floor(v)));
	const uRatio = u - baseColumn;
	const vRatio = v - baseRow;
	const index = (row: number, column: number): number => row * tile.columns + column;

	const h00 = tile.heights[index(baseRow, baseColumn)];
	const h10 = tile.heights[index(baseRow, baseColumn + 1)];
	const h01 = tile.heights[index(baseRow + 1, baseColumn)];
	const h11 = tile.heights[index(baseRow + 1, baseColumn + 1)];

	const h0 = h00 + (h10 - h00) * uRatio;
	const h1 = h01 + (h11 - h01) * uRatio;
	return tile.originAlt + h0 + (h1 - h0) * vRatio;
}

function sampleHeightFieldModelAltitude(model: HeightFieldModel, lat: number, lon: number): number | null {
	for (const tile of model.tiles) {
		const altitude = sampleHeightFieldTileAltitude(tile, lat, lon);
		if (altitude !== null) {
			return altitude;
		}
	}
	return null;
}

// Parsing a tile is expensive (disk read + gunzip + triangulation), and many placements share
// the same tile, so cache parsed meshes to avoid redoing that work for every single placement.
const tileModelCache = new Map<string, TileModel>();
const heightFieldModelCache = new Map<string, HeightFieldModel>();

function loadBtgMesh(filePath: string): TileModel {
	const cached = tileModelCache.get(filePath);
	if (cached) {
		return cached;
	}
	const file = fs.readFileSync(filePath);
	const buffer = file[0] === 0x1f && file[1] === 0x8b ? zlib.gunzipSync(file) : file;
	const model = buildTileModel(parseBtg(buffer));
	tileModelCache.set(filePath, model);
	return model;
}

function loadOsgbMesh(filePath: string): HeightFieldModel {
	const cached = heightFieldModelCache.get(filePath);
	if (cached) {
		return cached;
	}
	const model = parseOsgbHeightFields(fs.readFileSync(filePath));
	heightFieldModelCache.set(filePath, model);
	return model;
}

export function findAltitudeMeters(filePath: string, lat: number, lon: number, version: number): number | null {
	if (version === 2) {
		return sampleAltitudeMeters(loadBtgMesh(filePath), lat, lon);
	} else if (version === 3) {
		return sampleHeightFieldModelAltitude(loadOsgbMesh(filePath), lat, lon);
	}
	return null;
}
