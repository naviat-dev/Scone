const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const executableName = process.platform === 'win32' ? 'node.exe' : 'node';
const sourcePath = path.join(projectRoot, 'node_modules', 'node', 'bin', executableName);
const runtimeDirectory = path.join(projectRoot, '.runtime');
const destinationPath = path.join(runtimeDirectory, executableName);

if (!fs.existsSync(sourcePath)) {
	throw new Error(
		`The Node.js runtime is missing at ${sourcePath}. Run npm install with the node install script enabled.`,
	);
}

fs.mkdirSync(runtimeDirectory, { recursive: true });
fs.copyFileSync(sourcePath, destinationPath);
fs.chmodSync(destinationPath, 0o755);

const runtime = JSON.parse(execFileSync(
	destinationPath,
	['-p', 'JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch })'],
	{ encoding: 'utf8' },
));
if (runtime.platform !== process.platform || runtime.arch !== process.arch) {
	throw new Error(
		`Bundled Node.js runtime is ${runtime.platform}-${runtime.arch}; expected ${process.platform}-${process.arch}.`,
	);
}
fs.writeFileSync(
	path.join(runtimeDirectory, 'runtime.json'),
	`${JSON.stringify(runtime, null, 2)}\n`,
);

console.log(`Copied ${runtime.node} runtime (${runtime.platform}-${runtime.arch}) to ${destinationPath}`);
