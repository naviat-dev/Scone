import fs from 'fs';
import path from 'path';
import zlib from 'node:zlib';
import { findAltitudeMeters } from './terrain-elev.js';
import { config } from './config.js';

const LATITUDE_INDEX = [[89, 12], [86, 4], [83, 2], [76, 1], [62, 0.5], [22, 0.25], [0, 0.125]];
const TERRASYNC_WS2_URL = 'https://terrasync.b-cdn.net/Terrain';
const TERRASYNC_VPB_WS3_URL = 'https://terrasync-ws3.b-cdn.net/vpb';
const TERRASYNC_TERR_WS3_URL = 'https://terrasync-ws3.b-cdn.net/Terrain';

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_COMPRESSION_STORED = 0;
const ZIP_COMPRESSION_DEFLATE = 8;
const WS3_SUBTILE_NAME_PATTERN = /^ws_[ew]\d{3}[ns]\d{2}_L(\d+)_X(\d+)_Y(\d+)_subtile\.osgb$/i;

type TerrainLookupResult = {
	altitude: number | null;
	hasTerrain: boolean;
};

type ZipEntry = {
	name: string;
	flags: number;
	compressionMethod: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
};

type Ws3TileManifest = {
	zipPath: string;
	baseLon: number;
	baseLat: number;
	highestLod: number;
	entriesByCoordinate: Map<string, ZipEntry>;
};

const ws3DirIndexCache = new Map<string, Set<string>>();
const ws3ManifestCache = new Map<string, Ws3TileManifest>();

function getTileWidth(input: number): number {
	for (let i = 0; i < LATITUDE_INDEX.length; i += 1) {
		if (input >= LATITUDE_INDEX[i][0]) {
			return LATITUDE_INDEX[i][1];
		}
	}
	return -1;
}

function toUrlPath(filePath: string): string {
	return filePath.split(path.sep).join('/');
}

function terrainRootForVersion(version: number): string {
	return version === 2 ? TERRASYNC_WS2_URL : TERRASYNC_TERR_WS3_URL;
}

function terrainDeadTileListForVersion(version: number): number[] {
	return version === 2 ? config.deadTilesWS2 : config.deadTilesTerrWS3;
}

function terrainSearchRootsForVersion(directory: string, version: number): string[] {
	if (version === 2) {
		return [path.join(directory, 'Terrain_WS2'), path.join(directory, 'Terrain')];
	}
	return [path.join(directory, 'Terrain_WS3')];
}

function terrainFileNamesFromStg(stgText: string): string[] {
	const names = new Set<string>();
	for (const line of stgText.split(/\r?\n/)) {
		const [, candidate] = line.split(' ');
		if (candidate?.endsWith('.btg')) {
			names.add(candidate.trim());
		}
	}
	return [...names];
}

function terrainMeshPathForEntry(tileDirectory: string, terrainFile: string): string | null {
	const compressedPath = path.join(tileDirectory, `${terrainFile}.gz`);
	if (fs.existsSync(compressedPath)) {
		return compressedPath;
	}
	const rawPath = path.join(tileDirectory, terrainFile);
	if (fs.existsSync(rawPath)) {
		return rawPath;
	}
	return null;
}

async function request(url: string, options?: RequestInit): Promise<Response> {
	let response = await fetch(url, options);
	let tries = 1;
	while (!response.ok && response.status !== 404 && tries < config.maxTileRetries) {
		tries += 1;
		await new Promise((resolve) => setTimeout(resolve, 1000));
		response = await fetch(url, options);
	}
	return response;
}

function findExistingTerrainStgPath(tileFilePath: string, index: number, version: number): string {
	for (const directory of config.sceneryDirectories.concat([config.tempDir])) {
		for (const root of terrainSearchRootsForVersion(directory, version)) {
			const candidatePath = path.join(root, tileFilePath, `${index}.stg`);
			if (fs.existsSync(candidatePath)) {
				return candidatePath;
			}
		}
	}
	return '';
}

async function ensureTerrainTileDownloaded(index: number, tileFilePath: string, version: number): Promise<string | null> {
	const deadTiles = terrainDeadTileListForVersion(version);
	if (deadTiles.includes(index)) {
		return null;
	}

	const tileUrlPath = toUrlPath(tileFilePath);
	const folderUrl = `${terrainRootForVersion(version)}/${tileUrlPath}`;
	const stgUrl = `${folderUrl}/${index}.stg`;
	const stgResponse = await request(stgUrl, { method: 'GET' });
	if (stgResponse.status === 404) {
		deadTiles.push(index);
		return null;
	}
	if (!stgResponse.ok) {
		throw new Error(`Failed to fetch terrain tile: ${stgResponse.status} ${stgResponse.statusText}`);
	}

	const stgBuffer = Buffer.from(await stgResponse.arrayBuffer());
	const terrainFiles = terrainFileNamesFromStg(stgBuffer.toString('utf-8'));
	const targetDir = path.join(config.tempDir, `Terrain_WS${version}`, tileFilePath);
	fs.mkdirSync(targetDir, { recursive: true });
	fs.writeFileSync(path.join(targetDir, `${index}.stg`), stgBuffer);

	for (const terrainFile of terrainFiles) {
		const terrainUrl = `${folderUrl}/${terrainFile}.gz`;
		const terrainResponse = await request(terrainUrl, { method: 'GET' });
		if (!terrainResponse.ok) {
			throw new Error(`Failed to fetch terrain file: ${terrainResponse.status} ${terrainResponse.statusText}`);
		}
		const terrainBuffer = Buffer.from(await terrainResponse.arrayBuffer());
		fs.writeFileSync(path.join(targetDir, `${terrainFile}.gz`), terrainBuffer);
	}

	return path.join(targetDir, `${index}.stg`);
}

async function findAltitudeInTerrainTile(lat: number, lon: number, version: number): Promise<TerrainLookupResult> {
	const index = getTileIndexFromCoord(lat, lon);
	if (index < 0) {
		return { altitude: null, hasTerrain: false };
	}

	const tileFilePath = getFilePathFromTileIndex(index);
	const stgPath = findExistingTerrainStgPath(tileFilePath, index, version)
		|| await ensureTerrainTileDownloaded(index, tileFilePath, version);
	if (!stgPath) {
		return { altitude: null, hasTerrain: false };
	}

	const terrainFiles = terrainFileNamesFromStg(fs.readFileSync(stgPath, 'utf-8'));
	for (const terrainFile of terrainFiles) {
		const meshPath = terrainMeshPathForEntry(path.dirname(stgPath), terrainFile);
		if (!meshPath) {
			continue;
		}
		const altitude = findAltitudeMeters(meshPath, lat, lon, 2);
		if (altitude !== null) {
			return { altitude, hasTerrain: true };
		}
	}

	return { altitude: null, hasTerrain: true };
}

function parseWs3TileOrigin(tileFilePath: string): { baseLon: number; baseLat: number } {
	const tileName = path.basename(tileFilePath);
	const match = /^([ew])(\d{3})([ns])(\d{2})$/i.exec(tileName);
	if (!match) {
		throw new Error(`Invalid WS3 tile name: ${tileName}`);
	}
	const baseLon = (match[1].toLowerCase() === 'w' ? -1 : 1) * Number.parseInt(match[2], 10);
	const baseLat = (match[3].toLowerCase() === 's' ? -1 : 1) * Number.parseInt(match[4], 10);
	return { baseLon, baseLat };
}

async function getWs3DirectoryFiles(relativeDirectory: string): Promise<Set<string> | null> {
	const cached = ws3DirIndexCache.get(relativeDirectory);
	if (cached) {
		return cached;
	}

	const response = await request(`${TERRASYNC_VPB_WS3_URL}/${relativeDirectory}/dirindex.txt`, { method: 'GET' });
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch WS3 directory index: ${response.status} ${response.statusText}`);
	}

	const files = new Set<string>();
	for (const line of (await response.text()).split(/\r?\n/)) {
		const match = /^f:([^:]+):/.exec(line.trim());
		if (match) {
			files.add(match[1]);
		}
	}
	ws3DirIndexCache.set(relativeDirectory, files);
	return files;
}

async function ensureWs3ZipDownloaded(tileFilePath: string): Promise<string | null> {
	const zipRelativePath = `${toUrlPath(tileFilePath)}.zip`;
	if (config.deadTilesVpbWS3.includes(zipRelativePath)) {
		return null;
	}

	const zipPath = path.join(config.tempDir, 'VPB_WS3', `${tileFilePath}.zip`);
	if (fs.existsSync(zipPath)) {
		return zipPath;
	}

	const ws3Directory = toUrlPath(path.dirname(tileFilePath));
	const zipFileName = `${path.basename(tileFilePath)}.zip`;
	const files = await getWs3DirectoryFiles(ws3Directory);
	if (!files || !files.has(zipFileName)) {
		config.deadTilesVpbWS3.push(zipRelativePath);
		return null;
	}

	const response = await request(`${TERRASYNC_VPB_WS3_URL}/${zipRelativePath}`, { method: 'GET' });
	if (response.status === 404) {
		config.deadTilesVpbWS3.push(zipRelativePath);
		return null;
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch WS3 VPB tile: ${response.status} ${response.statusText}`);
	}

	fs.mkdirSync(path.dirname(zipPath), { recursive: true });
	fs.writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
	return zipPath;
}

function findZipEndOfCentralDirectory(zipBuffer: Buffer): number {
	const minOffset = Math.max(0, zipBuffer.length - 0xffff - 22);
	for (let offset = zipBuffer.length - 22; offset >= minOffset; offset -= 1) {
		if (zipBuffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
			return offset;
		}
	}
	throw new Error('Invalid ZIP archive: end of central directory not found.');
}

function parseZipEntries(zipBuffer: Buffer): ZipEntry[] {
	const eocdOffset = findZipEndOfCentralDirectory(zipBuffer);
	const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
	const centralDirectoryOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
	const entries: ZipEntry[] = [];
	let offset = centralDirectoryOffset;

	for (let index = 0; index < totalEntries; index += 1) {
		if (offset + 46 > zipBuffer.length || zipBuffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
			throw new Error('Invalid ZIP archive: malformed central directory entry.');
		}

		const flags = zipBuffer.readUInt16LE(offset + 8);
		const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
		const compressedSize = zipBuffer.readUInt32LE(offset + 20);
		const uncompressedSize = zipBuffer.readUInt32LE(offset + 24);
		const fileNameLength = zipBuffer.readUInt16LE(offset + 28);
		const extraFieldLength = zipBuffer.readUInt16LE(offset + 30);
		const commentLength = zipBuffer.readUInt16LE(offset + 32);
		const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
		const fileNameStart = offset + 46;
		const fileNameEnd = fileNameStart + fileNameLength;
		const name = zipBuffer.toString('utf-8', fileNameStart, fileNameEnd);
		entries.push({
			name,
			flags,
			compressionMethod,
			compressedSize,
			uncompressedSize,
			localHeaderOffset,
		});

		offset = fileNameEnd + extraFieldLength + commentLength;
	}

	return entries;
}

function extractZipEntry(zipBuffer: Buffer, entry: ZipEntry, outputPath: string): void {
	if ((entry.flags & 0x1) !== 0) {
		throw new Error(`Unsupported encrypted ZIP entry: ${entry.name}`);
	}

	const localHeaderOffset = entry.localHeaderOffset;
	if (
		localHeaderOffset + 30 > zipBuffer.length
		|| zipBuffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE
	) {
		throw new Error(`Invalid ZIP local header for ${entry.name}`);
	}

	const localNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
	const localExtraLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
	const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
	const dataEnd = dataOffset + entry.compressedSize;
	if (dataEnd > zipBuffer.length) {
		throw new Error(`ZIP entry data exceeds archive bounds: ${entry.name}`);
	}

	const compressedData = zipBuffer.subarray(dataOffset, dataEnd);
	let data: Buffer;
	if (entry.compressionMethod === ZIP_COMPRESSION_STORED) {
		data = Buffer.from(compressedData);
	} else if (entry.compressionMethod === ZIP_COMPRESSION_DEFLATE) {
		data = zlib.inflateRawSync(compressedData);
	} else {
		throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for ${entry.name}`);
	}

	if (data.length !== entry.uncompressedSize) {
		throw new Error(`ZIP entry size mismatch for ${entry.name}: expected ${entry.uncompressedSize}, got ${data.length}`);
	}

	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, data);
}

function coordinateKey(x: number, y: number): string {
	return `${x}:${y}`;
}

function resolveHighestLodManifest(tileFilePath: string, zipPath: string): Ws3TileManifest {
	const zipBuffer = fs.readFileSync(zipPath);
	const entries = parseZipEntries(zipBuffer);
	let highestLod = -1;
	const entriesByCoordinate = new Map<string, ZipEntry>();

	for (const entry of entries) {
		const name = path.basename(entry.name);
		const match = WS3_SUBTILE_NAME_PATTERN.exec(name);
		if (!match) {
			continue;
		}
		const lod = Number.parseInt(match[1], 10);
		const x = Number.parseInt(match[2], 10);
		const y = Number.parseInt(match[3], 10);
		if (lod > highestLod) {
			highestLod = lod;
			entriesByCoordinate.clear();
		}
		if (lod === highestLod) {
			entriesByCoordinate.set(coordinateKey(x, y), entry);
		}
	}

	const { baseLon, baseLat } = parseWs3TileOrigin(tileFilePath);
	return {
		zipPath,
		baseLon,
		baseLat,
		highestLod,
		entriesByCoordinate,
	};
}

async function ensureWs3Manifest(tileFilePath: string): Promise<Ws3TileManifest | null> {
	const cached = ws3ManifestCache.get(tileFilePath);
	if (cached) {
		return cached;
	}

	const zipPath = await ensureWs3ZipDownloaded(tileFilePath);
	if (!zipPath) {
		return null;
	}

	const manifest = resolveHighestLodManifest(tileFilePath, zipPath);
	ws3ManifestCache.set(tileFilePath, manifest);
	return manifest;
}

function subtileCoordinatesForLocation(manifest: Ws3TileManifest, lat: number, lon: number): { x: number; y: number } {
	const subdivisions = 2 ** Math.max(0, manifest.highestLod - 1);
	const clampedLonFraction = Math.min(1 - Number.EPSILON, Math.max(0, lon - manifest.baseLon));
	const clampedLatFraction = Math.min(1 - Number.EPSILON, Math.max(0, lat - manifest.baseLat));
	const x = Math.min(subdivisions - 1, Math.max(0, Math.floor(clampedLonFraction * subdivisions)));
	const y = Math.min(subdivisions - 1, Math.max(0, Math.floor(clampedLatFraction * subdivisions)));
	return { x, y };
}

function ensureWs3SubtileExtracted(tileFilePath: string, manifest: Ws3TileManifest, entry: ZipEntry): string {
	const destinationPath = path.join(config.tempDir, 'VPB_WS3', tileFilePath, path.basename(entry.name));
	if (fs.existsSync(destinationPath)) {
		return destinationPath;
	}

	const zipBuffer = fs.readFileSync(manifest.zipPath);
	extractZipEntry(zipBuffer, entry, destinationPath);
	return destinationPath;
}

async function sampleWs3VpbAltitude(lat: number, lon: number, tileFilePath: string): Promise<number> {
	const manifest = await ensureWs3Manifest(tileFilePath);
	if (!manifest || manifest.highestLod < 0) {
		return 0;
	}

	const { x, y } = subtileCoordinatesForLocation(manifest, lat, lon);
	const entry = manifest.entriesByCoordinate.get(coordinateKey(x, y));
	if (!entry) {
		return 0;
	}

	const osgbPath = ensureWs3SubtileExtracted(tileFilePath, manifest, entry);
	const altitude = findAltitudeMeters(osgbPath, lat, lon, 3);
	return altitude ?? 0;
}

export async function getAltitudeWS2(lat: number, lon: number, version: number): Promise<number | null> {
	const terrainAltitude = await findAltitudeInTerrainTile(lat, lon, version);
	if (version === 2) {
		return terrainAltitude.altitude ?? 0;
	}

	if (!terrainAltitude.hasTerrain) {
		return null;
	}
	if (terrainAltitude.altitude !== null) {
		return terrainAltitude.altitude;
	}

	const index = getTileIndexFromCoord(lat, lon);
	if (index < 0) {
		return 0;
	}
	return sampleWs3VpbAltitude(lat, lon, getFilePathFromTileIndex(index));
}

export function getTileIndexFromCoord(lat: number, lon: number): number {
	const latAbs = Math.abs(lat);
	if (latAbs <= 90 && Math.abs(lon) <= 180) {
		const tileWidth = getTileWidth(latAbs);
		const baseX = Math.floor(Math.floor(lon / tileWidth) * tileWidth);
		const x = Math.floor((lon - baseX) / tileWidth);
		const baseY = Math.floor(lat);
		const y = Math.trunc((lat - baseY) * 8);
		return ((baseX + 180) << 14) + ((baseY + 90) << 6) + (y << 3) + x;
	}
	return -1;
}

export function getCoordFromTileIndex(index: number): { lat: number, lon: number } {
	const x = index & 7;
	const y = (index >> 3) & 7;
	const baseY = ((index >> 6) & 255) - 90;
	const baseX = (index >> 14) - 180;
	const lookup = Math.abs(baseY);
	const tileWidth = getTileWidth(lookup);
	const lat = baseY + y / 8;
	const lon = baseX + x * tileWidth;
	return { lat, lon };
}

export function getFilePathFromTileIndex(index: number): string {
	const coord = getCoordFromTileIndex(index);
	const lonHemi = coord.lon >= 0 ? 'e' : 'w';
	const latHemi = coord.lat >= 0 ? 'n' : 's';
	return path.join(
		`${lonHemi}${(Math.abs(Math.floor(coord.lon / 10)) * 10).toString().padStart(3, '0')}${latHemi}${(Math.abs(Math.floor(coord.lat / 10)) * 10).toString().padStart(2, '0')}`,
		`${lonHemi}${Math.abs(Math.floor(coord.lon)).toString().padStart(3, '0')}${latHemi}${Math.abs(Math.floor(coord.lat)).toString().padStart(2, '0')}`,
	);
}
