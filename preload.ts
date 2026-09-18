import { contextBridge, ipcRenderer } from 'electron';
import type { ConversionAbortMode } from './converter.js';

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

type InitialStatePayload = {
	outputDirectory: string;
	tasks: ConversionTaskSnapshot[];
};

type Unsubscribe = () => void;

const sconeApi = {
	getInitialState(): Promise<InitialStatePayload> {
		return ipcRenderer.invoke('app:get-initial-state');
	},
	pickFolder(defaultPath: string): Promise<string | null> {
		return ipcRenderer.invoke('dialog:pick-folder', defaultPath);
	},
	setOutputDirectory(outputPath: string): Promise<string> {
		return ipcRenderer.invoke('config:set-output-directory', outputPath);
	},
	setConversionPanelOpen(isOpen: boolean): Promise<void> {
		return ipcRenderer.invoke('window:set-conversion-panel-open', isOpen);
	},
	startConversion(inputPath: string, outputPath: string, taskName?: string): Promise<ConversionTaskSnapshot> {
		return ipcRenderer.invoke('conversion:start', { inputPath, outputPath, taskName });
	},
	cancelConversion(taskId: string, mode: ConversionAbortMode): Promise<boolean> {
		return ipcRenderer.invoke('conversion:cancel', { taskId, mode });
	},
	onTaskUpdate(listener: (task: ConversionTaskSnapshot) => void): Unsubscribe {
		const wrappedListener = (_event: unknown, task: ConversionTaskSnapshot) => {
			listener(task);
		};

		ipcRenderer.on('conversion:update', wrappedListener);
		return () => {
			ipcRenderer.off('conversion:update', wrappedListener);
		};
	},
};

contextBridge.exposeInMainWorld('sconeApi', sconeApi);
