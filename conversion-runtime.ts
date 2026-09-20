import * as fs from 'node:fs';
import * as path from 'node:path';
import { totalmem } from 'node:os';

const MEBIBYTE = 1024 * 1024;
const MINIMUM_CONVERSION_HEAP_MIB = 8192;

export type ConversionRuntimePaths = {
	nodeExecutable: string;
	workerScript: string;
	workingDirectory: string;
};

export function getConversionHeapLimitMiB(totalMemoryBytes = totalmem()): number {
	const physicalMemoryMiB = Math.ceil(totalMemoryBytes / MEBIBYTE);
	// Keep V8's guard above physical RAM so allocation pressure reaches the OS before this ceiling.
	return Math.max(MINIMUM_CONVERSION_HEAP_MIB, physicalMemoryMiB * 2);
}

export function getConversionProcessArguments(
	workerScript: string,
	totalMemoryBytes = totalmem(),
): string[] {
	return [
		'--enable-source-maps',
		'--expose-gc',
		'--heap-growing-percent=10',
		'--max-semi-space-size=64',
		`--max-old-space-size=${getConversionHeapLimitMiB(totalMemoryBytes)}`,
		workerScript,
	];
}

export function resolveConversionRuntime(
	appPath: string,
	resourcesPath: string,
	isPackaged: boolean,
	platform = process.platform,
): ConversionRuntimePaths {
	const nodeExecutableName = platform === 'win32' ? 'node.exe' : 'node';
	const nodeExecutable = isPackaged
		? path.join(resourcesPath, 'runtime', nodeExecutableName)
		: path.join(appPath, 'node_modules', 'node', 'bin', nodeExecutableName);
	const workerScript = path.join(appPath, 'dist', 'conversion-worker.js');

	if (!fs.existsSync(nodeExecutable)) {
		throw new Error(`Bundled Node.js runtime was not found: ${nodeExecutable}`);
	}
	if (!fs.existsSync(workerScript)) {
		throw new Error(`Conversion worker was not found: ${workerScript}`);
	}

	return {
		nodeExecutable,
		workerScript,
		workingDirectory: appPath,
	};
}
