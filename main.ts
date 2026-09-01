import { app, BrowserWindow, dialog, ipcMain, nativeTheme, systemPreferences, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, initializeRuntimeConfig, loadConfig, saveConfig } from './config.js';

type CancelMode = 'save' | 'discard';
type TaskPhase = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

type WorkerMessage =
	| { type: 'status'; status: string }
	| { type: 'completed' }
	| { type: 'failed'; error: string }
	| { type: 'cancelled'; mode: CancelMode };

type ConversionTask = {
	id: string;
	taskName: string;
	taskPath: string;
	outputPath: string;
	status: string;
	phase: TaskPhase;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	error: string | null;
	worker?: Worker;
};

type TaskDto = Omit<ConversionTask, 'worker'> & { isRunning: boolean };

const tasks = new Map<string, ConversionTask>();
let activeTaskId: string | null = null;

const preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url));

function normalizeAccentColor(rawColor: string): string {
	const compact = rawColor.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
	if (compact.length >= 8) {
		return `#${compact.slice(compact.length - 6)}`;
	}
	if (compact.length >= 6) {
		return `#${compact.slice(0, 6)}`;
	}
	return '#2f6feb';
}

function getThemePayload(): { isDark: boolean; accentColor: string } {
	let accentColor = '#2f6feb';
	try {
		accentColor = normalizeAccentColor(systemPreferences.getAccentColor());
	} catch {
		// Fall back to a sensible accent when platform APIs are unavailable.
	}

	return {
		isDark: nativeTheme.shouldUseDarkColors,
		accentColor,
	};
}

function toTaskDto(task: ConversionTask): TaskDto {
	return {
		id: task.id,
		taskName: task.taskName,
		taskPath: task.taskPath,
		outputPath: task.outputPath,
		status: task.status,
		phase: task.phase,
		createdAt: task.createdAt,
		startedAt: task.startedAt,
		finishedAt: task.finishedAt,
		error: task.error,
		isRunning: task.phase === 'running' || task.phase === 'cancelling',
	};
}

function listTasks(): TaskDto[] {
	return Array.from(tasks.values())
		.sort((a, b) => b.createdAt - a.createdAt)
		.map(toTaskDto);
}

function broadcast(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send(channel, payload);
		}
	}
}

function broadcastTasks(): void {
	broadcast('tasks:updated', listTasks());
}

function broadcastTheme(): void {
	broadcast('ui:theme-updated', getThemePayload());
}

function createWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 1180,
		height: 820,
		minWidth: 920,
		minHeight: 640,
		backgroundColor: nativeTheme.shouldUseDarkColors ? '#111418' : '#f2f6ff',
		webPreferences: {
			preload: preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	void win.loadFile('index.html');
	return win;
}

function finalizeTask(task: ConversionTask, phase: 'completed' | 'failed' | 'cancelled', status: string, error: string | null = null): void {
	task.phase = phase;
	task.status = status;
	task.error = error;
	task.finishedAt = Date.now();

	const worker = task.worker;
	task.worker = undefined;
	if (activeTaskId === task.id) {
		activeTaskId = null;
	}

	if (worker) {
		worker.removeAllListeners();
		void worker.terminate().catch(() => {
			// Worker may already be exiting.
		});
	}

	broadcastTasks();
	void startNextTask();
}

function handleWorkerMessage(task: ConversionTask, message: WorkerMessage): void {
	if (message.type === 'status') {
		if (task.phase === 'running' || task.phase === 'cancelling') {
			task.status = message.status;
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
	broadcastTasks();

	const worker = new Worker(new URL('./conversion-worker.js', import.meta.url), {
		workerData: {
			taskId: nextTask.id,
			taskPath: nextTask.taskPath,
			taskName: nextTask.taskName,
			outputPath: nextTask.outputPath
		},
	});
	nextTask.worker = worker;
	const trackedTaskId = nextTask.id;

	worker.on('message', (message: WorkerMessage) => {
		const trackedTask = tasks.get(trackedTaskId);
		if (!trackedTask) {
			return;
		}
		handleWorkerMessage(trackedTask, message);
	});

	worker.on('error', (error) => {
		const trackedTask = tasks.get(trackedTaskId);
		if (!trackedTask || trackedTask.phase === 'completed' || trackedTask.phase === 'failed' || trackedTask.phase === 'cancelled') {
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
			if (trackedTask.phase === 'cancelling') {
				trackedTask.phase = 'cancelled';
				trackedTask.status = 'Conversion cancelled.';
				trackedTask.error = null;
			} else {
				trackedTask.phase = 'failed';
				trackedTask.status = code === 0
					? 'Conversion worker exited unexpectedly.'
					: `Conversion worker exited with code ${code}.`;
				trackedTask.error = trackedTask.status;
			}
			trackedTask.finishedAt = Date.now();
			broadcastTasks();
			void startNextTask();
		}
	});
}

function requireDirectoryPath(inputPath: string, fieldName: string): string {
	const resolved = path.resolve(inputPath.trim());
	if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
		throw new Error(`${fieldName} must point to an existing folder.`);
	}
	return resolved;
}

async function pickDirectory(event: IpcMainInvokeEvent, defaultPath?: string): Promise<string | null> {
	const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
	const dialogOptions: OpenDialogOptions = {
		title: 'Select Folder',
		defaultPath: defaultPath && defaultPath.trim().length > 0 ? defaultPath : config.outputDir,
		properties: ['openDirectory', 'createDirectory'],
	};

	const dialogResult = ownerWindow
		? await dialog.showOpenDialog(ownerWindow, dialogOptions)
		: await dialog.showOpenDialog(dialogOptions);

	if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
		return null;
	}

	return dialogResult.filePaths[0] ?? null;
}

function registerIpcHandlers(): void {
	ipcMain.handle('tasks:list', () => listTasks());

	ipcMain.handle('task:add', async (_event, payload: { taskPath: string; taskName?: string; }) => {
		const taskPath = requireDirectoryPath(payload.taskPath, 'Task path');
		const outputPath = path.resolve(config.outputDir);
		fs.mkdirSync(outputPath, { recursive: true });

		const taskName = payload.taskName?.trim().length
			? payload.taskName.trim()
			: path.basename(taskPath);

		const task: ConversionTask = {
			id: randomUUID(),
			taskName,
			taskPath,
			outputPath,
			status: 'Queued',
			phase: 'queued',
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

	ipcMain.handle('task:cancel', async (_event, payload: { taskId: string; mode: CancelMode }) => {
		const task = tasks.get(payload.taskId);
		if (!task) {
			throw new Error('Task not found.');
		}

		if (task.phase === 'queued') {
			task.phase = 'cancelled';
			task.status = 'Removed from queue.';
			task.error = null;
			task.finishedAt = Date.now();
			broadcastTasks();
			return toTaskDto(task);
		}

		if (task.phase !== 'running' && task.phase !== 'cancelling') {
			return toTaskDto(task);
		}

		if (payload.mode === 'discard') {
			const worker = task.worker;
			task.worker = undefined;
			task.phase = 'cancelled';
			task.status = 'Conversion cancelled entirely.';
			task.error = null;
			task.finishedAt = Date.now();
			if (activeTaskId === task.id) {
				activeTaskId = null;
			}

			if (worker) {
				worker.removeAllListeners();
				await worker.terminate().catch(() => {
					// Process might already be exiting.
				});
			}

			broadcastTasks();
			void startNextTask();
			return toTaskDto(task);
		}

		task.phase = 'cancelling';
		task.status = 'Cancellation requested. Saving progress and stopping...';
		task.error = null;
		task.worker?.postMessage({ type: 'cancel', mode: 'save' });
		broadcastTasks();
		return toTaskDto(task);
	});

	ipcMain.handle('settings:get', () => ({
		outputDir: config.outputDir,
		maxRepairRetries: config.maxRepairRetries,
	}));

	ipcMain.handle('settings:save', async (_event, payload: { outputDir: string; maxRepairRetries: number }) => {
		const outputDir = payload.outputDir?.trim();
		if (!outputDir) {
			throw new Error('Output directory cannot be empty.');
		}

		if (!Number.isInteger(payload.maxRepairRetries) || payload.maxRepairRetries < 0) {
			throw new Error('Maximum repair retries must be a non-negative whole number.');
		}

		const resolved = path.resolve(outputDir);
		fs.mkdirSync(resolved, { recursive: true });
		config.outputDir = resolved;
		config.maxRepairRetries = Math.min(payload.maxRepairRetries, 100);
		await saveConfig();

		return {
			outputDir: config.outputDir,
			maxRepairRetries: config.maxRepairRetries,
		};
	});

	ipcMain.handle('dialog:pick-directory', (event, payload?: { defaultPath?: string }) =>
		pickDirectory(event, payload?.defaultPath)
	);

	ipcMain.handle('ui:get-theme', () => getThemePayload());
}

app.whenReady().then(async () => {
	await loadConfig();
	initializeRuntimeConfig();
	registerIpcHandlers();
	createWindow();

	nativeTheme.on('updated', () => {
		broadcastTheme();
	});

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on('window-all-closed', async () => {
	if (process.platform !== 'darwin') {
		await saveConfig();
		app.quit();
	}
});