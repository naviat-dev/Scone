import { contextBridge, ipcRenderer } from 'electron';

type CancelMode = 'save' | 'discard';
type TaskPhase = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

type ConversionTask = {
	id: string;
	taskName: string;
	taskPath: string;
	outputPath: string;
	status: string;
	phase: TaskPhase;
	isRunning: boolean;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	error: string | null;
};

type SettingsPayload = {
	outputDir: string;
	fgPath: string;
	sceneryDirectories: string[];
	maxRepairRetries: number;
	maxTileRetries: number;
};

type ThemePayload = {
	isDark: boolean;
	accentColor: string;
};

type AutodetectResult = {
	sceneryDirectories: string[];
	fgPath?: string;
	aborted?: boolean;
};

type AddTaskPayload = {
	taskPath: string;
	taskName?: string;
};

const api = {
	getTasks: (): Promise<ConversionTask[]> => ipcRenderer.invoke('tasks:list'),
	addTask: (task: AddTaskPayload): Promise<ConversionTask> => ipcRenderer.invoke('task:add', task),
	cancelTask: (taskId: string, mode: CancelMode): Promise<ConversionTask> => ipcRenderer.invoke('task:cancel', { taskId, mode }),
	getSettings: (): Promise<SettingsPayload> => ipcRenderer.invoke('settings:get'),
	saveSettings: (settings: SettingsPayload): Promise<SettingsPayload> =>
		ipcRenderer.invoke('settings:save', settings),
	pickDirectory: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:pick-directory', { defaultPath }),
	getTheme: (): Promise<ThemePayload> => ipcRenderer.invoke('ui:get-theme'),
	autodetectScenery: (): Promise<AutodetectResult> => ipcRenderer.invoke('fg:autodetect'),
	abortAutodetect: (): Promise<{ success: boolean }> => ipcRenderer.invoke('fg:autodetect-abort'),
	onTasksUpdated: (listener: (tasks: ConversionTask[]) => void): (() => void) => {
		const handler = (_event: Electron.IpcRendererEvent, tasks: ConversionTask[]) => listener(tasks);
		ipcRenderer.on('tasks:updated', handler);
		return () => {
			ipcRenderer.removeListener('tasks:updated', handler);
		};
	},
	onThemeUpdated: (listener: (theme: ThemePayload) => void): (() => void) => {
		const handler = (_event: Electron.IpcRendererEvent, theme: ThemePayload) => listener(theme);
		ipcRenderer.on('ui:theme-updated', handler);
		return () => {
			ipcRenderer.removeListener('ui:theme-updated', handler);
		};
	},
	onAutodetectProgress: (listener: (progress: { status: string }) => void): (() => void) => {
		const handler = (_event: Electron.IpcRendererEvent, progress: { status: string }) => listener(progress);
		ipcRenderer.on('fg:autodetect-progress', handler);
		return () => {
			ipcRenderer.removeListener('fg:autodetect-progress', handler);
		};
	},
};

contextBridge.exposeInMainWorld('sconeApi', api);
