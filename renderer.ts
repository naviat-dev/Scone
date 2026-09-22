import type {
	AddTaskPayload,
	CancelMode,
	ConversionProgressItem,
	ConversionProgressState,
	ConversionTaskDto,
	SettingsPayload,
	TaskPhase,
} from './task-types.js';

type SectionName = 'current' | 'history' | 'settings';

type SconeApi = {
	getTasks: () => Promise<ConversionTaskDto[]>;
	addTask: (task: AddTaskPayload) => Promise<ConversionTaskDto>;
	cancelTask: (taskId: string, mode: CancelMode) => Promise<ConversionTaskDto>;
	getSettings: () => Promise<SettingsPayload>;
	saveSettings: (settings: SettingsPayload) => Promise<SettingsPayload>;
	pickDirectory: (defaultPath?: string) => Promise<string | null>;
	onTasksUpdated: (listener: (tasks: ConversionTaskDto[]) => void) => () => void;
};

declare global {
	interface Window {
		sconeApi?: SconeApi;
	}
}

const phaseLabels: Record<TaskPhase, string> = {
	queued: 'Queued',
	running: 'Running',
	cancelling: 'Cancelling',
	completed: 'Completed',
	failed: 'Failed',
	cancelled: 'Cancelled',
};

const progressStateLabels: Record<ConversionProgressState, string> = {
	pending: 'Pending',
	running: 'Running',
	completed: 'Completed',
	failed: 'Failed',
};

const sectionTitles: Record<SectionName, { title: string }> = {
	current: {
		title: 'Current conversions'
	},
	history: {
		title: 'Previous conversions'
	},
	settings: {
		title: 'Settings'
	},
};

const terminalPhases = new Set<TaskPhase>(['completed', 'failed', 'cancelled']);
const sectionHost = requireElement<HTMLDivElement>('section-host');
const appMessage = requireElement<HTMLDivElement>('app-message');
const navigationButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-section]'));

let tasks: ConversionTaskDto[] = [];
let settings: SettingsPayload = {
	outputDir: '',
	maxRepairRetries: 3,
};
let activeSection: SectionName = 'current';
let requestedSection: SectionName = 'current';
let isTransitioning = false;
let unsubscribeTasks: (() => void) | undefined;

function requireElement<T extends HTMLElement>(id: string): T {
	const element = document.getElementById(id);
	if (!element) {
		throw new Error(`Required element #${id} was not found.`);
	}
	return element as T;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
	tagName: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tagName);
	if (className) {
		element.className = className;
	}
	if (text !== undefined) {
		element.textContent = text;
	}
	return element;
}

function normalizeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function showMessage(message: string, isError = false): void {
	appMessage.textContent = message;
	appMessage.classList.toggle('is-error', isError);
	appMessage.hidden = false;
}

function clearMessage(): void {
	appMessage.textContent = '';
	appMessage.classList.remove('is-error');
	appMessage.hidden = true;
}

function getCurrentTasks(): ConversionTaskDto[] {
	return tasks.filter((task) => !terminalPhases.has(task.phase));
}

function getHistoryTasks(): ConversionTaskDto[] {
	return tasks.filter((task) => terminalPhases.has(task.phase));
}

function updateCounts(): void {
	requireElement<HTMLSpanElement>('current-task-count').textContent = String(getCurrentTasks().length);
	requireElement<HTMLSpanElement>('history-task-count').textContent = String(getHistoryTasks().length);
}

function updateSelectedTab(section: SectionName): void {
	for (const button of navigationButtons) {
		const isSelected = button.dataset.section === section;
		button.classList.toggle('is-active', isSelected);
		button.setAttribute('aria-selected', String(isSelected));
		button.tabIndex = isSelected ? 0 : -1;
	}
}

function createSectionHeading(section: SectionName, summary: string): HTMLElement {
	const heading = createElement('header', 'section-heading');
	const copy = createElement('div');
	const title = createElement('h2', undefined, sectionTitles[section].title);
	title.id = `${section}-section-title`;
	const summaryElement = createElement('span', 'section-summary', summary);
	summaryElement.id = `${section}-section-summary`;
	heading.append(copy, summaryElement);
	return heading;
}

function createChevron(): SVGSVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.classList.add('new-task-chevron');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'm7 10 5 5 5-5z');
	svg.append(path);
	return svg;
}

function createPathField(
	id: string,
	labelText: string,
	placeholder: string,
	initialValue = '',
): { field: HTMLLabelElement; input: HTMLInputElement; browseButton: HTMLButtonElement } {
	const field = createElement('label', 'field');
	field.htmlFor = id;
	field.append(createElement('span', undefined, labelText));

	const row = createElement('div', 'field-row');
	const input = createElement('input');
	input.id = id;
	input.name = id;
	input.type = 'text';
	input.placeholder = placeholder;
	input.autocomplete = 'off';
	input.value = initialValue;

	const browseButton = createElement('button', 'button', 'Browse');
	browseButton.type = 'button';
	row.append(input, browseButton);
	field.append(row);
	return { field, input, browseButton };
}

function setFormBusy(form: HTMLFormElement, busy: boolean): void {
	for (const control of form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) {
		control.disabled = busy;
	}
}

async function browseForDirectory(input: HTMLInputElement): Promise<void> {
	const api = window.sconeApi;
	if (!api) {
		showMessage('The desktop bridge is unavailable. Restart Scone and try again.', true);
		return;
	}

	try {
		const selectedPath = await api.pickDirectory(input.value || settings.outputDir);
		if (selectedPath) {
			input.value = selectedPath;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}
	} catch (error) {
		showMessage(normalizeError(error), true);
	}
}

function setNewTaskExpanded(
	card: HTMLElement,
	toggle: HTMLButtonElement,
	expansion: HTMLElement,
	expanded: boolean,
): void {
	card.classList.toggle('is-expanded', expanded);
	toggle.setAttribute('aria-expanded', String(expanded));
	expansion.setAttribute('aria-hidden', String(!expanded));
	expansion.inert = !expanded;
}

function createNewTaskCard(): HTMLElement {
	const card = createElement('article', 'new-task-card');
	const toggle = createElement('button', 'new-task-toggle');
	toggle.type = 'button';
	toggle.setAttribute('aria-expanded', 'false');
	toggle.setAttribute('aria-controls', 'new-task-fields');

	const icon = createElement('span', 'new-task-icon', '+');
	icon.setAttribute('aria-hidden', 'true');
	const copy = createElement('span', 'new-task-copy');
	copy.append(
		createElement('h3', undefined, 'Start a new conversion')
	);
	toggle.append(icon, copy, createChevron());

	const expansion = createElement('div', 'new-task-expansion');
	expansion.id = 'new-task-fields';
	expansion.setAttribute('aria-hidden', 'true');
	expansion.inert = true;
	const expansionInner = createElement('div', 'new-task-expansion-inner');
	const form = createElement('form', 'new-task-form');
	form.noValidate = true;

	const inputPath = createPathField(
		'input-path',
		'Input path',
		'Folder containing the source scenery',
	);
	const outputPath = createPathField(
		'output-path',
		'Output path',
		'Folder where converted scenery will be written',
		settings.outputDir,
	);
	const formMessage = createElement('p', 'form-message');
	formMessage.setAttribute('role', 'alert');

	const actions = createElement('div', 'form-actions');
	const cancelButton = createElement('button', 'button', 'Cancel');
	cancelButton.type = 'button';
	const runButton = createElement('button', 'button button-primary', 'Run conversion');
	runButton.type = 'submit';
	actions.append(cancelButton, runButton);
	form.append(inputPath.field, outputPath.field, formMessage, actions);
	expansionInner.append(form);
	expansion.append(expansionInner);
	card.append(toggle, expansion);

	toggle.addEventListener('click', () => {
		const expanded = toggle.getAttribute('aria-expanded') !== 'true';
		setNewTaskExpanded(card, toggle, expansion, expanded);
		if (expanded) {
			window.setTimeout(() => inputPath.input.focus(), 180);
		}
	});

	cancelButton.addEventListener('click', () => {
		inputPath.input.value = '';
		outputPath.input.value = settings.outputDir;
		formMessage.textContent = '';
		setNewTaskExpanded(card, toggle, expansion, false);
		toggle.focus();
	});

	inputPath.browseButton.addEventListener('click', () => {
		void browseForDirectory(inputPath.input);
	});
	outputPath.browseButton.addEventListener('click', () => {
		void browseForDirectory(outputPath.input);
	});

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		void (async () => {
			const source = inputPath.input.value.trim();
			const destination = outputPath.input.value.trim();
			if (!source || !destination) {
				formMessage.textContent = 'Both input and output paths are required.';
				(!source ? inputPath.input : outputPath.input).focus();
				return;
			}

			const api = window.sconeApi;
			if (!api) {
				formMessage.textContent = 'The desktop bridge is unavailable.';
				return;
			}

			formMessage.textContent = '';
			clearMessage();
			setFormBusy(form, true);
			runButton.textContent = 'Starting...';
			try {
				const task = await api.addTask({ inputPath: source, outputPath: destination });
				upsertTask(task);
				inputPath.input.value = '';
				outputPath.input.value = settings.outputDir;
				setNewTaskExpanded(card, toggle, expansion, false);
				showMessage(`${task.taskName} was added to the conversion queue.`);
			} catch (error) {
				formMessage.textContent = normalizeError(error);
			} finally {
				runButton.textContent = 'Run conversion';
				setFormBusy(form, false);
			}
		})();
	});

	return card;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '0 B';
	}

	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / (1024 ** unitIndex);
	const digits = unitIndex === 0 || value >= 10 ? 0 : 1;
	return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function createProgress(task: ConversionTaskDto): HTMLElement {
	const progressGroup = createElement('div', 'progress-group');
	const bar = createElement('div', 'weighted-progress-bar');
	bar.setAttribute('role', 'progressbar');
	bar.setAttribute('aria-valuemin', '0');
	bar.setAttribute('aria-valuemax', '100');

	const validItems = task.progressItems.filter(
		(item) => Number.isFinite(item.size) && item.size >= 0,
	);
	const items = validItems.length > 0
		? validItems
		: [{ size: 1, state: task.phase === 'queued' ? 'pending' : 'running' } satisfies ConversionProgressItem];
	const totalBytes = items.reduce((sum, item) => sum + Math.max(item.size, 1), 0);
	const processedBytes = items
		.filter((item) => item.state === 'completed' || item.state === 'failed')
		.reduce((sum, item) => sum + Math.max(item.size, 1), 0);
	const percentage = totalBytes > 0 ? Math.round((processedBytes / totalBytes) * 100) : 0;
	const isMeasuring = task.progressItems.length === 1
		&& task.progressItems[0]?.size === 1
		&& task.progressItems[0]?.state === 'running'
		&& /initial|start|scann|looking/i.test(task.status);

	type ProgressGroup = { state: ConversionProgressState; size: number };
	const groups: ProgressGroup[] = [];
	for (const item of items) {
		const size = Math.max(item.size, 1);
		const previous = groups.at(-1);
		if (previous?.state === item.state) {
			previous.size += size;
		} else {
			groups.push({ state: item.state, size });
		}
	}

	for (const group of groups) {
		const segment = createElement('span', `weighted-progress-segment ${group.state}`);
		segment.style.flexGrow = String(group.size);
		segment.title = `${progressStateLabels[group.state]}: ${formatBytes(group.size)}`;
		bar.append(segment);
	}

	bar.setAttribute('aria-valuenow', String(percentage));
	bar.setAttribute(
		'aria-valuetext',
		isMeasuring ? 'Calculating conversion workload' : `${percentage}% processed by source size`,
	);

	const meta = createElement('div', 'progress-meta');
	meta.append(
		createElement('span', undefined, isMeasuring ? 'Calculating workload...' : `${percentage}% processed`),
		createElement(
			'span',
			undefined,
			isMeasuring ? 'Scanning source files' : `${formatBytes(processedBytes)} of ${formatBytes(totalBytes)}`,
		),
	);
	progressGroup.append(bar, meta);
	return progressGroup;
}

function createPathDetails(task: ConversionTaskDto): HTMLElement {
	const list = createElement('dl', 'task-paths');
	for (const [label, value] of [['Input', task.inputPath], ['Output', task.outputPath]] as const) {
		const detail = createElement('div', 'path-detail');
		const term = createElement('dt', undefined, label);
		const description = createElement('dd', undefined, value);
		description.title = value;
		detail.append(term, description);
		list.append(detail);
	}
	return list;
}

function formatTimestamp(timestamp: number | null): string {
	return timestamp ? new Date(timestamp).toLocaleString() : 'Not recorded';
}

function createTaskCard(task: ConversionTaskDto, isCurrent: boolean): HTMLElement {
	const card = createElement('article', `task-card phase-${task.phase}`);
	const main = createElement('div', 'task-card-main');
	const titleRow = createElement('div', 'task-title-row');
	const title = createElement('h3', undefined, task.taskName);
	title.title = task.taskName;
	titleRow.append(title, createElement('span', `phase-badge phase-${task.phase}`, phaseLabels[task.phase]));
	main.append(titleRow, createElement('p', 'task-status', task.status), createPathDetails(task));

	if (isCurrent) {
		main.append(createProgress(task));
	} else {
		const historyMeta = createElement('div', 'history-meta');
		historyMeta.append(
			createElement('span', undefined, `Started: ${formatTimestamp(task.startedAt)}`),
			createElement('span', undefined, `Finished: ${formatTimestamp(task.finishedAt)}`),
		);
		main.append(historyMeta);
		if (task.error) {
			main.append(createElement('p', 'task-error', task.error));
		}
	}

	card.append(main);

	if (isCurrent) {
		const actions = createElement('div', 'task-actions');
		if (task.phase === 'queued') {
			const removeButton = createElement('button', 'button button-danger', 'Remove from queue');
			removeButton.type = 'button';
			removeButton.addEventListener('click', () => {
				void requestCancellation(task.id, 'discard');
			});
			actions.append(removeButton);
		} else {
			const saveButton = createElement('button', 'button', 'Cancel and save progress');
			saveButton.type = 'button';
			saveButton.disabled = task.phase === 'cancelling';
			saveButton.addEventListener('click', () => {
				void requestCancellation(task.id, 'save');
			});

			const discardButton = createElement('button', 'button button-danger', 'Cancel entirely');
			discardButton.type = 'button';
			discardButton.addEventListener('click', () => {
				void requestCancellation(task.id, 'discard');
			});
			actions.append(saveButton, discardButton);
		}
		card.append(actions);
	}

	return card;
}

function replaceTaskList(container: HTMLElement, list: ConversionTaskDto[], isCurrent: boolean): void {
	container.replaceChildren();
	if (list.length === 0) {
		const empty = createElement('div', 'empty-state');
		empty.append(
			createElement('h3', undefined, isCurrent ? 'No active conversions' : 'No previous conversions'),
			createElement(
				'p',
				undefined,
				isCurrent
					? 'Expand the card above to start your first conversion.'
					: 'Completed, failed, and cancelled work will appear here.',
			),
		);
		container.append(empty);
		return;
	}

	for (const task of list) {
		container.append(createTaskCard(task, isCurrent));
	}
}

function buildCurrentSection(): HTMLElement {
	const currentTasks = getCurrentTasks();
	const section = createElement('section', 'section-panel');
	section.setAttribute('role', 'tabpanel');
	section.setAttribute('aria-labelledby', 'current-tab');
	section.append(
		createSectionHeading('current', `${currentTasks.length} active`),
		createNewTaskCard(),
	);

	const taskList = createElement('div', 'card-list');
	taskList.id = 'current-task-list';
	replaceTaskList(taskList, currentTasks, true);
	section.append(taskList);
	return section;
}

function buildHistorySection(): HTMLElement {
	const historyTasks = getHistoryTasks();
	const section = createElement('section', 'section-panel');
	section.setAttribute('role', 'tabpanel');
	section.setAttribute('aria-labelledby', 'history-tab');
	section.append(createSectionHeading('history', `${historyTasks.length} total`));

	const taskList = createElement('div', 'card-list');
	taskList.id = 'history-task-list';
	replaceTaskList(taskList, historyTasks, false);
	section.append(taskList);
	return section;
}

function buildSettingsSection(): HTMLElement {
	const section = createElement('section', 'section-panel');
	section.setAttribute('role', 'tabpanel');
	section.setAttribute('aria-labelledby', 'settings-tab');
	section.append(createSectionHeading('settings', 'Application defaults'));

	const card = createElement('article', 'settings-card');
	const form = createElement('form', 'settings-form');
	form.noValidate = true;
	const outputPath = createPathField(
		'default-output-path',
		'Default output path',
		'Folder suggested for new conversions',
		settings.outputDir,
	);
	const retryField = createElement('label', 'field');
	retryField.htmlFor = 'max-repair-retries';
	retryField.append(createElement('span', undefined, 'Maximum repair retries'));
	const retryInput = createElement('input');
	retryInput.id = 'max-repair-retries';
	retryInput.name = 'max-repair-retries';
	retryInput.type = 'number';
	retryInput.min = '0';
	retryInput.max = '100';
	retryInput.step = '1';
	retryInput.value = String(settings.maxRepairRetries);
	retryField.append(retryInput);

	const note = createElement(
		'p',
		'settings-note',
		'The default output path pre-fills new tasks; each conversion can still use a different destination.',
	);
	const formMessage = createElement('p', 'form-message');
	formMessage.setAttribute('role', 'alert');
	const actions = createElement('div', 'form-actions');
	const resetButton = createElement('button', 'button', 'Reset');
	resetButton.type = 'button';
	const saveButton = createElement('button', 'button button-primary', 'Save settings');
	saveButton.type = 'submit';
	actions.append(resetButton, saveButton);
	form.append(outputPath.field, retryField, note, formMessage, actions);
	card.append(form);
	section.append(card);

	outputPath.browseButton.addEventListener('click', () => {
		void browseForDirectory(outputPath.input);
	});
	resetButton.addEventListener('click', () => {
		outputPath.input.value = settings.outputDir;
		retryInput.value = String(settings.maxRepairRetries);
		formMessage.textContent = '';
	});
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		void (async () => {
			const outputDir = outputPath.input.value.trim();
			const retriesText = retryInput.value.trim();
			if (!outputDir) {
				formMessage.textContent = 'A default output path is required.';
				outputPath.input.focus();
				return;
			}
			if (!/^\d+$/.test(retriesText)) {
				formMessage.textContent = 'Maximum repair retries must be a whole number from 0 to 100.';
				retryInput.focus();
				return;
			}
			const maxRepairRetries = Number.parseInt(retriesText, 10);
			if (maxRepairRetries > 100) {
				formMessage.textContent = 'Maximum repair retries must be a whole number from 0 to 100.';
				retryInput.focus();
				return;
			}

			const api = window.sconeApi;
			if (!api) {
				formMessage.textContent = 'The desktop bridge is unavailable.';
				return;
			}

			formMessage.textContent = '';
			clearMessage();
			setFormBusy(form, true);
			saveButton.textContent = 'Saving...';
			try {
				settings = await api.saveSettings({ outputDir, maxRepairRetries });
				outputPath.input.value = settings.outputDir;
				retryInput.value = String(settings.maxRepairRetries);
				showMessage('Settings saved.');
			} catch (error) {
				formMessage.textContent = normalizeError(error);
			} finally {
				saveButton.textContent = 'Save settings';
				setFormBusy(form, false);
			}
		})();
	});

	return section;
}

function buildSection(section: SectionName): HTMLElement {
	if (section === 'current') {
		return buildCurrentSection();
	}
	if (section === 'history') {
		return buildHistorySection();
	}
	return buildSettingsSection();
}

function renderSectionImmediately(section: SectionName): void {
	activeSection = section;
	requestedSection = section;
	updateSelectedTab(section);
	sectionHost.replaceChildren(buildSection(section));
}

function waitForTransition(element: HTMLElement): Promise<void> {
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
		return Promise.resolve();
	}

	return new Promise((resolve) => {
		let completed = false;
		const finish = () => {
			if (completed) {
				return;
			}
			completed = true;
			window.clearTimeout(timeoutId);
			element.removeEventListener('transitionend', handleTransitionEnd);
			resolve();
		};
		const handleTransitionEnd = (event: TransitionEvent) => {
			if (event.target === element && event.propertyName === 'transform') {
				finish();
			}
		};
		const timeoutId = window.setTimeout(finish, 280);
		element.addEventListener('transitionend', handleTransitionEnd);
	});
}

async function runSectionTransition(): Promise<void> {
	if (isTransitioning) {
		return;
	}

	isTransitioning = true;
	try {
		while (activeSection !== requestedSection) {
			const outgoing = sectionHost.firstElementChild;
			if (outgoing instanceof HTMLElement) {
				outgoing.classList.add('is-leaving');
				await waitForTransition(outgoing);
				outgoing.remove();
			}

			activeSection = requestedSection;
			const incoming = buildSection(activeSection);
			incoming.classList.add('is-entering');
			sectionHost.append(incoming);
			void incoming.offsetWidth;
			incoming.classList.remove('is-entering');
			await waitForTransition(incoming);
		}
	} finally {
		isTransitioning = false;
	}
}

function requestSection(section: SectionName): void {
	requestedSection = section;
	updateSelectedTab(section);
	void runSectionTransition();
}

function isSectionName(value: string | undefined): value is SectionName {
	return value === 'current' || value === 'history' || value === 'settings';
}

function registerNavigation(): void {
	navigationButtons.forEach((button, index) => {
		button.addEventListener('click', () => {
			if (isSectionName(button.dataset.section)) {
				requestSection(button.dataset.section);
			}
		});
		button.addEventListener('keydown', (event) => {
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowLeft') {
				return;
			}
			event.preventDefault();
			const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
			const nextIndex = (index + direction + navigationButtons.length) % navigationButtons.length;
			const nextButton = navigationButtons[nextIndex];
			nextButton.focus();
			if (isSectionName(nextButton.dataset.section)) {
				requestSection(nextButton.dataset.section);
			}
		});
	});
}

function upsertTask(updatedTask: ConversionTaskDto): void {
	const existingIndex = tasks.findIndex((task) => task.id === updatedTask.id);
	if (existingIndex === -1) {
		tasks = [updatedTask, ...tasks];
	} else {
		tasks = tasks.map((task, index) => index === existingIndex ? updatedTask : task);
	}
	tasks.sort((a, b) => b.createdAt - a.createdAt);
	updateCounts();
	refreshVisibleTaskList();
}

function refreshVisibleTaskList(): void {
	if (activeSection === 'current') {
		const currentTasks = getCurrentTasks();
		const taskList = document.getElementById('current-task-list');
		const summary = document.getElementById('current-section-summary');
		if (taskList) {
			replaceTaskList(taskList, currentTasks, true);
		}
		if (summary) {
			summary.textContent = `${currentTasks.length} active`;
		}
		return;
	}

	if (activeSection === 'history') {
		const historyTasks = getHistoryTasks();
		const taskList = document.getElementById('history-task-list');
		const summary = document.getElementById('history-section-summary');
		if (taskList) {
			replaceTaskList(taskList, historyTasks, false);
		}
		if (summary) {
			summary.textContent = `${historyTasks.length} total`;
		}
	}
}

async function requestCancellation(taskId: string, mode: CancelMode): Promise<void> {
	const api = window.sconeApi;
	if (!api) {
		showMessage('The desktop bridge is unavailable. Restart Scone and try again.', true);
		return;
	}

	clearMessage();
	try {
		upsertTask(await api.cancelTask(taskId, mode));
	} catch (error) {
		showMessage(normalizeError(error), true);
	}
}

async function initialize(): Promise<void> {
	registerNavigation();
	renderSectionImmediately('current');
	updateCounts();

	const api = window.sconeApi;
	if (!api) {
		showMessage('The desktop bridge is unavailable. Run this page through the Scone desktop application.', true);
		return;
	}

	const [loadedTasks, loadedSettings] = await Promise.all([
		api.getTasks(),
		api.getSettings(),
	]);
	tasks = loadedTasks.sort((a, b) => b.createdAt - a.createdAt);
	settings = loadedSettings;
	updateCounts();
	renderSectionImmediately(activeSection);

	unsubscribeTasks = api.onTasksUpdated((updatedTasks) => {
		tasks = updatedTasks.sort((a, b) => b.createdAt - a.createdAt);
		updateCounts();
		refreshVisibleTaskList();
	});
}

window.addEventListener('beforeunload', () => {
	unsubscribeTasks?.();
});

void initialize().catch((error: unknown) => {
	showMessage(`Unable to initialize Scone: ${normalizeError(error)}`, true);
});