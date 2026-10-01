import os from 'os';
import * as fs from 'fs';
import * as path from 'path';

export let config = {
	tempDir: path.join(os.tmpdir(), 'scone'),
	storeDir: path.join(os.homedir(), '.scone'),
	deadTilesWS2: [] as number[],
	deadTilesTerrWS3: [] as number[],
	deadTilesVpbWS3: [] as string[],
	outputDir: path.join(os.homedir(), 'SconeOutput'),
	fgPath: '',
	sceneryDirectories: [] as string[],
	terrainVersion: 2 as 2 | 3,
	maxRepairRetries: 3,
	maxTileRetries: 3,
}

const MAX_REPAIR_RETRY_LIMIT = 100;

function normalizeOutputDir(value: unknown): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		return path.join(os.homedir(), 'SconeOutput');
	}
	return path.resolve(value);
}

function normalizeMaxRepairRetries(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return 3;
	}

	const normalized = Math.trunc(value);
	if (normalized < 0) {
		return 0;
	}
	if (normalized > MAX_REPAIR_RETRY_LIMIT) {
		return MAX_REPAIR_RETRY_LIMIT;
	}
	return normalized;
}

function normalizeTerrainVersion(value: unknown): 2 | 3 {
	return value === 3 ? 3 : 2;
}

function normalizeSceneryDirectories(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const directories: string[] = [];
	for (const directory of value) {
		if (typeof directory !== 'string' || directory.trim().length === 0) {
			continue;
		}
		const normalized = path.resolve(directory);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			directories.push(normalized);
		}
	}
	return directories;
}

function sanitizeConfigValues(): void {
	config.outputDir = normalizeOutputDir(config.outputDir);
	config.sceneryDirectories = normalizeSceneryDirectories(config.sceneryDirectories);
	config.terrainVersion = normalizeTerrainVersion(config.terrainVersion);
	config.maxRepairRetries = normalizeMaxRepairRetries(config.maxRepairRetries);
}

function resolveToolsExecutablePath(): string {
	const candidates = [
		path.resolve(process.cwd(), 'dist', 'Tools'),
		path.resolve(process.cwd(), 'Tools'),
		path.resolve(path.dirname(process.argv[1] ?? process.cwd()), 'Tools')
	];

	const discoveredPath = candidates.find((candidate) => fs.existsSync(candidate));
	return discoveredPath ?? candidates[0];
}

export function initializeRuntimeConfig() {
	const platformFolder = process.platform === 'win32'
		? 'windows'
		: process.platform === 'darwin'
			? 'macos'
			: 'linux';
}

export async function saveConfig() {
	sanitizeConfigValues();

	if (!fs.existsSync(config.storeDir)) {
		fs.mkdirSync(config.storeDir, { recursive: true });
	}
	fs.writeFileSync(path.join(config.storeDir, 'config.json'), JSON.stringify(config, null, 2));
}

export async function loadConfig() {
	if (fs.existsSync(path.join(config.storeDir, 'config.json'))) {
		try {
			const data = fs.readFileSync(path.join(config.storeDir, 'config.json'), 'utf-8');
			Object.assign(config, JSON.parse(data));
		} catch {
			// Keep defaults when config cannot be parsed.
		}
	}

	sanitizeConfigValues();
}