import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, initializeRuntimeConfig, loadConfig, saveConfig } from './config.js';
import type {
	CancelMode,
	ConversionProgressItem,
	ConversionProgressState,
	ConversionTaskDto,
	SettingsPayload,
	TaskPhase,
	WorkerInput,
	WorkerStatusMessage,
} from './task-types.js';

type ConversionTask = Omit<ConversionTaskDto, 'isRunning'> & {
	worker?: Worker;
};

const tasks = new Map<string, ConversionTask>();
let activeTaskId: string | null = null;

const preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const terminalPhases = new Set<TaskPhase>(['completed', 'failed', 'cancelled']);
const progressStates = new Set<ConversionProgressState>(['pending', 'running', 'completed', 'failed']);

function toTaskDto(task: ConversionTask): ConversionTaskDto {
	return {
		id: task.id,
		taskName: task.taskName,
		inputPath: task.inputPath,
		outputPath: task.outputPath,
		status: task.status,
		phase: task.phase,
		isRunning: task.phase === 'running' || task.phase === 'cancelling',
		progressItems: task.progressItems.map((item) => ({ ...item })),
		createdAt: task.createdAt,
		startedAt: task.startedAt,
		finishedAt: task.finishedAt,
		error: task.error,
	};
}

function listTasks(): ConversionTaskDto[] {
	return Array.from(tasks.values())
		.sort((a, b) => b.createdAt - a.createdAt)
		.map(toTaskDto);
}

function broadcastTasks(): void {
	const taskList = listTasks();
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send('tasks:updated', taskList);
		}
	}
}

function createWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 1180,
		height: 820,
		minWidth: 920,
		minHeight: 640,
		backgroundColor: '#f6f7f9',
		webPreferences: {
			preload: preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	void win.loadFile('index.html');
	return win;
}

function normalizeProgressItems(progressItems: ConversionProgressItem[]): ConversionProgressItem[] {
	return progressItems
		.filter((item) => Number.isFinite(item.size) && item.size >= 0 && progressStates.has(item.state))
		.map((item) => ({
			size: item.size,
			state: item.state,
		}));
}

function terminateWorker(worker: Worker): void {
	void worker.terminate().catch((error: unknown) => {
		console.warn('Unable to terminate conversion worker cleanly.', error);
	});
}

function finalizeTask(
	task: ConversionTask,
	phase: Extract<TaskPhase, 'completed' | 'failed' | 'cancelled'>,
	status: string,
	error: string | null = null,
): void {
	task.phase = phase;
	task.status = status;
	task.error = error;
	task.finishedAt = Date.now();

	if (phase === 'completed') {
		task.progressItems = task.progressItems.map((item) => ({
			...item,
			state: item.state === 'failed' ? 'failed' : 'completed',
		}));
	}

	const worker = task.worker;
	task.worker = undefined;
	if (activeTaskId === task.id) {
		activeTaskId = null;
	}

	if (worker) {
		worker.removeAllListeners();
		terminateWorker(worker);
	}

	broadcastTasks();
	void startNextTask();
}

function handleWorkerMessage(task: ConversionTask, message: WorkerStatusMessage): void {
	if (message.type === 'status') {
		if (task.phase === 'running' || task.phase === 'cancelling') {
			task.status = message.status;
			broadcastTasks();
		}
		return;
	}

	if (message.type === 'progress') {
		if (task.phase === 'running' || task.phase === 'cancelling') {
			task.progressItems = normalizeProgressItems(message.progressItems);
			broadcastTasks();
		}
		return;
	}

	if (message.type === 'completed') {
		finalizeTask(task, 'completed', 'Conversion completed successfully.');
		return;
	}

	if (message.type === 'cancelled') {
		const status = message.mode === 'save'
			? 'Conversion cancelled. Partial progress has been kept.'
			: 'Conversion cancelled entirely.';
		finalizeTask(task, 'cancelled', status);
		return;
	}

	finalizeTask(task, 'failed', `Conversion failed: ${message.error}`, message.error);
}

async function startNextTask(): Promise<void> {
	if (activeTaskId) {
		return;
	}

	const nextTask = Array.from(tasks.values()).find((task) => task.phase === 'queued');
	if (!nextTask) {
		return;
	}

	activeTaskId = nextTask.id;
	nextTask.phase = 'running';
	nextTask.status = `Starting ${nextTask.taskName}...`;
	nextTask.startedAt = Date.now();
	nextTask.finishedAt = null;
	nextTask.error = null;
	nextTask.progressItems = [];
	broadcastTasks();

	const workerInput: WorkerInput = {
		taskId: nextTask.id,
		inputPath: nextTask.inputPath,
		taskName: nextTask.taskName,
		outputPath: nextTask.outputPath,
	};

	let worker: Worker;
	try {
		worker = new Worker(new URL('./conversion-worker.js', import.meta.url), {
			workerData: workerInput,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		finalizeTask(nextTask, 'failed', `Conversion failed to start: ${message}`, message);
		return;
	}

	nextTask.worker = worker;
	const trackedTaskId = nextTask.id;

	worker.on('message', (message: WorkerStatusMessage) => {
		const trackedTask = tasks.get(trackedTaskId);
		if (trackedTask) {
			handleWorkerMessage(trackedTask, message);
		}
	});

	worker.on('error', (error) => {
		const trackedTask = tasks.get(trackedTaskId);
		if (!trackedTask || terminalPhases.has(trackedTask.phase)) {
			return;
		}
		finalizeTask(trackedTask, 'failed', `Conversion failed: ${error.message}`, error.message);
	});

	worker.on('exit', (code) => {
		const trackedTask = tasks.get(trackedTaskId);
		if (!trackedTask) {
			return;
		}

		if (trackedTask.worker === worker) {
			trackedTask.worker = undefined;
		}
		if (activeTaskId === trackedTaskId) {
			activeTaskId = null;
		}

		if (trackedTask.phase === 'running' || trackedTask.phase === 'cancelling') {
			const status = trackedTask.phase === 'cancelling'
				? 'Conversion cancelled.'
				: code === 0
					? 'Conversion worker exited unexpectedly.'
					: `Conversion worker exited with code ${code}.`;
			const phase = trackedTask.phase === 'cancelling' ? 'cancelled' : 'failed';
			finalizeTask(trackedTask, phase, status, phase === 'failed' ? status : null);
		}
	});
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} is invalid.`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, fieldName: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${fieldName} is required.`);
	}
	return value.trim();
}

function requireInputDirectory(inputPath: unknown): string {
	const resolved = path.resolve(requireString(inputPath, 'Input path'));
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
		throw new Error('Input path must point to an existing folder.');
	}
	return resolved;
}

function prepareOutputDirectory(outputPath: unknown): string {
	const resolved = path.resolve(requireString(outputPath, 'Output path'));
	if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
		throw new Error('Output path must point to a folder.');
	}
	fs.mkdirSync(resolved, { recursive: true });
	return resolved;
}

async function pickDirectory(event: IpcMainInvokeEvent, defaultPath?: string): Promise<string | null> {
	const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
	const dialogOptions: OpenDialogOptions = {
		title: 'Select Folder',
		defaultPath: defaultPath?.trim() || config.outputDir,
		properties: ['openDirectory', 'createDirectory'],
	};
	const result = ownerWindow
		? await dialog.showOpenDialog(ownerWindow, dialogOptions)
		: await dialog.showOpenDialog(dialogOptions);

	return result.canceled ? null : result.filePaths[0] ?? null;
}

function registerIpcHandlers(): void {
	ipcMain.handle('tasks:list', () => listTasks());

	ipcMain.handle('task:add', (_event, value: unknown) => {
		const payload = requireObject(value, 'Conversion task');
		const inputPath = requireInputDirectory(payload.inputPath);
		const outputPath = prepareOutputDirectory(payload.outputPath);
		const task: ConversionTask = {
			id: randomUUID(),
			taskName: path.basename(inputPath) || inputPath,
			inputPath,
			outputPath,
			status: 'Queued',
			phase: 'queued',
			progressItems: [],
			createdAt: Date.now(),
			startedAt: null,
			finishedAt: null,
			error: null,
		};

		tasks.set(task.id, task);
		broadcastTasks();
		void startNextTask();
		return toTaskDto(task);
	});

	ipcMain.handle('task:cancel', async (_event, value: unknown) => {
		const payload = requireObject(value, 'Cancellation request');
		const taskId = requireString(payload.taskId, 'Task ID');
		if (payload.mode !== 'save' && payload.mode !== 'discard') {
			throw new Error('Cancellation mode is invalid.');
		}
		const mode: CancelMode = payload.mode;
		const task = tasks.get(taskId);
		if (!task) {
			throw new Error('Task not found.');
		}

		if (task.phase === 'queued') {
			finalizeTask(task, 'cancelled', 'Removed from the queue.');
			return toTaskDto(task);
		}

		if (task.phase !== 'running' && task.phase !== 'cancelling') {
			return toTaskDto(task);
		}

		if (mode === 'discard') {
			const worker = task.worker;
			task.worker = undefined;
			if (worker) {
				worker.removeAllListeners();
				await worker.terminate().catch((error: unknown) => {
					console.warn('Unable to terminate the cancelled conversion worker cleanly.', error);
				});
			}
			finalizeTask(task, 'cancelled', 'Conversion cancelled entirely.');
			return toTaskDto(task);
		}

		task.phase = 'cancelling';
		task.status = 'Cancellation requested. Saving progress and stopping...';
		task.error = null;
		task.worker?.postMessage({ type: 'cancel', mode });
		broadcastTasks();
		return toTaskDto(task);
	});

	ipcMain.handle('settings:get', (): SettingsPayload => ({
		outputDir: config.outputDir,
		maxRepairRetries: config.maxRepairRetries,
	}));

	ipcMain.handle('settings:save', async (_event, value: unknown): Promise<SettingsPayload> => {
		const payload = requireObject(value, 'Settings');
		const outputDir = prepareOutputDirectory(payload.outputDir);
		const maxRepairRetries = payload.maxRepairRetries;
		if (!Number.isInteger(maxRepairRetries) || (maxRepairRetries as number) < 0 || (maxRepairRetries as number) > 100) {
			throw new Error('Maximum repair retries must be a whole number from 0 to 100.');
		}

		config.outputDir = outputDir;
		config.maxRepairRetries = maxRepairRetries as number;
		await saveConfig();
		return {
			outputDir: config.outputDir,
			maxRepairRetries: config.maxRepairRetries,
		};
	});

	ipcMain.handle('dialog:pick-directory', (event, value: unknown) => {
		const payload = value === undefined ? {} : requireObject(value, 'Directory picker request');
		const defaultPath = typeof payload.defaultPath === 'string' ? payload.defaultPath : undefined;
		return pickDirectory(event, defaultPath);
	});
}

async function initializeApplication(): Promise<void> {
	await loadConfig();
	initializeRuntimeConfig();
	registerIpcHandlers();
	createWindow();
}

void app.whenReady()
	.then(initializeApplication)
	.catch((error: unknown) => {
		console.error('Unable to initialize Scone.', error);
		app.quit();
	});

app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) {
		createWindow();
	}
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		void saveConfig().catch((error: unknown) => {
			console.error('Unable to save settings while closing Scone.', error);
		});
		app.quit();
	}
});
