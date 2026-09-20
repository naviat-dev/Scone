const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Arch } = require('builder-util');

exports.default = async function verifyPackagedRuntime(context) {
	const resourcesDirectory = context.electronPlatformName === 'darwin'
		? path.join(
			context.appOutDir,
			`${context.packager.appInfo.productFilename}.app`,
			'Contents',
			'Resources',
		)
		: path.join(context.appOutDir, 'resources');
	const executableName = context.electronPlatformName === 'win32' ? 'node.exe' : 'node';
	const runtimePath = path.join(resourcesDirectory, 'runtime', executableName);
	const metadataPath = path.join(resourcesDirectory, 'runtime', 'runtime.json');

	if (!fs.existsSync(runtimePath)) {
		throw new Error(`Packaged Node.js runtime is missing: ${runtimePath}`);
	}
	if (!fs.existsSync(metadataPath)) {
		throw new Error(`Packaged Node.js runtime metadata is missing: ${metadataPath}`);
	}

	const runtime = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
	const expectedArch = Arch[context.arch];
	if (runtime.platform !== context.electronPlatformName || runtime.arch !== expectedArch) {
		throw new Error(
			`Packaged Node.js runtime is ${runtime.platform}-${runtime.arch}; expected ${context.electronPlatformName}-${expectedArch}.`,
		);
	}

	const version = execFileSync(runtimePath, ['--version'], { encoding: 'utf8' }).trim();
	console.log(`Verified packaged conversion runtime ${version}: ${runtimePath}`);
};
