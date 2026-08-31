import os from 'os';
import * as fs from 'fs';
import * as path from 'path';

export let config = {
	tempDir: path.join(os.tmpdir(), 'scone'),
	storeDir: path.join(os.homedir(), '.scone'),
	outputDir: path.join(os.homedir(), 'SconeOutput'),
	gltfValidationPath: path.join('Tools', 'gltf-validator'),
	maxRepairRetries: 3
}

function resolveValidatorExecutablePath(): string {
	const platformFolder = process.platform === 'win32'
		? 'windows'
		: process.platform === 'darwin'
			? 'macos'
			: 'linux';
	const executableName = process.platform === 'win32' ? 'gltf_validator.exe' : 'gltf_validator';

	const candidates = [
		path.resolve(process.cwd(), 'dist', 'Tools', 'gltf-validator', platformFolder, executableName),
		path.resolve(process.cwd(), 'Tools', 'gltf-validator', platformFolder, executableName),
		path.resolve(path.dirname(process.argv[1] ?? process.cwd()), 'Tools', 'gltf-validator', platformFolder, executableName)
	];

	const discoveredPath = candidates.find((candidate) => fs.existsSync(candidate));
	return discoveredPath ?? candidates[0];
}

export function initializeRuntimeConfig() {
	config.gltfValidationPath = resolveValidatorExecutablePath();
}

export async function saveConfig() {
	if (!fs.existsSync(config.storeDir)) {
		fs.mkdirSync(config.storeDir, { recursive: true });
	}
	fs.writeFileSync(path.join(config.storeDir, 'config.json'), JSON.stringify(config, null, 2));
}

export async function loadConfig() {
	if (fs.existsSync(path.join(config.storeDir, 'config.json'))) {
		const data = fs.readFileSync(path.join(config.storeDir, 'config.json'), 'utf-8');
		Object.assign(config, JSON.parse(data));
	}
}