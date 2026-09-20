import { parentPort, workerData } from 'node:worker_threads';
import { config, initializeRuntimeConfig, loadConfig } from './config.js';
import { ConversionAbortedError, type ConversionAbortMode, convertScenery } from './converter.js';
import type { WorkerInput, WorkerStatusMessage } from './task-types.js';

type WorkerControlMessage = {
	type: 'cancel';
	mode: ConversionAbortMode;
};

let abortMode: ConversionAbortMode | null = null;

function parseWorkerInput(value: unknown): WorkerInput {
	if (!value || typeof value !== 'object') {
		throw new Error('Conversion worker input is missing.');
	}

	const input = value as Partial<WorkerInput>;
	if (
		typeof input.taskId !== 'string'
		|| typeof input.inputPath !== 'string'
		|| typeof input.taskName !== 'string'
		|| typeof input.outputPath !== 'string'
	) {
		throw new Error('Conversion worker input is invalid.');
	}

	return input as WorkerInput;
}

function getWorkerInput(): WorkerInput {
	if (parentPort) {
		return parseWorkerInput(workerData);
	}

	const serializedInput = process.env.SCONE_WORKER_DATA;
	if (!serializedInput) {
		throw new Error('SCONE_WORKER_DATA is not set for the conversion process.');
	}

	try {
		return parseWorkerInput(JSON.parse(serializedInput));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error('SCONE_WORKER_DATA contains invalid JSON.', { cause: error });
		}
		throw error;
	}
}

function postMessage(message: WorkerStatusMessage): void {
	if (parentPort) {
		parentPort.postMessage(message);
		return;
	}
	if (process.send && process.connected) {
		process.send(message);
		return;
	}
	throw new Error('Conversion process IPC channel is unavailable.');
}

function postFinalMessage(message: WorkerStatusMessage): void {
	if (parentPort) {
		parentPort.postMessage(message);
		return;
	}
	if (!process.send || !process.connected) {
		console.error('Conversion process IPC channel closed before the final status could be sent.');
		process.exitCode = 1;
		return;
	}

	process.send(message, (error) => {
		if (error) {
			console.error('Unable to send the final conversion status.', error);
			process.exitCode = 1;
		}
		if (process.connected) {
			process.disconnect();
		}
	});
}

function handleControlMessage(message: unknown): void {
	if (
		!message
		|| typeof message !== 'object'
		|| (message as Partial<WorkerControlMessage>).type !== 'cancel'
	) {
		return;
	}

	const mode = (message as Partial<WorkerControlMessage>).mode;
	if (mode !== 'save' && mode !== 'discard') {
		console.warn('Ignoring a conversion cancellation request with an invalid mode.');
		return;
	}

	abortMode = mode;
	if (abortMode === 'save') {
		postMessage({ type: 'status', status: 'Cancellation requested. Saving progress and stopping soon...' });
	}
}

parentPort?.on('message', handleControlMessage);
if (!parentPort) {
	process.on('message', handleControlMessage);
}

async function runConversion(): Promise<void> {
	const payload = getWorkerInput();
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
			postFinalMessage({ type: 'cancelled', mode: abortMode });
			return;
		}
		postFinalMessage({ type: 'completed' });
	})
	.catch((error: unknown) => {
		if (error instanceof ConversionAbortedError) {
			postFinalMessage({ type: 'cancelled', mode: error.mode });
			return;
		}
		console.error(error);
		const message = error instanceof Error ? error.message : String(error);
		postFinalMessage({ type: 'failed', error: message });
	});
