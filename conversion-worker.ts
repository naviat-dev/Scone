import { parentPort, workerData } from 'node:worker_threads';
import { config, initializeRuntimeConfig, loadConfig } from './config.js';
import { ConversionAbortedError, conversions, type ConversionAbortMode, convertScenery } from './converter.js';

type WorkerInput = {
	taskId: string;
	taskPath: string;
	taskName: string;
	outputPath: string;
};

type WorkerControlMessage = {
	type: 'cancel';
	mode: ConversionAbortMode;
};

type WorkerStatusMessage =
	| { type: 'status'; status: string }
	| { type: 'progress'; progress: WorkerProgressSnapshot }
	| { type: 'completed' }
	| { type: 'failed'; error: string }
	| { type: 'cancelled'; mode: ConversionAbortMode };

type WorkerProgressSnapshot = {
	total: number;
	pending: number;
	running: number;
	completed: number;
	failed: number;
};

const payload = workerData as WorkerInput;
let abortMode: ConversionAbortMode | null = null;
let conversionId: string | null = null;
let lastPublishedStatus: string | null = null;

function postMessage(message: WorkerStatusMessage): void {
	parentPort?.postMessage(message);
}

function getCurrentConversion() {
	if (conversionId && conversions[conversionId]) {
		return conversions[conversionId];
	}

	const matches = Object.values(conversions)
		.filter((entry) => entry.inputPath === payload.taskPath && entry.outputPath === payload.outputPath)
		.sort((a, b) => a.id.localeCompare(b.id));

	if (matches.length === 0) {
		return null;
	}

	conversionId = matches[matches.length - 1].id;
	return conversions[conversionId];
}

function buildProgressSnapshot(): WorkerProgressSnapshot | null {
	const conversion = getCurrentConversion();
	if (!conversion) {
		return null;
	}

	const counts: WorkerProgressSnapshot = {
		total: conversion.progressItems.length,
		pending: 0,
		running: 0,
		completed: 0,
		failed: 0,
	};

	for (const item of conversion.progressItems) {
		switch (item.state) {
			case 'pending':
				counts.pending += 1;
				break;
			case 'running':
				counts.running += 1;
				break;
			case 'completed':
				counts.completed += 1;
				break;
			case 'failed':
				counts.failed += 1;
				break;
			default:
				break;
		}
	}

	return counts;
}

function emitProgressSnapshot(): void {
	const conversion = getCurrentConversion();
	if (conversion && conversion.status !== lastPublishedStatus) {
		lastPublishedStatus = conversion.status;
		postMessage({ type: 'status', status: conversion.status });
	}

	const progress = buildProgressSnapshot();
	if (progress) {
		postMessage({ type: 'progress', progress });
	}
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
	const progressInterval = setInterval(emitProgressSnapshot, 350);

	await loadConfig();
	try {
		initializeRuntimeConfig();
		config.outputDir = payload.outputPath;

		await convertScenery(
			payload.taskPath,
			payload.outputPath,
			{
				shouldAbort: () => abortMode,
				onStatus: (status) => postMessage({ type: 'status', status }),
			}
		);

		emitProgressSnapshot();
	} finally {
		clearInterval(progressInterval);
	}
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
