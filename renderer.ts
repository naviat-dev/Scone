type ConversionAbortMode = 'save' | 'discard';
type TaskLifecycleState = 'running' | 'completed' | 'failed' | 'cancelled';
type ViewMode = 'current' | 'finished';
type ProgressSegmentState = 'pending' | 'running' | 'success' | 'failed';

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

type SconeApi = {
	getInitialState(): Promise<InitialStatePayload>;
	pickFolder(defaultPath: string): Promise<string | null>;
	setOutputDirectory(outputPath: string): Promise<string>;
	setConversionPanelOpen(isOpen: boolean): Promise<void>;
	startConversion(inputPath: string, outputPath: string, taskName?: string): Promise<ConversionTaskSnapshot>;
	cancelConversion(taskId: string, mode: ConversionAbortMode): Promise<boolean>;
	onTaskUpdate(listener: (task: ConversionTaskSnapshot) => void): () => void;
};

type ProgressSegment = {
	label: string;
	weight: number;
	state: ProgressSegmentState;
};

type UiElements = {
	newConversionTrigger: HTMLElement;
	newConversionPanel: HTMLElement;
	inputPathInput: HTMLInputElement;
	outputPathInput: HTMLInputElement;
	formError: HTMLElement;
	browseInputButton: HTMLButtonElement;
	browseOutputButton: HTMLButtonElement;
	cancelNewConversionButton: HTMLButtonElement;
	startConversionButton: HTMLButtonElement;
	currentList: HTMLElement;
	finishedList: HTMLElement;
	currentEmptyState: HTMLElement;
	finishedEmptyState: HTMLElement;
	currentCount: HTMLElement;
	finishedCount: HTMLElement;
	currentLink: HTMLElement;
	finishedLink: HTMLElement;
	settingsLink: HTMLElement;
	taskTemplate: HTMLTemplateElement;
};

declare global {
	interface Window {
		sconeApi?: SconeApi;
	}
}

const tasksById = new Map<string, ConversionTaskSnapshot>();
let outputDirectory = '';
let panelOpen = false;
let activeView: ViewMode = 'current';
let api: SconeApi | null = null;

function requireElement<TElement extends Element>(selector: string): TElement {
	const element = document.querySelector<TElement>(selector);
	if (!element) {
		throw new Error(`Missing UI element: ${selector}`);
	}
	return element;
}

function getUiElements(): UiElements {
	return {
		newConversionTrigger: requireElement<HTMLElement>('[data-js="new-conversion-trigger"]'),
		newConversionPanel: requireElement<HTMLElement>('[data-js="new-conversion-panel"]'),
		inputPathInput: requireElement<HTMLInputElement>('[data-js="input-path"]'),
		outputPathInput: requireElement<HTMLInputElement>('[data-js="output-path"]'),
		formError: requireElement<HTMLElement>('[data-js="conversion-form-error"]'),
		browseInputButton: requireElement<HTMLButtonElement>('[data-js="browse-input"]'),
		browseOutputButton: requireElement<HTMLButtonElement>('[data-js="browse-output"]'),
		cancelNewConversionButton: requireElement<HTMLButtonElement>('[data-js="cancel-new-conversion"]'),
		startConversionButton: requireElement<HTMLButtonElement>('[data-js="start-conversion"]'),
		currentList: requireElement<HTMLElement>('[data-js="current-conversions"]'),
		finishedList: requireElement<HTMLElement>('[data-js="finished-conversions"]'),
		currentEmptyState: requireElement<HTMLElement>('[data-js="current-empty-state"]'),
		finishedEmptyState: requireElement<HTMLElement>('[data-js="finished-empty-state"]'),
		currentCount: requireElement<HTMLElement>('[data-js="current-count"]'),
		finishedCount: requireElement<HTMLElement>('[data-js="finished-count"]'),
		currentLink: requireElement<HTMLElement>('[data-js="current-link"]'),
		finishedLink: requireElement<HTMLElement>('[data-js="finished-link"]'),
		settingsLink: requireElement<HTMLElement>('[data-js="settings-link"]'),
		taskTemplate: requireElement<HTMLTemplateElement>('[data-js="conversion-card-template"]'),
	};
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function getTaskBadgeLabel(state: TaskLifecycleState): string {
	switch (state) {
		case 'running':
			return 'Running';
		case 'completed':
			return 'Completed';
		case 'failed':
			return 'Failed';
		case 'cancelled':
			return 'Cancelled';
		default:
			return 'Task';
	}
}

function getTaskNameFromPath(inputPath: string): string {
	const trimmed = inputPath.trim().replace(/[\\/]+$/, '');
	if (!trimmed) {
		return 'Conversion';
	}
	const parts = trimmed.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? trimmed;
}

function setFormError(formErrorElement: HTMLElement, message: string | null): void {
	if (!message || message.trim().length === 0) {
		formErrorElement.textContent = '';
		formErrorElement.hidden = true;
		return;
	}

	formErrorElement.textContent = message;
	formErrorElement.hidden = false;
}

function getProgressSegments(task: ConversionTaskSnapshot): ProgressSegment[] {
	const progress = task.progress;
	if (progress.total <= 0) {
		if (task.state === 'running') {
			return [{ label: 'Running', weight: 1, state: 'running' }];
		}
		if (task.state === 'failed') {
			return [{ label: 'Failed', weight: 1, state: 'failed' }];
		}
		if (task.state === 'completed') {
			return [{ label: 'Completed', weight: 1, state: 'success' }];
		}
		return [{ label: 'Cancelled', weight: 1, state: 'pending' }];
	}

	const pending = Math.max(progress.pending, progress.total - progress.running - progress.completed - progress.failed);
	const segments: ProgressSegment[] = [];

	if (progress.completed > 0) {
		segments.push({ label: 'Completed', weight: progress.completed, state: 'success' });
	}
	if (progress.running > 0) {
		segments.push({ label: 'Running', weight: progress.running, state: 'running' });
	}
	if (pending > 0) {
		segments.push({ label: 'Pending', weight: pending, state: 'pending' });
	}
	if (progress.failed > 0) {
		segments.push({ label: 'Failed', weight: progress.failed, state: 'failed' });
	}

	if (segments.length === 0) {
		return [{ label: 'Running', weight: 1, state: 'running' }];
	}

	return segments;
}

function renderWeightedProgressBar(bar: HTMLElement, task: ConversionTaskSnapshot): void {
	const segments = getProgressSegments(task);
	const totalWeight = segments.reduce((sum, segment) => sum + segment.weight, 0) || 1;
	bar.replaceChildren();

	const ariaText = segments
		.map((segment) => `${segment.label} ${segment.weight}`)
		.join(', ');
	bar.setAttribute('aria-label', `Weighted segmented progress: ${ariaText}`);

	for (const segment of segments) {
		const widthPercent = (segment.weight / totalWeight) * 100;
		const segmentElement = document.createElement('div');
		segmentElement.className = `weighted-progress-segment ${segment.state}`;
		segmentElement.style.flexGrow = String(segment.weight || 0.0001);
		segmentElement.style.flexShrink = '1';
		segmentElement.style.flexBasis = '0';
		segmentElement.title = `${segment.label}: ${segment.weight}`;

		if (widthPercent < 16) {
			segmentElement.classList.add('tight');
		}
		if (widthPercent < 10) {
			segmentElement.classList.add('micro');
		}
		if (widthPercent < 6) {
			segmentElement.classList.add('nano');
		}

		bar.appendChild(segmentElement);
	}
}

function setActiveView(view: ViewMode, elements: UiElements): void {
	activeView = view;
	elements.currentLink.classList.toggle('is-active', view === 'current');
	elements.finishedLink.classList.toggle('is-active', view === 'finished');
}

async function setPanelOpen(isOpen: boolean, elements: UiElements): Promise<void> {
	if (panelOpen === isOpen) {
		return;
	}

	panelOpen = isOpen;
	elements.newConversionPanel.classList.toggle('is-open', isOpen);
	elements.newConversionPanel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
	elements.newConversionTrigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

	if (isOpen) {
		elements.outputPathInput.value = outputDirectory;
		setFormError(elements.formError, null);
		window.setTimeout(() => {
			elements.inputPathInput.focus();
		}, 30);
	}

	if (api) {
		try {
			await api.setConversionPanelOpen(isOpen);
		} catch (error) {
			setFormError(elements.formError, getErrorMessage(error));
		}
	}
}

async function browseForPath(
	elements: UiElements,
	input: HTMLInputElement,
	defaultPath: string,
): Promise<void> {
	if (!api) {
		return;
	}

	try {
		const selectedPath = await api.pickFolder(defaultPath);
		if (!selectedPath) {
			return;
		}
		input.value = selectedPath;
		setFormError(elements.formError, null);
	} catch (error) {
		setFormError(elements.formError, getErrorMessage(error));
	}
}

async function startNewConversion(elements: UiElements): Promise<void> {
	if (!api) {
		return;
	}

	const inputPath = elements.inputPathInput.value.trim();
	const outputPath = elements.outputPathInput.value.trim() || outputDirectory;

	if (inputPath.length === 0) {
		setFormError(elements.formError, 'Please choose an input scenery folder.');
		return;
	}
	if (outputPath.length === 0) {
		setFormError(elements.formError, 'Please choose an output folder.');
		return;
	}

	elements.startConversionButton.disabled = true;
	setFormError(elements.formError, null);

	try {
		const taskName = getTaskNameFromPath(inputPath);
		const task = await api.startConversion(inputPath, outputPath, taskName);
		tasksById.set(task.id, task);
		outputDirectory = outputPath;
		elements.outputPathInput.value = outputPath;
		elements.inputPathInput.value = '';
		await setPanelOpen(false, elements);
		renderTasks(elements);
	} catch (error) {
		setFormError(elements.formError, getErrorMessage(error));
	} finally {
		elements.startConversionButton.disabled = false;
	}
}

async function selectDefaultOutputDirectory(elements: UiElements): Promise<void> {
	if (!api) {
		return;
	}

	try {
		const selectedPath = await api.pickFolder(outputDirectory);
		if (!selectedPath) {
			return;
		}
		outputDirectory = await api.setOutputDirectory(selectedPath);
		elements.outputPathInput.value = outputDirectory;
	} catch (error) {
		setFormError(elements.formError, getErrorMessage(error));
	}
}

function renderTaskCollection(
	container: HTMLElement,
	tasks: ConversionTaskSnapshot[],
	elements: UiElements
): void {
	container.replaceChildren();

	for (const task of tasks) {
		const templateRoot = elements.taskTemplate.content.firstElementChild;
		if (!templateRoot) {
			continue;
		}

		const card = templateRoot.cloneNode(true) as HTMLElement;
		const badge = card.querySelector<HTMLElement>('[data-js="task-badge"]');
		const title = card.querySelector<HTMLElement>('[data-js="task-title"]');
		const status = card.querySelector<HTMLElement>('[data-js="task-status"]');
		const pathText = card.querySelector<HTMLElement>('[data-js="task-path"]');
		const progressBar = card.querySelector<HTMLElement>('[data-js="weighted-progress-bar"]');
		const actions = card.querySelector<HTMLElement>('[data-js="task-actions"]');
		const cancelSaveButton = card.querySelector<HTMLButtonElement>('[data-js="cancel-save"]');
		const cancelDiscardButton = card.querySelector<HTMLButtonElement>('[data-js="cancel-discard"]');

		if (!badge || !title || !status || !pathText || !progressBar || !actions) {
			continue;
		}

		const badgeClassName = `task-badge-${task.state}`;
		badge.textContent = getTaskBadgeLabel(task.state);
		badge.classList.add(badgeClassName);
		title.textContent = task.taskName;
		status.textContent = task.status;
		pathText.textContent = `${task.inputPath} -> ${task.outputPath}`;
		renderWeightedProgressBar(progressBar, task);

		const isRunning = task.state === 'running';
		actions.classList.toggle('is-hidden', !isRunning);

		if (isRunning && cancelSaveButton && cancelDiscardButton && api) {
			cancelSaveButton.addEventListener('click', () => {
				void api?.cancelConversion(task.id, 'save');
			});
			cancelDiscardButton.addEventListener('click', () => {
				void api?.cancelConversion(task.id, 'discard');
			});
		}

		container.appendChild(card);
	}
}

function renderTasks(elements: UiElements): void {
	const allTasks = Array.from(tasksById.values()).sort((left, right) => right.startedAt - left.startedAt);
	const currentTasks = allTasks.filter((task) => task.state === 'running');
	const finishedTasks = allTasks
		.filter((task) => task.state !== 'running')
		.sort((left, right) => (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt));

	elements.currentCount.textContent = String(currentTasks.length);
	elements.finishedCount.textContent = String(finishedTasks.length);

	renderTaskCollection(elements.currentList, currentTasks, elements);
	renderTaskCollection(elements.finishedList, finishedTasks, elements);

	const showingCurrent = activeView === 'current';
	elements.currentList.hidden = !showingCurrent;
	elements.finishedList.hidden = showingCurrent;
	elements.currentEmptyState.hidden = !showingCurrent || currentTasks.length > 0;
	elements.finishedEmptyState.hidden = showingCurrent || finishedTasks.length > 0;
}

async function initializeRenderer(): Promise<void> {
	api = window.sconeApi ?? null;
	if (!api) {
		console.error('Scone preload API is unavailable.');
		return;
	}

	const elements = getUiElements();

	elements.newConversionTrigger.addEventListener('click', () => {
		void setPanelOpen(!panelOpen, elements);
	});
	elements.newConversionTrigger.addEventListener('keydown', (event: KeyboardEvent) => {
		if (event.key !== 'Enter' && event.key !== ' ') {
			return;
		}
		event.preventDefault();
		void setPanelOpen(!panelOpen, elements);
	});

	elements.browseInputButton.addEventListener('click', () => {
		void browseForPath(elements, elements.inputPathInput, elements.inputPathInput.value || outputDirectory);
	});

	elements.browseOutputButton.addEventListener('click', () => {
		void browseForPath(elements, elements.outputPathInput, elements.outputPathInput.value || outputDirectory);
	});

	elements.cancelNewConversionButton.addEventListener('click', () => {
		void setPanelOpen(false, elements);
	});

	elements.startConversionButton.addEventListener('click', () => {
		void startNewConversion(elements);
	});

	elements.currentLink.addEventListener('click', (event) => {
		event.preventDefault();
		setActiveView('current', elements);
		renderTasks(elements);
	});

	elements.finishedLink.addEventListener('click', (event) => {
		event.preventDefault();
		setActiveView('finished', elements);
		renderTasks(elements);
	});

	elements.settingsLink.addEventListener('click', (event) => {
		event.preventDefault();
		void selectDefaultOutputDirectory(elements);
	});

	const initialState = await api.getInitialState();
	outputDirectory = initialState.outputDirectory;
	elements.outputPathInput.value = outputDirectory;
	for (const task of initialState.tasks) {
		tasksById.set(task.id, task);
	}

	api.onTaskUpdate((task) => {
		tasksById.set(task.id, task);
		renderTasks(elements);
	});

	setActiveView('current', elements);
	renderTasks(elements);
}

document.addEventListener('DOMContentLoaded', () => {
	void initializeRenderer().catch((error) => {
		console.error('Failed to initialize renderer UI.', error);
	});
});

export { };
