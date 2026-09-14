const fs = require('node:fs');
const path = require('node:path');

const sourceDir = path.resolve(__dirname, '..', 'Tools');
const targetDir = path.resolve(__dirname, '..', 'dist', 'Tools');
const platformMap = {
	linux: 'linux',
	darwin: 'macos',
	win32: 'windows',
};
const platformFolder = platformMap[process.platform];

if (!platformFolder) {
	console.error(`Unsupported platform for tools copy: ${process.platform}`);
	process.exit(1);
}

if (!fs.existsSync(sourceDir)) {
	console.warn(`tools source directory not found: ${sourceDir}`);
	process.exit(0);
}

const toolFolders = fs.readdirSync(sourceDir).filter(name => fs.statSync(path.join(sourceDir, name)).isDirectory());
for (const folder of toolFolders) {
	const sourceFolder = path.join(sourceDir, folder, platformFolder);
	const targetFolder = path.join(targetDir, folder, platformFolder);
	if (!fs.existsSync(sourceFolder)) {
		console.warn(`tools binary folder not found for platform '${platformFolder}': ${sourceFolder}`);
		continue;
	}
	fs.cpSync(sourceFolder, targetFolder, { recursive: true, force: true });
}

console.log(`Copied tools (${platformFolder}) to ${targetDir}`);
