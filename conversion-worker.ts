import { parentPort, workerData } from 'node:worker_threads';
import { config, initializeRuntimeConfig, loadConfig } from './config.js';
import { ConversionAbortedError, type ConversionAbortMode, convertScenery } from './converter.js';
import type { WorkerInput, WorkerStatusMessage } from './task-types.js';

type WorkerControlMessage = {
	type: 'cancel';
	mode: ConversionAbortMode;
};

const payload = workerData as WorkerInput;
let abortMode: ConversionAbortMode | null = null;

function postMessage(message: WorkerStatusMessage): void {
	parentPort?.postMessage(message);
}

parentPort?.on('message', (message: WorkerControlMessage) => {
	if (message.type !== 'cancel') {
		return;
	}
	abortMode = message.mode;
	if (abortMode === 'save') {
		postMessage({ type: 'status', status: 'Cancellation requested. Saving progress and stopping soon...' });
	}
});

async function runConversion(): Promise<void> {
	await loadConfig();
	initializeRuntimeConfig();
	config.outputDir = payload.outputPath;

	await convertScenery(
		payload.inputPath,
		payload.outputPath,
		{
			conversionId: payload.taskId,
			shouldAbort: () => abortMode,
			onStatus: (status) => postMessage({ type: 'status', status }),
			onProgress: (progressItems) => postMessage({ type: 'progress', progressItems }),
		}
	);
}

void runConversion()
	.then(() => {
		if (abortMode) {
			postMessage({ type: 'cancelled', mode: abortMode });
			return;
		}
		postMessage({ type: 'completed' });
	})
	.catch((error: unknown) => {
		if (error instanceof ConversionAbortedError) {
			postMessage({ type: 'cancelled', mode: error.mode });
			return;
		}
		console.error(error);
		const message = error instanceof Error ? error.message : String(error);
		postMessage({ type: 'failed', error: message });
	});
