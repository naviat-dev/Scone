export type CancelMode = 'save' | 'discard';

export type TaskPhase = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export type ConversionProgressState = 'pending' | 'running' | 'completed' | 'failed';

export type ConversionProgressItem = {
	size: number;
	state: ConversionProgressState;
};

export type ConversionTaskDto = {
	id: string;
	taskName: string;
	inputPath: string;
	outputPath: string;
	status: string;
	phase: TaskPhase;
	isRunning: boolean;
	progressItems: ConversionProgressItem[];
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	error: string | null;
};

export type AddTaskPayload = {
	inputPath: string;
	outputPath: string;
};

export type SettingsPayload = {
	outputDir: string;
	maxRepairRetries: number;
};

export type WorkerInput = {
	taskId: string;
	inputPath: string;
	taskName: string;
	outputPath: string;
};

export type WorkerStatusMessage =
	| { type: 'status'; status: string }
	| { type: 'progress'; progressItems: ConversionProgressItem[] }
	| { type: 'completed' }
	| { type: 'failed'; error: string }
	| { type: 'cancelled'; mode: CancelMode };
