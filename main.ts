import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { config, initializeRuntimeConfig, loadConfig, saveConfig } from './config.js';
import type { ConversionAbortMode } from './converter.js';

const DEFAULT_WINDOW_WIDTH = 1180;
const DEFAULT_WINDOW_HEIGHT = 820;
const MIN_WINDOW_WIDTH = 920;
const MIN_WINDOW_HEIGHT = 640;
const EXPANDED_COMPOSER_WINDOW_HEIGHT = 980;

const thisFilePath = fileURLToPath(import.meta.url);
const distDirectory = path.dirname(thisFilePath);
const projectRoot = path.resolve(distDirectory, '..');
const preloadPath = path.join(distDirectory, 'preload.js');
const conversionWorkerPath = path.join(distDirectory, 'conversion-worker.js');

type TaskLifecycleState = 'running' | 'completed' | 'failed' | 'cancelled';

type TaskProgressSnapshot = {
	total: number;
	pending: number;
	running: number;
	completed: number;
	failed: number;
};

type ConversionTaskSnapshot = {
	id: string;
	taskName: string;
	inputPath: string;
	outputPath: string;
	status: string;
	state: TaskLifecycleState;
	progress: TaskProgressSnapshot;
	startedAt: number;
	finishedAt: number | null;
};

type ConversionTaskRecord = ConversionTaskSnapshot & {
	worker: Worker | null;
};

type WorkerControlMessage = {
	type: 'cancel';
	mode: ConversionAbortMode;
};

type WorkerStatusMessage =
	| { type: 'status'; status: string }
	| { type: 'progress'; progress: TaskProgressSnapshot }
	| { type: 'completed' }
	| { type: 'failed'; error: string }
	| { type: 'cancelled'; mode: ConversionAbortMode };

type StartConversionRequest = {
	inputPath: string;
	outputPath: string;
	taskName?: string;
};

type CancelConversionRequest = {
	taskId: string;
	mode: ConversionAbortMode;
};

const tasks = new Map<string, ConversionTaskRecord>();
const compactHeightsByWindowId = new Map<number, number>();
const resizeTimersByWindowId = new Map<number, NodeJS.Timeout>();

let appWindow: BrowserWindow | null = null;
let configLoaded = false;
let runtimeInitialized = false;

function toTaskSnapshot(task: ConversionTaskRecord): ConversionTaskSnapshot {
	return {
		id: task.id,
		taskName: task.taskName,
		inputPath: task.inputPath,
		outputPath: task.outputPath,
		status: task.status,
		state: task.state,
		progress: task.progress,
		startedAt: task.startedAt,
		finishedAt: task.finishedAt,
	};
}

function sendTaskUpdate(task: ConversionTaskRecord): void {
	const snapshot = toTaskSnapshot(task);
	for (const window of BrowserWindow.getAllWindows()) {
		window.webContents.send('conversion:update', snapshot);
	}
}

function sendTaskUpdateById(taskId: string): void {
	const task = tasks.get(taskId);
	if (!task) {
		return;
	}
	sendTaskUpdate(task);
}

function normalizePathInput(value: unknown, fieldName: string): string {
	if (typeof value !== 'string') {
		throw new Error(`${fieldName} must be a string.`);
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new Error(`${fieldName} is required.`);
	}

	return path.resolve(trimmed);
}

function getTaskName(taskPath: string, requestedName?: string): string {
	const trimmedName = requestedName?.trim() ?? '';
	if (trimmedName.length > 0) {
		return trimmedName;
	}

	const derivedName = path.basename(taskPath);
	if (derivedName.length > 0) {
		return derivedName;
	}

	return taskPath;
}

function stopWindowResizeAnimation(windowId: number): void {
	const timer = resizeTimersByWindowId.get(windowId);
	if (!timer) {
		return;
	}
	clearInterval(timer);
	resizeTimersByWindowId.delete(windowId);
}

function animateWindowHeight(window: BrowserWindow, targetHeight: number): void {
	const [width, startHeight] = window.getSize();
	if (startHeight === targetHeight) {
		return;
	}

	const windowId = window.id;
	stopWindowResizeAnimation(windowId);
	const startedAt = Date.now();
	const durationMs = 280;
	const heightDelta = targetHeight - startHeight;

	const timer = setInterval(() => {
		if (window.isDestroyed()) {
			stopWindowResizeAnimation(windowId);
			return;
		}

		const elapsed = Date.now() - startedAt;
		const progress = Math.min(1, elapsed / durationMs);
		const eased = 1 - Math.pow(1 - progress, 3);
		const nextHeight = Math.round(startHeight + (heightDelta * eased));
		window.setSize(width, nextHeight);

		if (progress >= 1) {
			stopWindowResizeAnimation(windowId);
		}
	}, 16);

	resizeTimersByWindowId.set(windowId, timer);
}

function isStartConversionRequest(value: unknown): value is StartConversionRequest {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	return typeof candidate.inputPath === 'string'
		&& typeof candidate.outputPath === 'string'
		&& (candidate.taskName === undefined || typeof candidate.taskName === 'string');
}

function isCancelConversionRequest(value: unknown): value is CancelConversionRequest {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	return typeof candidate.taskId === 'string'
		&& (candidate.mode === 'save' || candidate.mode === 'discard');
}

function applyWindowSizingForComposer(window: BrowserWindow, isOpen: boolean): void {
	const [, height] = window.getSize();
	const windowId = window.id;

	if (isOpen) {
		if (!compactHeightsByWindowId.has(windowId)) {
			compactHeightsByWindowId.set(windowId, height);
		}
		const expandedHeight = Math.max(height, EXPANDED_COMPOSER_WINDOW_HEIGHT);
		if (expandedHeight !== height) {
			animateWindowHeight(window, expandedHeight);
		}
		return;
	}

	const compactHeight = compactHeightsByWindowId.get(windowId);
	if (compactHeight === undefined) {
		return;
	}

	const targetHeight = Math.max(compactHeight, DEFAULT_WINDOW_HEIGHT);
	if (targetHeight !== height) {
		animateWindowHeight(window, targetHeight);
	}
	compactHeightsByWindowId.delete(windowId);
}

function setTaskAsTerminal(task: ConversionTaskRecord, state: Exclude<TaskLifecycleState, 'running'>, status: string): void {
	task.state = state;
	task.status = status;
	task.finishedAt = Date.now();
	task.worker = null;

	if (task.progress.total === 0) {
		task.progress = {
			total: 1,
			pending: 0,
			running: 0,
			completed: state === 'completed' ? 1 : 0,
			failed: state === 'failed' ? 1 : 0,
		};
	} else {
		task.progress.running = 0;
		task.progress.pending = state === 'completed' ? 0 : task.progress.pending;
	}

	sendTaskUpdate(task);
}

function handleWorkerMessage(taskId: string, message: WorkerStatusMessage): void {
	const task = tasks.get(taskId);
	if (!task || task.state !== 'running') {
		return;
	}

	switch (message.type) {
		case 'status':
			task.status = message.status;
			sendTaskUpdate(task);
			break;
		case 'progress':
			task.progress = message.progress;
			sendTaskUpdate(task);
			break;
		case 'completed':
			setTaskAsTerminal(task, 'completed', 'Completed');
			break;
		case 'failed':
			setTaskAsTerminal(task, 'failed', `Failed: ${message.error}`);
			break;
		case 'cancelled':
			setTaskAsTerminal(
				task,
				'cancelled',
				message.mode === 'save'
					? 'Cancelled after saving progress.'
					: 'Cancelled.'
			);
			break;
		default:
			break;
	}
}

function markTaskAsFailed(taskId: string, reason: string): void {
	const task = tasks.get(taskId);
	if (!task || task.state !== 'running') {
		return;
	}

	setTaskAsTerminal(task, 'failed', `Failed: ${reason}`);
}

async function ensureRuntimeConfiguration(): Promise<void> {
	if (!configLoaded) {
		await loadConfig();
		configLoaded = true;
	}
	if (!runtimeInitialized) {
		initializeRuntimeConfig();
		runtimeInitialized = true;
	}
}

function createWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: DEFAULT_WINDOW_WIDTH,
		height: DEFAULT_WINDOW_HEIGHT,
		minWidth: MIN_WINDOW_WIDTH,
		minHeight: MIN_WINDOW_HEIGHT,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: preloadPath,
		},
	});

	win.on('closed', () => {
		stopWindowResizeAnimation(win.id);
		compactHeightsByWindowId.delete(win.id);
		if (appWindow?.id === win.id) {
			appWindow = null;
		}
	});

	void win.loadFile(path.join(projectRoot, 'index.html'));
	return win;
}

function registerIpcHandlers(): void {
	ipcMain.handle('app:get-initial-state', async () => {
		await ensureRuntimeConfiguration();
		return {
			outputDirectory: config.outputDir,
			tasks: Array.from(tasks.values()).map(toTaskSnapshot),
		};
	});

	ipcMain.handle('dialog:pick-folder', async (event, value: unknown) => {
		const senderWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
		const defaultPath = typeof value === 'string' && value.trim().length > 0
			? path.resolve(value)
			: undefined;

		const options: OpenDialogOptions = {
			properties: ['openDirectory', 'createDirectory'],
			defaultPath,
		};
		const result = senderWindow
			? await dialog.showOpenDialog(senderWindow, options)
			: await dialog.showOpenDialog(options);

		if (result.canceled || result.filePaths.length === 0) {
			return null;
		}

		return result.filePaths[0];
	});

	ipcMain.handle('config:set-output-directory', async (_event, request: unknown) => {
		await ensureRuntimeConfiguration();
		const outputDirectory = normalizePathInput(request, 'Output path');
		fs.mkdirSync(outputDirectory, { recursive: true });
		config.outputDir = outputDirectory;
		await saveConfig();
		return config.outputDir;
	});

	ipcMain.handle('window:set-conversion-panel-open', (event, request: unknown) => {
		const senderWindow = BrowserWindow.fromWebContents(event.sender);
		if (!senderWindow) {
			return;
		}
		applyWindowSizingForComposer(senderWindow, request === true);
	});

	ipcMain.handle('conversion:start', async (_event, request: unknown) => {
		await ensureRuntimeConfiguration();

		if (!isStartConversionRequest(request)) {
			throw new Error('Invalid conversion request.');
		}

		const taskPath = normalizePathInput(request.inputPath, 'Input path');
		const outputPath = normalizePathInput(request.outputPath, 'Output path');
		const taskName = getTaskName(taskPath, request.taskName);

		if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isDirectory()) {
			throw new Error(`Input path does not exist or is not a directory: ${taskPath}`);
		}

		fs.mkdirSync(outputPath, { recursive: true });
		config.outputDir = outputPath;
		await saveConfig();

		const taskId = randomUUID();
		const worker = new Worker(conversionWorkerPath, {
			workerData: {
				taskId,
				taskPath,
				taskName,
				outputPath,
			},
		});

		const task: ConversionTaskRecord = {
			id: taskId,
			taskName,
			inputPath: taskPath,
			outputPath,
			status: 'Starting conversion...',
			state: 'running',
			progress: {
				total: 1,
				pending: 0,
				running: 1,
				completed: 0,
				failed: 0,
			},
			startedAt: Date.now(),
			finishedAt: null,
			worker,
		};

		tasks.set(taskId, task);
		sendTaskUpdate(task);

		worker.on('message', (message: WorkerStatusMessage) => {
			handleWorkerMessage(taskId, message);
		});

		worker.on('error', (error: Error) => {
			markTaskAsFailed(taskId, error.message);
		});

		worker.on('exit', (code: number) => {
			if (code !== 0) {
				markTaskAsFailed(taskId, `Worker exited unexpectedly with code ${code}.`);
			}
			const taskAfterExit = tasks.get(taskId);
			if (taskAfterExit) {
				taskAfterExit.worker = null;
				sendTaskUpdate(taskAfterExit);
			}
		});

		return toTaskSnapshot(task);
	});

	ipcMain.handle('conversion:cancel', (_event, request: unknown) => {
		if (!isCancelConversionRequest(request)) {
			throw new Error('Invalid cancellation request.');
		}

		const task = tasks.get(request.taskId);
		if (!task || task.state !== 'running' || !task.worker) {
			return false;
		}

		const workerMessage: WorkerControlMessage = {
			type: 'cancel',
			mode: request.mode,
		};
		task.worker.postMessage(workerMessage);
		task.status = request.mode === 'save'
			? 'Cancellation requested. Saving progress and stopping soon...'
			: 'Cancellation requested. Stopping immediately...';
		sendTaskUpdate(task);
		return true;
	});
}

function terminateRunningWorkers(): void {
	for (const windowId of resizeTimersByWindowId.keys()) {
		stopWindowResizeAnimation(windowId);
	}

	for (const task of tasks.values()) {
		if (!task.worker) {
			continue;
		}
		void task.worker.terminate();
		task.worker = null;
		sendTaskUpdateById(task.id);
	}
}

app.whenReady().then(async () => {
	await ensureRuntimeConfiguration();
	registerIpcHandlers();
	appWindow = createWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			appWindow = createWindow();
		}
	});
});

app.on('before-quit', () => {
	terminateRunningWorkers();
});

app.on('window-all-closed', async () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});