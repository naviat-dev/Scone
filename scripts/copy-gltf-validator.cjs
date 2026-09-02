const fs = require('node:fs');
const path = require('node:path');

const sourceDir = path.resolve(__dirname, '..', 'Tools', 'gltf-validator');
const targetDir = path.resolve(__dirname, '..', 'dist', 'Tools', 'gltf-validator');
const platformMap = {
	linux: 'linux',
	darwin: 'macos',
	win32: 'windows',
};
const platformFolder = platformMap[process.platform];

if (!fs.existsSync(sourceDir)) {
	console.warn(`glTF validator source not found: ${sourceDir}`);
	process.exit(0);
}

if (!platformFolder) {
	console.error(`Unsupported platform for glTF validator copy: ${process.platform}`);
	process.exit(1);
}

const sourcePlatformDir = path.join(sourceDir, platformFolder);
if (!fs.existsSync(sourcePlatformDir)) {
	console.error(`glTF validator binary folder not found for platform '${platformFolder}': ${sourcePlatformDir}`);
	process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

for (const fileName of ['LICENSE', 'NOTICES', 'README.md']) {
	const sourceFile = path.join(sourceDir, fileName);
	if (fs.existsSync(sourceFile)) {
		fs.copyFileSync(sourceFile, path.join(targetDir, fileName));
	}
}

fs.cpSync(sourcePlatformDir, path.join(targetDir, platformFolder), { recursive: true, force: true });

console.log(`Copied glTF validator (${platformFolder}) tool to ${targetDir}`);
