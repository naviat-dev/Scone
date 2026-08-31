import os from 'os';
import * as fs from 'fs';
import * as path from 'path';

export let config = {
	tempDir: path.join(os.tmpdir(), 'scone'),
	storeDir: path.join(os.homedir(), '.scone'),
	outputDir: path.join(os.homedir(), 'SconeOutput'),
	gltfValidationPath: path.join('Tools', 'gltf-validator')
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