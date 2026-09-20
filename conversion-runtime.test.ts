import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
	getConversionHeapLimitMiB,
	getConversionProcessArguments,
	resolveConversionRuntime,
} from './conversion-runtime.js';

test('conversion heap ceiling remains above physical memory', () => {
	assert.equal(getConversionHeapLimitMiB(2 * 1024 ** 3), 8192);
	assert.equal(getConversionHeapLimitMiB(16 * 1024 ** 3), 32768);
});

test('conversion process enables an expandable heap and explicit collection', () => {
	assert.deepEqual(getConversionProcessArguments('worker.js', 16 * 1024 ** 3), [
		'--enable-source-maps',
		'--expose-gc',
		'--heap-growing-percent=10',
		'--max-semi-space-size=64',
		'--max-old-space-size=32768',
		'worker.js',
	]);
});

test('development runtime resolves the project-local Node executable', () => {
	const root = fs.mkdtempSync(path.join(tmpdir(), 'scone-runtime-dev-'));
	try {
		const workerScript = path.join(root, 'dist', 'conversion-worker.js');
		const nodeExecutable = path.join(root, 'node_modules', 'node', 'bin', 'node.exe');
		fs.mkdirSync(path.dirname(workerScript), { recursive: true });
		fs.mkdirSync(path.dirname(nodeExecutable), { recursive: true });
		fs.writeFileSync(workerScript, '');
		fs.writeFileSync(nodeExecutable, '');

		assert.deepEqual(resolveConversionRuntime(root, 'unused', false, 'win32'), {
			nodeExecutable,
			workerScript,
			workingDirectory: root,
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('packaged runtime resolves the bundled Node executable', () => {
	const root = fs.mkdtempSync(path.join(tmpdir(), 'scone-runtime-packaged-'));
	const appPath = path.join(root, 'app');
	const resourcesPath = path.join(root, 'resources');
	try {
		const workerScript = path.join(appPath, 'dist', 'conversion-worker.js');
		const nodeExecutable = path.join(resourcesPath, 'runtime', 'node');
		fs.mkdirSync(path.dirname(workerScript), { recursive: true });
		fs.mkdirSync(path.dirname(nodeExecutable), { recursive: true });
		fs.writeFileSync(workerScript, '');
		fs.writeFileSync(nodeExecutable, '');

		assert.deepEqual(resolveConversionRuntime(appPath, resourcesPath, true, 'linux'), {
			nodeExecutable,
			workerScript,
			workingDirectory: appPath,
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
