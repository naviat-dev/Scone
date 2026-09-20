import { contextBridge, ipcRenderer } from 'electron';
import type {
	AddTaskPayload,
	CancelMode,
	ConversionTaskDto,
	SettingsPayload,
} from './task-types.js';

const api = {
	getTasks: (): Promise<ConversionTaskDto[]> => ipcRenderer.invoke('tasks:list'),
	addTask: (task: AddTaskPayload): Promise<ConversionTaskDto> => ipcRenderer.invoke('task:add', task),
	cancelTask: (taskId: string, mode: CancelMode): Promise<ConversionTaskDto> =>
		ipcRenderer.invoke('task:cancel', { taskId, mode }),
	getSettings: (): Promise<SettingsPayload> => ipcRenderer.invoke('settings:get'),
	saveSettings: (settings: SettingsPayload): Promise<SettingsPayload> =>
		ipcRenderer.invoke('settings:save', settings),
	pickDirectory: (defaultPath?: string): Promise<string | null> =>
		ipcRenderer.invoke('dialog:pick-directory', { defaultPath }),
	onTasksUpdated: (listener: (tasks: ConversionTaskDto[]) => void): (() => void) => {
		const handler = (_event: Electron.IpcRendererEvent, tasks: ConversionTaskDto[]) => listener(tasks);
		ipcRenderer.on('tasks:updated', handler);
		return () => {
			ipcRenderer.removeListener('tasks:updated', handler);
		};
	},
};

contextBridge.exposeInMainWorld('sconeApi', api);
