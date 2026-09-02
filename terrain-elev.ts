import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const PORT = process.env.FG_ELEVATION_PORT ? Number(process.env.FG_ELEVATION_PORT) : 8787;
const DEFAULT_SCENERY_ROOT = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'FlightGear',
  'TerraSync',
  'Terrain'
);
const SCENERY_ROOT = process.env.FG_SCENERY_ROOT || DEFAULT_SCENERY_ROOT;
const TERRASYNC_BASE =
  (process.env.FG_TERRASYNC_BASE || 'https://terrasync.b-cdn.net/Terrain').replace(/\/+$/, '');
const ALLOWED_ORIGIN = process.env.FG_ALLOWED_ORIGIN || '';
const API_TOKEN = process.env.FG_API_TOKEN || '';
const AUTO_DOWNLOAD_MISSING_TILES = process.env.FG_AUTO_DOWNLOAD_MISSING_TILES !== '0';
const DOWNLOAD_RETRY_SECONDS = Number(process.env.FG_DOWNLOAD_RETRY_SECONDS || 1);
const CACHE_TTL_MS = Number(process.env.FG_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const CACHE_CLEANUP_ENABLED = process.env.FG_CACHE_CLEANUP === '1';
const CACHE_MIN_FREE_BYTES = Number(process.env.FG_CACHE_MIN_FREE_BYTES || 5 * 1024 * 1024 * 1024);
const TERRASYNC_ROOT = process.env.FG_TERRASYNC_ROOT || TERRASYNC_BASE.replace(/\/Terrain$/i, '');
const AIRPORT_INDEX_URL =
  process.env.FG_AIRPORT_INDEX_URL || `${TERRASYNC_ROOT}/Airports/index.txt`;
const AIRPORT_INDEX_PATH =
  process.env.FG_AIRPORT_INDEX_PATH || path.join(SCENERY_ROOT, '.cache', 'airports-index.txt');
const AIRPORT_SEARCH_RADIUS_NM = Number(process.env.FG_AIRPORT_SEARCH_RADIUS_NM || 5);
const ELEVATION_TIMEOUT_MS = Number(process.env.FG_ELEVATION_TIMEOUT_MS || 10_000);

type Coordinates = { lat: number; lon: number };
type Airport = Coordinates & { ident: string };
type TileDebug = {
	baseX: number;
	baseY: number;
	x: number;
	y: number;
	tileW: number;
	dir10: string;
	dir1: string;
};
type TileInfo = {
	tileId: number;
	relPath: string;
	fallbackRelPath: string;
	debug: TileDebug;
};
type BtgProperty = { propType: number; byteLen: number; data: Buffer };
type BtgElement = { elemByteLen: number; data: Buffer };
type BtgData = {
	version: number;
	epoch: number;
	center: [number, number, number];
	vertexOffsets: Array<[number, number, number]>;
	triangles: Array<[number, number, number]>;
};
type Vertex = Coordinates & { alt: number; altFt: number };
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
type PendingFile = { relPath: string; retryAfterSeconds: number; airport?: string };
type DownloadResult = { ok: true; destPath: string } | { ok: false; error: Error };
type ElevationOptions = { waitForDownload?: boolean; airport?: string };
type ElevationResult = { altitudeFt: number; source: 'airport' | 'terrain' };

const TILE_CACHE = new Map<string, TileModel>();
const MISSING_TILE_CACHE = new Set<string>();
const DOWNLOAD_JOBS = new Map<string, Promise<DownloadResult>>();
let airportIndex: Airport[] | null = null;
let airportIndexPromise: Promise<Airport[]> | null = null;
const MAX_CACHE = 12;
const EARTH_RADIUS_M = 6371008.8;
const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;
const METERS_TO_FEET = 3.28084;

class Reader {
	buffer: Buffer;
	offset: number;

	constructor(buffer: Buffer) {
	this.buffer = buffer;
	this.offset = 0;
  }

  readU8() {
	const v = this.buffer.readUInt8(this.offset);
	this.offset += 1;
	return v;
  }

  readU16() {
	const v = this.buffer.readUInt16LE(this.offset);
	this.offset += 2;
	return v;
  }

  readU32() {
	const v = this.buffer.readUInt32LE(this.offset);
	this.offset += 4;
	return v;
  }

  readF32() {
	const v = this.buffer.readFloatLE(this.offset);
	this.offset += 4;
	return v;
  }

  readF64() {
	const v = this.buffer.readDoubleLE(this.offset);
	this.offset += 8;
	return v;
  }

	readBytes(length: number): Buffer {
	const v = this.buffer.subarray(this.offset, this.offset + length);
	this.offset += length;
	return v;
  }
}

class PendingSceneryError extends Error {
	files: PendingFile[];

	constructor(files: PendingFile[]) {
	super('Scenery download in progress');
	this.files = files;
  }
}

class NoElevationError extends Error {
  constructor() {
	super('No terrain elevation available');
  }
}

class ElevationTimeoutError extends Error {
  constructor() {
	super('Elevation lookup timed out');
  }
}

const formatLonBucket = (deg: number): string =>
  `${deg >= 0 ? 'e' : 'w'}${Math.abs(deg).toString().padStart(3, '0')}`;
const formatLatBucket = (deg: number): string =>
  `${deg >= 0 ? 'n' : 's'}${Math.abs(deg).toString().padStart(2, '0')}`;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const toRad = (deg: number): number => (deg * Math.PI) / 180;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
	promise,
	sleep(ms).then(() => {
	  throw new ElevationTimeoutError();
	}),
  ]);

const distanceNm = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
	Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return (2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))) / 1852;
};

const tileWidthForLat = (baseY: number): number => {
  const absLat = Math.abs(baseY);
  if (absLat < 22) return 0.125;
  if (absLat < 62) return 0.25;
  if (absLat < 76) return 0.5;
  if (absLat < 83) return 1.0;
  if (absLat < 86) return 2.0;
  if (absLat < 88) return 4.0;
  if (absLat < 89) return 8.0;
  return 360.0;
};

const tileIdFromParts = (baseX: number, baseY: number, x: number, y: number): number =>
  ((baseX + 180) << 14) + ((baseY + 90) << 6) + (y << 3) + x;

const tilePathFromParts = (baseX: number, baseY: number, tileId: number) => {
  const lon10 = Math.floor(baseX / 10) * 10;
  const lat10 = Math.floor(baseY / 10) * 10;
  const dir10 = `${formatLonBucket(lon10)}${formatLatBucket(lat10)}`;
  const dir1 = `${formatLonBucket(baseX)}${formatLatBucket(baseY)}`;
  return { dir10, dir1, relPath: path.join(dir10, dir1, `${tileId}.btg.gz`) };
};

const getTileInfo = (lat: number, lon: number): TileInfo => {
  const baseY = Math.floor(lat);
  const y = clamp(Math.floor((lat - baseY) * 8), 0, 7);
  const tileW = tileWidthForLat(baseY);
  const baseX = Math.floor(Math.floor(lon / tileW) * tileW);
  const x = clamp(Math.floor((lon - baseX) / tileW), 0, 7);
  const tileId = tileIdFromParts(baseX, baseY, x, y);
  const { dir10, dir1, relPath } = tilePathFromParts(baseX, baseY, tileId);

  return {
	tileId,
	relPath,
	fallbackRelPath: path.join(dir10, dir1, `${tileId}.btg`),
	debug: { baseX, baseY, x, y, tileW, dir10, dir1 },
  };
};

const getAirportRelPath = (airport: Airport): string => {
  const info = getTileInfo(airport.lat, airport.lon);
  const { dir10, dir1 } = info.debug;
  return path.join(dir10, dir1, `${airport.ident}.btg.gz`);
};

const ensureDir = (filePath: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const downloadTextFile = async (url: string, destPath: string): Promise<void> => {
  ensureDir(destPath);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
	throw new Error(`HTTP ${response.status} for ${url}`);
  }
	await pipeline(
	Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
	fs.createWriteStream(destPath)
	);
};

const loadAirportIndex = async (): Promise<Airport[]> => {
  if (airportIndex) return airportIndex;
  if (airportIndexPromise) return airportIndexPromise;

  airportIndexPromise = (async () => {
	try {
	  const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
	  const needsDownload =
		!fs.existsSync(AIRPORT_INDEX_PATH) ||
		Date.now() - fs.statSync(AIRPORT_INDEX_PATH).mtimeMs > maxAgeMs;
	  if (needsDownload) {
		await downloadTextFile(AIRPORT_INDEX_URL, AIRPORT_INDEX_PATH);
	  }
	  const rows = fs.readFileSync(AIRPORT_INDEX_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
	  const parsedAirports = rows
		.map((row): Airport | null => {
		  const [identRaw, lonRaw, latRaw] = row.split('|');
		  const ident = (identRaw || '').trim().toUpperCase();
		  const lat = Number(latRaw);
		  const lon = Number(lonRaw);
		  return ident && Number.isFinite(lat) && Number.isFinite(lon) ? { ident, lat, lon } : null;
		})
		.filter((airport): airport is Airport => airport !== null);
	  airportIndex = parsedAirports;
	  return parsedAirports;
	} catch (err) {
	  console.warn(`[FG] Airport index unavailable: ${err instanceof Error ? err.message : String(err)}`);
	  airportIndex = [];
	  return airportIndex;
	} finally {
	  airportIndexPromise = null;
	}
  })();

  return airportIndexPromise;
};

const findAirportCandidates = async (lat: number, lon: number, forcedIdent = ''): Promise<Airport[]> => {
  const airports = await loadAirportIndex();
  const forced = forcedIdent.trim().toUpperCase();
  if (forced) {
	const match = airports.find((airport) => airport.ident === forced);
	if (match) return [match];
	return [{ ident: forced, lat, lon }];
  }
  return airports
	.filter((airport) => distanceNm(lat, lon, airport.lat, airport.lon) <= AIRPORT_SEARCH_RADIUS_NM)
	.sort((a, b) => distanceNm(lat, lon, a.lat, a.lon) - distanceNm(lat, lon, b.lat, b.lon))
	.slice(0, 6);
};

const readBtgBuffer = (fullPath: string, fallbackPath: string): Buffer | null => {
  if (fs.existsSync(fullPath)) {
	return zlib.gunzipSync(fs.readFileSync(fullPath));
  }
  if (fs.existsSync(fallbackPath)) {
	return fs.readFileSync(fallbackPath);
  }
  return null;
};

const getIndexTypes = (props: BtgProperty[], defaultBits: number): number => {
  for (const prop of props) {
	if (prop.byteLen === 4) {
	  const value = prop.data.readUInt32LE(0);
	  if (value > 0 && (value & ~0x0f) === 0) {
		return value;
	  }
	}
  }
  return defaultBits;
};

const vertexIndexPosition = (indexTypes: number): number => {
  const order = [0, 1, 2, 3];
  let pos = 0;
  for (const bit of order) {
	if (indexTypes & (1 << bit)) {
	  if (bit === 0) return pos;
	  pos += 1;
	}
  }
  return 0;
};

const parseBtg = (buffer: Buffer): BtgData => {
  const reader = new Reader(buffer);
  const version = reader.readU16();
  const magic = reader.readU16();
  const epoch = reader.readU32();
  const objectCount = reader.readU16();

  if (magic !== 0x5347) {
	throw new Error('Invalid BTG magic');
  }

	let center: [number, number, number] = [0, 0, 0];
	const vertexOffsets: Array<[number, number, number]> = [];
	const triangles: Array<[number, number, number]> = [];

  for (let i = 0; i < objectCount; i += 1) {
	const type = reader.readU8();
	const propCount = reader.readU16();
	const elemCount = reader.readU16();
	const props: BtgProperty[] = [];

	for (let p = 0; p < propCount; p += 1) {
	  const propType = reader.readU8();
	  const byteLen = reader.readU32();
	  const data = reader.readBytes(byteLen);
	  props.push({ propType, byteLen, data });
	}

	const elements: BtgElement[] = [];
	for (let e = 0; e < elemCount; e += 1) {
	  const elemByteLen = reader.readU32();
	  const data = reader.readBytes(elemByteLen);
	  elements.push({ elemByteLen, data });
	}

	if (type === 0) {
	  for (const element of elements) {
		const r = new Reader(element.data);
		const x = r.readF64();
		const y = r.readF64();
		const z = r.readF64();
		r.readF32();
		center = [x, y, z];
	  }
	}

	if (type === 1) {
	  for (const element of elements) {
		const r = new Reader(element.data);
		const count = element.elemByteLen / 12;
		for (let v = 0; v < count; v += 1) {
		  vertexOffsets.push([r.readF32(), r.readF32(), r.readF32()]);
		}
	  }
	}

	if (type === 9 || type === 10 || type === 11 || type === 12) {
	  const defaultBits = type === 9 ? 1 : 1 | 8;
	  const indexTypes = getIndexTypes(props, defaultBits);
	  const tupleSize = Math.max(1, [0, 1, 2, 3].filter((bit) => indexTypes & (1 << bit)).length);
	  const vPos = vertexIndexPosition(indexTypes);

	  for (const element of elements) {
		const r = new Reader(element.data);
		const totalIndices = element.elemByteLen / 2;
		const tupleCount = Math.floor(totalIndices / tupleSize);
		const vertices: number[] = [];

		for (let t = 0; t < tupleCount; t += 1) {
		  const tuple: number[] = [];
		  for (let k = 0; k < tupleSize; k += 1) {
			tuple.push(r.readU16());
		  }
		  vertices.push(tuple[vPos]);
		}

		if (type === 10) {
		  for (let v = 0; v + 2 < vertices.length; v += 3) {
			triangles.push([vertices[v], vertices[v + 1], vertices[v + 2]]);
		  }
		} else if (type === 11) {
		  for (let v = 2; v < vertices.length; v += 1) {
			triangles.push(v % 2 === 0 ? [vertices[v - 2], vertices[v - 1], vertices[v]] : [vertices[v - 1], vertices[v - 2], vertices[v]]);
		  }
		} else if (type === 12) {
		  for (let v = 2; v < vertices.length; v += 1) {
			triangles.push([vertices[0], vertices[v - 1], vertices[v]]);
		  }
		}
	  }
	}
  }

  return { version, epoch, center, vertexOffsets, triangles };
};

const ecefToLla = (x: number, y: number, z: number): Coordinates & { alt: number } => {
  const a = WGS84_A;
  const e2 = WGS84_E2;
  const b = a * Math.sqrt(1 - e2);
  const ep2 = (a ** 2 - b ** 2) / b ** 2;
  const p = Math.sqrt(x * x + y * y);
  const th = Math.atan2(a * z, b * p);
  const lon = Math.atan2(y, x);
  const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - e2 * a * Math.cos(th) ** 3);
  const sinLat = Math.sin(lat);
  const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const alt = p / Math.cos(lat) - n;

  return {
	lat: (lat * 180) / Math.PI,
	lon: (lon * 180) / Math.PI,
	alt,
  };
};

const buildTileModel = (btg: BtgData): TileModel => {
  const vertices = btg.vertexOffsets.map(([dx, dy, dz]) => {
	const x = btg.center[0] + dx;
	const y = btg.center[1] + dy;
	const z = btg.center[2] + dz;
	const lla = ecefToLla(x, y, z);
	return { ...lla, altFt: lla.alt * METERS_TO_FEET };
  });

  let invalidCount = 0;
  const triangles = btg.triangles
	.map(([a, b, c]): TileTriangle | null => {
	  const v1 = vertices[a];
	  const v2 = vertices[b];
	  const v3 = vertices[c];
	  if (!v1 || !v2 || !v3) {
		invalidCount += 1;
		return null;
	  }
	  return {
		a,
		b,
		c,
		minLat: Math.min(v1.lat, v2.lat, v3.lat),
		maxLat: Math.max(v1.lat, v2.lat, v3.lat),
		minLon: Math.min(v1.lon, v2.lon, v3.lon),
		maxLon: Math.max(v1.lon, v2.lon, v3.lon),
	  };
	})
	.filter((triangle): triangle is TileTriangle => triangle !== null);

  if (invalidCount > 0) {
	console.warn(`[FG] Skipped ${invalidCount} invalid triangles (vertex index out of range).`);
  }

  return { vertices, triangles };
};

const barycentric = (
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
	cx: number,
	cy: number
): { u: number; v: number; w: number } | null => {
  const v0x = bx - ax;
  const v0y = by - ay;
  const v1x = cx - ax;
  const v1y = cy - ay;
  const v2x = px - ax;
  const v2y = py - ay;
  const d00 = v0x * v0x + v0y * v0y;
  const d01 = v0x * v1x + v0y * v1y;
  const d11 = v1x * v1x + v1y * v1y;
  const d20 = v2x * v0x + v2y * v0y;
  const d21 = v2x * v1x + v2y * v1y;
  const denom = d00 * d11 - d01 * d01;
  if (denom === 0) return null;

  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const u = 1 - v - w;
  if (u < -1e-6 || v < -1e-6 || w < -1e-6) return null;
  return { u, v, w };
};

const sampleAltitude = (model: TileModel, lat: number, lon: number): number | null => {
	let nearest: number | null = null;
  let nearestDist = Infinity;

  for (const tri of model.triangles) {
	if (lat < tri.minLat || lat > tri.maxLat || lon < tri.minLon || lon > tri.maxLon) {
	  continue;
	}
	const v1 = model.vertices[tri.a];
	const v2 = model.vertices[tri.b];
	const v3 = model.vertices[tri.c];
	const bc = barycentric(lon, lat, v1.lon, v1.lat, v2.lon, v2.lat, v3.lon, v3.lat);
	if (bc) {
	  return bc.u * v1.altFt + bc.v * v2.altFt + bc.w * v3.altFt;
	}
  }

  for (const v of model.vertices) {
	const dx = lon - v.lon;
	const dy = lat - v.lat;
	const dist = dx * dx + dy * dy;
	if (dist < nearestDist) {
	  nearestDist = dist;
	  nearest = v.altFt;
	}
  }

  return nearest;
};

const statFsFreeBytes = (dirPath: string): number => {
  try {
	const stats = fs.statfsSync(dirPath);
	return Number(stats.bavail) * Number(stats.bsize);
  } catch {
	return Infinity;
  }
};

const listCachedBtgFiles = (root: string): Array<{ full: string; mtimeMs: number; size: number }> => {
	const files: Array<{ full: string; mtimeMs: number; size: number }> = [];
	const walk = (dir: string): void => {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
	  const full = path.join(dir, entry.name);
	  if (entry.isDirectory()) {
		walk(full);
	  } else if (entry.isFile() && /\.btg(\.gz)?$/i.test(entry.name)) {
		const stats = fs.statSync(full);
		files.push({ full, mtimeMs: stats.mtimeMs, size: stats.size });
	  }
	}
  };
  walk(root);
  return files;
};

const cleanupSceneryCache = (): void => {
  if (!CACHE_CLEANUP_ENABLED) return;
  const now = Date.now();
  const files = listCachedBtgFiles(SCENERY_ROOT).sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
	if (now - file.mtimeMs <= CACHE_TTL_MS) continue;
	try {
	  fs.unlinkSync(file.full);
	} catch {
	  // Ignore cleanup races.
	}
  }

  let freeBytes = statFsFreeBytes(SCENERY_ROOT);
  if (freeBytes >= CACHE_MIN_FREE_BYTES) return;
  for (const file of files) {
	if (freeBytes >= CACHE_MIN_FREE_BYTES) break;
	if (!fs.existsSync(file.full)) continue;
	try {
	  fs.unlinkSync(file.full);
	  freeBytes += file.size;
	} catch {
	  // Ignore cleanup races.
	}
  }
};

const downloadTile = async (relPath: string): Promise<string> => {
  const url = `${TERRASYNC_BASE}/${relPath.replace(/\\/g, '/')}`;
  const destPath = path.join(SCENERY_ROOT, relPath);
  const tempPath = `${destPath}.download`;
  ensureDir(destPath);

  const response = await fetch(url);
  if (!response.ok || !response.body) {
	throw new Error(`HTTP ${response.status} for ${url}`);
  }

	await pipeline(
	Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
	fs.createWriteStream(tempPath)
	);
  fs.renameSync(tempPath, destPath);
  const now = new Date();
  fs.utimesSync(destPath, now, now);
  cleanupSceneryCache();
  return destPath;
};

const queueDownload = (relPath: string): Promise<DownloadResult> => {
  const existingJob = DOWNLOAD_JOBS.get(relPath);
  if (existingJob) return existingJob;
  const job = downloadTile(relPath)
	.then((destPath): DownloadResult => ({ ok: true, destPath }))
	.catch((err): DownloadResult => {
	  if (String(err instanceof Error ? err.message : err).includes('HTTP 404')) {
		MISSING_TILE_CACHE.add(relPath);
	  }
	  return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
	})
	.finally(() => {
	  DOWNLOAD_JOBS.delete(relPath);
	});
  DOWNLOAD_JOBS.set(relPath, job);
  return job;
};

const touchFile = (filePath: string): void => {
  try {
	const now = new Date();
	fs.utimesSync(filePath, now, now);
  } catch {
	// Ignore read-only local scenery trees.
  }
};

const loadModelForPath = async ({
  cacheKey,
  relPath,
  fallbackRelPath = null,
  waitForDownload = true,
	debug = null,
}: {
	cacheKey: string;
	relPath: string;
	fallbackRelPath?: string | null;
	waitForDownload?: boolean;
	debug?: TileDebug | null;
}): Promise<TileModel | null> => {
  if (TILE_CACHE.has(cacheKey)) {
	return TILE_CACHE.get(cacheKey) ?? null;
  }
  if (MISSING_TILE_CACHE.has(relPath)) {
	return null;
  }

  const fullPath = path.join(SCENERY_ROOT, relPath);
  const fallbackPath = fallbackRelPath
	? path.join(SCENERY_ROOT, fallbackRelPath)
	: fullPath.replace(/\.btg\.gz$/i, '.btg');
  let buffer = readBtgBuffer(fullPath, fallbackPath);
  if (!buffer) {
	if (debug) {
	  console.warn(
		`[FG] Tile missing: ${cacheKey} -> ${fullPath} (baseX=${debug.baseX}, baseY=${debug.baseY}, x=${debug.x}, y=${debug.y}, w=${debug.tileW})`
	  );
	} else {
	  console.warn(`[FG] Tile missing: ${cacheKey} -> ${fullPath}`);
	}

	if (!AUTO_DOWNLOAD_MISSING_TILES) {
	  return null;
	}

	console.log(`[FG] Downloading missing tile ${cacheKey} from ${TERRASYNC_BASE}/${relPath.replace(/\\/g, '/')}`);
	const job = queueDownload(relPath);
	if (!waitForDownload) {
	  throw new PendingSceneryError([{ relPath, retryAfterSeconds: DOWNLOAD_RETRY_SECONDS }]);
	}

	const result = await job;
	if (!result.ok) {
	  const err = result.error;
	  console.warn(`[FG] Download failed for ${cacheKey}: ${err instanceof Error ? err.message : String(err)}`);
	  return null;
	}

	buffer = readBtgBuffer(fullPath, fallbackPath);
	if (!buffer) {
	  MISSING_TILE_CACHE.add(relPath);
	  return null;
	}
  }

  touchFile(fs.existsSync(fullPath) ? fullPath : fallbackPath);
  const model = buildTileModel(parseBtg(buffer));

  TILE_CACHE.set(cacheKey, model);
  if (TILE_CACHE.size > MAX_CACHE) {
	const oldestKey = TILE_CACHE.keys().next().value as string | undefined;
	if (oldestKey !== undefined) TILE_CACHE.delete(oldestKey);
  }

  return model;
};

const getTileModel = async (
	lat: number,
	lon: number,
	options: ElevationOptions = {}
): Promise<TileModel | null> => {
  const waitForDownload = options.waitForDownload !== false;
  const { tileId, relPath, fallbackRelPath, debug } = getTileInfo(lat, lon);
  return loadModelForPath({
	cacheKey: `terrain:${tileId}`,
	relPath,
	fallbackRelPath,
	waitForDownload,
	debug,
  });
};

const getAirportModels = async (
	lat: number,
	lon: number,
	options: ElevationOptions = {}
): Promise<Array<{ airport: Airport; model: TileModel }>> => {
  const waitForDownload = options.waitForDownload !== false;
  const candidates = await findAirportCandidates(lat, lon, options.airport || '');
	const models: Array<{ airport: Airport; model: TileModel }> = [];
	const pending: PendingFile[] = [];

  for (const airport of candidates) {
	const relPath = getAirportRelPath(airport);
	try {
	  const model = await loadModelForPath({
		cacheKey: `airport:${airport.ident}:${relPath}`,
		relPath,
		waitForDownload,
	  });
	  if (model) {
		models.push({ airport, model });
	  }
	} catch (err) {
	  if (err instanceof PendingSceneryError) {
		pending.push(...err.files.map((file) => ({ ...file, airport: airport.ident })));
	  } else {
		throw err;
	  }
	}
  }

  if (pending.length > 0) {
	throw new PendingSceneryError(pending);
  }
  return models;
};

const getElevationAt = async (
	lat: number,
	lon: number,
	options: ElevationOptions = {}
): Promise<ElevationResult> => {
  const waitForDownload = options.waitForDownload !== false;
	const pending: PendingFile[] = [];

  try {
	const airportModels = await getAirportModels(lat, lon, options);
	for (const { model } of airportModels) {
	  const altitudeFt = sampleAltitude(model, lat, lon);
	  if (typeof altitudeFt === 'number' && Number.isFinite(altitudeFt)) {
		return { altitudeFt, source: 'airport' };
	  }
	}
  } catch (err) {
	if (err instanceof PendingSceneryError) {
	  pending.push(...err.files);
	} else {
	  throw err;
	}
  }

  try {
	const terrainModel = await getTileModel(lat, lon, { waitForDownload });
	if (terrainModel) {
	  const altitudeFt = sampleAltitude(terrainModel, lat, lon);
	  if (typeof altitudeFt === 'number' && Number.isFinite(altitudeFt)) {
		return { altitudeFt, source: 'terrain' };
	  }
	}
  } catch (err) {
	if (err instanceof PendingSceneryError) {
	  pending.push(...err.files);
	} else {
	  throw err;
	}
  }

  if (pending.length > 0) {
	throw new PendingSceneryError(pending);
  }
  throw new NoElevationError();
};

const handleElevation = async (
	res: http.ServerResponse,
	lat: number,
	lon: number,
	params: URLSearchParams
): Promise<void> => {
  const startedAt = Date.now();
  try {
	const asyncRequest = params.get('async') === '1' || params.get('async') === 'true';
	const airport = params.get('airport') || params.get('icao') || '';
	const lookup = getElevationAt(lat, lon, {
	  waitForDownload: !asyncRequest,
	  airport,
	});
	const { altitudeFt, source } = asyncRequest ? await lookup : await withTimeout(lookup, ELEVATION_TIMEOUT_MS);

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ altitudeFt, source }));
  } catch (err) {
	if (err instanceof PendingSceneryError) {
	  res.writeHead(202, {
		'Content-Type': 'application/json',
		'Retry-After': String(DOWNLOAD_RETRY_SECONDS),
	  });
	  res.end(
		JSON.stringify({
		  status: 'downloading',
		  message: `Downloading scenery. Please retry in ${DOWNLOAD_RETRY_SECONDS} second${
			DOWNLOAD_RETRY_SECONDS === 1 ? '' : 's'
		  }.`,
		  retryAfterSeconds: DOWNLOAD_RETRY_SECONDS,
		  files: err.files,
		})
	  );
	  return;
	}
	if (err instanceof NoElevationError) {
	  await sleep(Math.max(0, ELEVATION_TIMEOUT_MS - (Date.now() - startedAt)));
	}
	if (err instanceof ElevationTimeoutError || err instanceof NoElevationError) {
	  res.writeHead(504, { 'Content-Type': 'application/json' });
	  res.end(
		JSON.stringify({
		  error: 'Elevation lookup timed out',
		  message: `No terrain elevation was available within ${Math.round(ELEVATION_TIMEOUT_MS / 1000)} seconds.`,
		})
	  );
	  return;
	}
	res.writeHead(500, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
  }
};

const setCorsHeaders = (req: http.IncomingMessage, res: http.ServerResponse): void => {
	const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
	res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
	res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
};

const isAuthorized = (req: http.IncomingMessage): boolean => {
  if (!API_TOKEN) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${API_TOKEN}`;
};

const server = http.createServer(async (req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
	res.writeHead(204);
	res.end();
	return;
  }

  if (!isAuthorized(req)) {
	res.writeHead(401, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: 'Unauthorized' }));
	return;
  }

	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ ok: true }));
	return;
  }

  if (url.pathname === '/api/elevation') {
	const lat = Number(url.searchParams.get('lat'));
	const lon = Number(url.searchParams.get('lon'));
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
	  res.writeHead(400, { 'Content-Type': 'application/json' });
	  res.end(JSON.stringify({ error: 'Invalid lat/lon' }));
	  return;
	}
	await handleElevation(res, lat, lon, url.searchParams);
	return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`FG elevation API running on http://localhost:${PORT}`);
  console.log(`Scenery root: ${SCENERY_ROOT}`);
  console.log(`TerraSync base: ${TERRASYNC_BASE}`);
});
