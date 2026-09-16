import path from 'path';
import fs from 'fs';
import { findAltitudeMeters } from './terrain-elev.js';
import { config } from './config.js';

const latitudeIndex = [[89, 12], [86, 4], [83, 2], [76, 1], [62, 0.5], [22, 0.25], [0, 0.125]];
const terrasyncUrl = 'https://terrasync.b-cdn.net/Terrain';

function getTileWidth(input: number): number {
	for (let i = 0; i < latitudeIndex.length; i++) {
		if (input >= latitudeIndex[i][0]) {
			return latitudeIndex[i][1];
		}
	}
	return -1;
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

async function request(url: string, options?: RequestInit): Promise<Response> {
	let response = await fetch(url, options);
	let tries: number = 1;
	while (!response.ok && response.status !== 404 && tries < config.maxTileRetries) {
		tries++;
		await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before retrying
		response = await fetch(url, options);
	}
	return response;
}

export async function getAltitude(lat: number, lon: number, version: number): Promise<number> {
	let absoluteTilePath = '';
	const index = getTileIndexFromCoord(lat, lon);
	const tileFilePath = getFilePathFromTileIndex(index);
	const tileUrlPath = getFilePathFromTileIndex(index).replace(path.sep, '/');
	for (const dir of config.sceneryDirectories.concat([config.tempDir])) {
		const candidatePath = path.join(dir, 'Terrain', tileFilePath, `${index}.stg`);
		if (fs.existsSync(candidatePath)) {
			absoluteTilePath = candidatePath;
			break;
		}
	}
	if (!absoluteTilePath) {
		if (config.deadTiles.includes(index)) {
			return 0;
		}
		const folderUrl = `${terrasyncUrl}/${tileUrlPath}`;
		const stgUrl = `${folderUrl}/${index}.stg`;
		let response = await request(stgUrl, { method: 'GET' });
		if (response.ok) {
			const buffer = Buffer.from(await response.arrayBuffer());
			const terrainFiles = buffer.toString('utf-8').split('\n').map(line => line.split(' ')[1]).filter(name => (name ?? '').endsWith('.btg'));
			fs.mkdirSync(path.join(config.tempDir, 'Terrain', tileFilePath), { recursive: true });
			fs.writeFileSync(path.join(config.tempDir, 'Terrain', tileFilePath, `${index}.stg`), buffer);
			for (const terrainFile of terrainFiles) {
				const terrainUrl = `${folderUrl}/${terrainFile}.gz`;
				response = await request(terrainUrl, { method: 'GET' });
				if (response.ok) {
					const terrainBuffer = Buffer.from(await response.arrayBuffer());
					fs.mkdirSync(path.join(config.tempDir, 'Terrain', tileFilePath), { recursive: true });
					fs.writeFileSync(path.join(config.tempDir, 'Terrain', tileFilePath, `${terrainFile}.gz`), terrainBuffer);
				}
				else {
					throw new Error(`Failed to fetch terrain file: ${response.status} ${response.statusText}`);
				}
			}
		} else if (response.status === 404) {
			config.deadTiles.push(index);
			return 0;
		} else {
			throw new Error(`Failed to fetch terrain tile: ${response.status} ${response.statusText}`);
		}
		absoluteTilePath = path.join(config.tempDir, 'Terrain', tileFilePath, `${index}.stg`);
	}
	for (const terrainFile of fs.readFileSync(absoluteTilePath).toString('utf-8').split('\n').map(line => line.split(' ')[1]).filter(name => (name ?? '').endsWith('.btg'))) {
		const altitude = findAltitudeMeters(path.join(path.dirname(absoluteTilePath), `${terrainFile}.gz`), lat, lon, version);
		if (altitude !== null) {
			return altitude;
		}
	}
	return 0;
}

export function getFilePathFromTileIndex(index: number): string {
	const coord = getCoordFromTileIndex(index);
	const lonHemi = coord.lon >= 0 ? 'e' : 'w';
	const latHemi = coord.lat >= 0 ? 'n' : 's';
	return path.join(
		`${lonHemi}${(Math.abs(Math.floor(coord.lon / 10)) * 10).toString().padStart(3, '0')}${latHemi}${(Math.abs(Math.floor(coord.lat / 10)) * 10).toString().padStart(2, '0')}`,
		`${lonHemi}${Math.abs(Math.floor(coord.lon)).toString().padStart(3, '0')}${latHemi}${Math.abs(Math.floor(coord.lat)).toString().padStart(2, '0')}`);
}