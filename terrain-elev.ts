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

type BtgProperty = { type: number; data: Buffer };
type BtgElement = { byteLength: number; data: Buffer };

const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;

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
	if (denominator === 0) return null;

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

	let nearest: Vertex | null = null;
	let nearestDistance = Infinity;
	for (const vertex of model.vertices) {
		const distance = (lon - vertex.lon) ** 2 + (lat - vertex.lat) ** 2;
		if (distance < nearestDistance) {
			nearest = vertex;
			nearestDistance = distance;
		}
	}

	return nearest?.alt ?? null;
}

function loadBtgMesh(filePath: string): TileModel {
	const file = fs.readFileSync(filePath);
	const buffer = file[0] === 0x1f && file[1] === 0x8b ? zlib.gunzipSync(file) : file;
	return buildTileModel(parseBtg(buffer));
}

export function findAltitudeMeters(filePath: string, lat: number, lon: number, version: number): number | null {
	if (version === 2) {
		return sampleAltitudeMeters(loadBtgMesh(filePath), lat, lon);
	} else if (version === 3) {
		// TODO: Implement WS3 sampling
	}
	return null;
}
