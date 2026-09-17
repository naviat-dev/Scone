import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

type Task = {
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

type TaskPhase = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
type CancelMode = 'save' | 'discard';

type SettingsPayload = {
	outputDir: string;
	fgPath: string;
	sceneryDirectories: string[];
	maxRepairRetries: number;
	maxTileRetries: number;
};

type AutodetectResult = {
	sceneryDirectories: string[];
	fgPath?: string;
	aborted?: boolean;
};

type ThemePayload = {
	isDark: boolean;
	accentColor: string;
};

type SconeApi = {
	getTasks: () => Promise<Task[]>;
	addTask: (task: { taskPath: string; taskName?: string; }) => Promise<Task>;
	cancelTask: (taskId: string, mode: CancelMode) => Promise<Task>;
	getSettings: () => Promise<SettingsPayload>;
	saveSettings: (settings: SettingsPayload) => Promise<SettingsPayload>;
	pickDirectory: (defaultPath?: string) => Promise<string | null>;
	getTheme: () => Promise<ThemePayload>;
	autodetectScenery: () => Promise<AutodetectResult>;
	abortAutodetect: () => Promise<{ success: boolean }>;
	onTasksUpdated: (listener: (tasks: Task[]) => void) => () => void;
	onThemeUpdated: (listener: (theme: ThemePayload) => void) => () => void;
	onAutodetectProgress: (listener: (progress: { status: string }) => void) => () => void;
};

declare global {
	interface Window {
		sconeApi?: SconeApi;
	}
}

const phaseLabel: Record<TaskPhase, string> = {
	queued: 'Queued',
	running: 'Running',
	cancelling: 'Cancelling',
	completed: 'Completed',
	failed: 'Failed',
	cancelled: 'Cancelled',
};

function applyTheme(theme: ThemePayload): void {
	const root = document.documentElement;
	root.dataset.theme = theme.isDark ? 'dark' : 'light';
	root.style.setProperty('--os-accent', theme.accentColor);
}

function formatTimestamp(value: number | null): string {
	if (!value) {
		return '';
	}
	return new Date(value).toLocaleString();
}

function normalizeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function App(): React.JSX.Element {
	const [tasks, setTasks] = useState<Task[]>([]);
	const [showAddTask, setShowAddTask] = useState(false);
	const [showSettings, setShowSettings] = useState(false);

	const [folderPath, setFolderPath] = useState('');
	const [taskName, setTaskName] = useState('');
	const [settings, setSettings] = useState<SettingsPayload>({ outputDir: '', fgPath: '', sceneryDirectories: [], maxRepairRetries: 3, maxTileRetries: 3 });
	const [outputDirectory, setOutputDirectory] = useState('');
	const [flightGearExecutablePath, setFlightGearExecutablePath] = useState('');
	const [sceneryDirectories, setSceneryDirectories] = useState<string[]>([]);
	const [newSceneryDirectory, setNewSceneryDirectory] = useState('');
	const [maxRepairRetriesInput, setMaxRepairRetriesInput] = useState('3');
	const [maxTileRetriesInput, setMaxTileRetriesInput] = useState('3');
	const [errorText, setErrorText] = useState<string | null>(null);
	const [infoText, setInfoText] = useState<string | null>(null);
	const [isSavingSettings, setIsSavingSettings] = useState(false);
	const [isAddingTask, setIsAddingTask] = useState(false);
	const [isAutodetecting, setIsAutodetecting] = useState(false);
	const [autodetectStatus, setAutodetectStatus] = useState('');

	useEffect(() => {
		const api = window.sconeApi;
		if (!api) {
			setErrorText('Renderer bridge is unavailable. Restart the app to reinitialize preload.');
			return;
		}

		let disposed = false;

		const initialize = async () => {
			try {
				const [loadedTasks, loadedSettings, theme] = await Promise.all([
					api.getTasks(),
					api.getSettings(),
					api.getTheme(),
				]);

				if (disposed) {
					return;
				}

				setTasks(loadedTasks);
				setSettings(loadedSettings);
				setOutputDirectory(loadedSettings.outputDir);
				setFlightGearExecutablePath(loadedSettings.fgPath);
				setSceneryDirectories(loadedSettings.sceneryDirectories);
				setMaxRepairRetriesInput(String(loadedSettings.maxRepairRetries));
				setMaxTileRetriesInput(String(loadedSettings.maxTileRetries));
				applyTheme(theme);
			} catch (error) {
				if (!disposed) {
					setErrorText(normalizeError(error));
				}
			}
		};

		void initialize();

		const unsubscribeTasks = api.onTasksUpdated((updatedTasks) => {
			if (!disposed) {
				setTasks(updatedTasks);
			}
		});

		const unsubscribeTheme = api.onThemeUpdated((theme) => {
			if (!disposed) {
				applyTheme(theme);
			}
		});

		const unsubscribeAutodetect = api.onAutodetectProgress((progress) => {
			if (!disposed && progress?.status) {
				setAutodetectStatus(progress.status);
			}
		});

		return () => {
			disposed = true;
			unsubscribeTasks();
			unsubscribeTheme();
			unsubscribeAutodetect();
		};
	}, []);

	const hasTasks = tasks.length > 0;
	const runningCount = useMemo(() => tasks.filter((task) => task.isRunning).length, [tasks]);
	const queuedCount = useMemo(() => tasks.filter((task) => task.phase === 'queued').length, [tasks]);

	const browseForDirectory = async (applyPath: (selectedPath: string) => void, defaultPath?: string) => {
		const api = window.sconeApi;
		if (!api) {
			setErrorText('Renderer bridge is unavailable.');
			return;
		}

		try {
			const selected = await api.pickDirectory(defaultPath);
			if (selected) {
				applyPath(selected);
			}
		} catch (error) {
			setErrorText(normalizeError(error));
		}
	};

	const handleAddTask = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const api = window.sconeApi;
		if (!api) {
			setErrorText('Renderer bridge is unavailable.');
			return;
		}

		setErrorText(null);
		setInfoText(null);

		const taskPath = folderPath.trim();
		if (!taskPath) {
			setErrorText('Scenery folder path is required.');
			return;
		}

		setIsAddingTask(true);
		try {
			await api.addTask({
				taskPath,
				taskName: taskName.trim() || undefined
			});

			setShowAddTask(false);
			setFolderPath('');
			setTaskName('');
			setInfoText('Task added to conversion queue.');
		} catch (error) {
			setErrorText(normalizeError(error));
		} finally {
			setIsAddingTask(false);
		}
	};

	const handleSaveSettings = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const api = window.sconeApi;
		if (!api) {
			setErrorText('Renderer bridge is unavailable.');
			return;
		}

		setErrorText(null);
		setInfoText(null);

		const trimmed = outputDirectory.trim();
		if (!trimmed) {
			setErrorText('Output directory is required.');
			return;
		}

		const retriesRaw = maxRepairRetriesInput.trim();
		if (!/^\d+$/.test(retriesRaw)) {
			setErrorText('Maximum repair retries must be a non-negative whole number.');
			return;
		}

		const maxRepairRetries = Number.parseInt(retriesRaw, 10);
		if (!Number.isSafeInteger(maxRepairRetries) || maxRepairRetries < 0) {
			setErrorText('Maximum repair retries must be a non-negative whole number.');
			return;
		}

		const sceneryPaths = sceneryDirectories
			.map((directory) => directory.trim())
			.filter((directory) => directory.length > 0);

		setIsSavingSettings(true);
		try {
			const saved = await api.saveSettings({
				outputDir: trimmed,
				fgPath: flightGearExecutablePath.trim(),
				sceneryDirectories: sceneryPaths,
				maxRepairRetries,
				maxTileRetries: Number.parseInt(maxTileRetriesInput, 10),
			});
			setSettings(saved);
			setOutputDirectory(saved.outputDir);
			setFlightGearExecutablePath(saved.fgPath);
			setSceneryDirectories(saved.sceneryDirectories);
			setMaxRepairRetriesInput(String(saved.maxRepairRetries));
			setMaxTileRetriesInput(String(saved.maxTileRetries));
			setShowSettings(false);
			setInfoText('Settings saved.');
		} catch (error) {
			setErrorText(normalizeError(error));
		} finally {
			setIsSavingSettings(false);
		}
	};

	const handleAddSceneryDirectory = () => {
		const directory = newSceneryDirectory.trim();
		if (directory) {
			if (!sceneryDirectories.includes(directory)) {
				setSceneryDirectories((current) => [...current, directory]);
			}
			setNewSceneryDirectory('');
		}
	};

	const handleBrowseAddSceneryDirectory = async () => {
		const api = window.sconeApi;
		if (!api) {
			setErrorText('Renderer bridge is unavailable.');
			return;
		}

		try {
			const selected = await api.pickDirectory();
			if (selected) {
				if (!sceneryDirectories.includes(selected)) {
					setSceneryDirectories((current) => [...current, selected]);
				}
			}
		} catch (error) {
			setErrorText(normalizeError(error));
		}
	};

	const handleAutodetect = async () => {
		const api = window.sconeApi;
		if (!api) {
			setErrorText('Renderer bridge is unavailable.');
			return;
		}

		setIsAutodetecting(true);
		setAutodetectStatus('Starting FlightGear auto-detection...');
		setErrorText(null);
		setInfoText(null);

		try {
			const result = await api.autodetectScenery();
			if (result.aborted) {
				setInfoText('Auto-detection was aborted.');
				return;
			}

			let addedCount = 0;
			if (Array.isArray(result.sceneryDirectories)) {
				setSceneryDirectories((current) => {
					const updated = [...current];
					for (const detected of result.sceneryDirectories) {
						if (!updated.includes(detected)) {
							updated.push(detected);
							addedCount++;
						}
					}
					return updated;
				});
			}

			if (result.fgPath && !flightGearExecutablePath.trim()) {
				setFlightGearExecutablePath(result.fgPath);
			}

			if (result.sceneryDirectories && result.sceneryDirectories.length > 0) {
				setInfoText(`Auto-detect found ${result.sceneryDirectories.length} scenery director${result.sceneryDirectories.length === 1 ? 'y' : 'ies'}.`);
			} else {
				setInfoText('Auto-detect completed. No additional scenery directories found.');
			}
		} catch (error) {
			setErrorText(normalizeError(error));
		} finally {
			setIsAutodetecting(false);
			setAutodetectStatus('');
		}
	};

	const handleAbortAutodetect = async () => {
		const api = window.sconeApi;
		if (!api) {
			return;
		}

		setAutodetectStatus('Aborting detection...');
		try {
			await api.abortAutodetect();
		} catch (error) {
			setErrorText(normalizeError(error));
		}
	};

	const requestCancel = async (taskId: string, mode: CancelMode) => {
		const api = window.sconeApi;
		if (!api) {
			setErrorText('Renderer bridge is unavailable.');
			return;
		}

		setErrorText(null);
		try {
			await api.cancelTask(taskId, mode);
		} catch (error) {
			setErrorText(normalizeError(error));
		}
	};

	return (
		<main className="app-shell">
			<header className="topbar">
				<div className="brand-group">
					<div className="logo-tile" aria-hidden="true">
						<span>S</span>
					</div>
					<div>
						<h1>Scone</h1>
					</div>
				</div>

				<div className="topbar-actions">
					<button className="btn btn-secondary" type="button" onClick={() => setShowSettings(true)}>
						Settings
					</button>
					<button className="btn btn-primary" type="button" onClick={() => setShowAddTask(true)}>
						New Task
					</button>
				</div>
			</header>

			<section className="content-area">
				<div className="stats-grid">
					<article className="stat-card">
						<h2>{tasks.length}</h2>
						<p>Total Tasks</p>
					</article>
					<article className="stat-card">
						<h2>{runningCount}</h2>
						<p>Running</p>
					</article>
					<article className="stat-card">
						<h2>{queuedCount}</h2>
						<p>Queued</p>
					</article>
				</div>

				{errorText ? <p className="message error" role="alert">{errorText}</p> : null}
				{infoText ? <p className="message info">{infoText}</p> : null}

				{hasTasks ? (
					<div className="task-list">
						{tasks.map((task) => (
							<article className={`task-card phase-${task.phase}`} key={task.id}>
								<div className="task-title-row">
									<h3>{task.taskName}</h3>
									<span className={`phase-chip phase-${task.phase}`}>{phaseLabel[task.phase]}</span>
								</div>
								<p className="task-path" title={task.taskPath}>{task.taskPath}</p>
								<p className="task-meta">Output: {task.outputPath}</p>

								<div className="task-status-row">
									<span className={task.isRunning ? 'spinner is-active' : 'spinner'} aria-hidden="true" />
									<p>{task.status}</p>
								</div>
								{task.startedAt ? <p className="task-meta">Started: {formatTimestamp(task.startedAt)}</p> : null}
								{task.finishedAt ? <p className="task-meta">Finished: {formatTimestamp(task.finishedAt)}</p> : null}
								{task.error ? <p className="task-error">{task.error}</p> : null}

								{task.phase === 'running' || task.phase === 'cancelling' ? (
									<div className="actions-row">
										<button
											className="btn btn-secondary"
											type="button"
											onClick={() => requestCancel(task.id, 'save')}
											disabled={task.phase === 'cancelling'}
										>
											Cancel &amp; Save Progress
										</button>
										<button className="btn btn-danger" type="button" onClick={() => requestCancel(task.id, 'discard')}>
											Cancel Entirely
										</button>
									</div>
								) : null}
							</article>
						))}
					</div>
				) : (
					<div className="empty-state">
						<h3>No tasks yet</h3>
						<p>Add a scenery folder to start conversion.</p>
						<button className="btn btn-primary" type="button" onClick={() => setShowAddTask(true)}>
							Create First Task
						</button>
					</div>
				)}
			</section>

			{showAddTask ? (
				<div className="overlay" role="dialog" aria-modal="true" aria-label="Add Task">
					<form className="dialog" onSubmit={handleAddTask}>
						<h3>Convert New Scenery Folder</h3>

						<label className="field">
							<span>Scenery Folder Path</span>
							<div className="field-row">
								<input
									type="text"
									value={folderPath}
									onChange={(event) => setFolderPath(event.target.value)}
									placeholder="Enter folder path or browse..."
									required
								/>
								<button className="btn btn-secondary" type="button" onClick={() => browseForDirectory(setFolderPath, folderPath || settings.outputDir)}>
									Browse
								</button>
							</div>
						</label>

						<label className="field">
							<span>Task Name (Optional)</span>
							<input
								type="text"
								value={taskName}
								onChange={(event) => setTaskName(event.target.value)}
								placeholder="Auto-generated from path if empty"
							/>
						</label>

						<p className="muted">Output directory: {settings.outputDir || 'Not configured'} (edit in Settings)</p>

						<div className="dialog-actions">
							<button className="btn btn-secondary" type="button" onClick={() => setShowAddTask(false)}>
								Cancel
							</button>
							<button className="btn btn-primary" type="submit" disabled={isAddingTask}>
								Add Task
							</button>
						</div>
					</form>
				</div>
			) : null}

			{showSettings ? (
				<div className="overlay" role="dialog" aria-modal="true" aria-label="Settings">
					<form className="dialog" onSubmit={handleSaveSettings}>
						<h3>Settings</h3>

						<div className="field">
							<span>Output Directory</span>
							<div className="field-row">
								<input
									type="text"
									value={outputDirectory}
									onChange={(event) => setOutputDirectory(event.target.value)}
									placeholder="Select output folder..."
									required
								/>
								<button className="btn btn-secondary" type="button" onClick={() => browseForDirectory(setOutputDirectory, outputDirectory || settings.outputDir)}>
									Browse
								</button>
							</div>
						</div>

						<div className="field">
							<span>FlightGear Executable Path</span>
							<div className="field-row">
								<input
									type="text"
									value={flightGearExecutablePath}
									onChange={(event) => setFlightGearExecutablePath(event.target.value)}
									placeholder="Select FlightGear executable (fgfs)..."
								/>
								<button className="btn btn-secondary" type="button" onClick={() => browseForDirectory(setFlightGearExecutablePath, flightGearExecutablePath || settings.fgPath)}>
									Browse
								</button>
							</div>
						</div>

						<div className="field">
							<span>Local Scenery Paths</span>
							<p className="muted">Priority is ordered top-to-bottom (first path has the highest priority).</p>
							
							{sceneryDirectories.length > 0 ? (
								<div className="ordered-list">
									{sceneryDirectories.map((directory, index) => (
										<div className="ordered-list-item" key={`${index}-${directory}`}>
											<input
												type="text"
												value={directory}
												onChange={(event) => setSceneryDirectories((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}
												aria-label={`Scenery path ${index + 1}`}
											/>
											<div className="item-actions">
												<button
													className="btn btn-secondary"
													type="button"
													onClick={() => setSceneryDirectories((current) => index > 0 ? current.map((item, itemIndex) => itemIndex === index - 1 ? current[index] : itemIndex === index ? current[index - 1] : item) : current)}
													disabled={index === 0}
													aria-label="Move path up"
													title="Move up (increase priority)"
												>
													▲
												</button>
												<button
													className="btn btn-secondary"
													type="button"
													onClick={() => setSceneryDirectories((current) => index < current.length - 1 ? current.map((item, itemIndex) => itemIndex === index ? current[index + 1] : itemIndex === index + 1 ? current[index] : item) : current)}
													disabled={index === sceneryDirectories.length - 1}
													aria-label="Move path down"
													title="Move down (decrease priority)"
												>
													▼
												</button>
												<button
													className="btn btn-danger"
													type="button"
													onClick={() => setSceneryDirectories((current) => current.filter((_, itemIndex) => itemIndex !== index))}
													aria-label="Remove path"
													title="Remove path"
												>
													Remove
												</button>
											</div>
										</div>
									))}
								</div>
							) : null}

							<div className="add-scenery-row">
								<input
									type="text"
									value={newSceneryDirectory}
									onChange={(event) => setNewSceneryDirectory(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === 'Enter') {
											event.preventDefault();
											handleAddSceneryDirectory();
										}
									}}
									placeholder="Add a local scenery path..."
								/>
								<button className="btn btn-secondary" type="button" onClick={handleBrowseAddSceneryDirectory}>
									Browse...
								</button>
								<button className="btn btn-secondary" type="button" onClick={handleAddSceneryDirectory}>
									Add
								</button>
							</div>

							<div className="autodetect-row">
								<button
									className="btn btn-secondary"
									type="button"
									onClick={handleAutodetect}
									disabled={isAutodetecting}
								>
									Auto-Detect Scenery &amp; FlightGear Paths
								</button>
							</div>
						</div>

						<label className="field">
							<span>Maximum Repair Retries</span>
							<input
								type="number"
								min={0}
								step={1}
								value={maxRepairRetriesInput}
								onChange={(event) => setMaxRepairRetriesInput(event.target.value)}
								required
							/>
						</label>

						<label className="field">
							<span>Maximum Tile Download Retries</span>
							<input
								type="number"
								min={0}
								step={1}
								value={maxTileRetriesInput}
								onChange={(event) => setMaxTileRetriesInput(event.target.value)}
								required
							/>
						</label>

						<p className="muted">Validator path is initialized automatically at launch.</p>

						<div className="dialog-actions">
							<button className="btn btn-secondary" type="button" onClick={() => setShowSettings(false)}>
								Cancel
							</button>
							<button className="btn btn-primary" type="submit" disabled={isSavingSettings}>
								Save
							</button>
						</div>
					</form>
				</div>
			) : null}

			{isAutodetecting ? (
				<div className="overlay" role="dialog" aria-modal="true" aria-label="Auto-detecting Scenery">
					<div className="dialog autodetect-dialog">
						<h3>Auto-detecting FlightGear &amp; Scenery</h3>
						<div className="autodetect-status">
							<span className="spinner is-active" aria-hidden="true" />
							<p>{autodetectStatus || 'Scanning directories for FlightGear scenery...'}</p>
						</div>
						<p className="muted">This may take a minute while scanning configuration files and local disks.</p>
						<div className="dialog-actions">
							<button
								className="btn btn-danger"
								type="button"
								onClick={handleAbortAutodetect}
							>
								Abort Detection
							</button>
						</div>
					</div>
				</div>
			) : null}
		</main>
	);
}

const container = document.getElementById('root');
if (!container) {
	throw new Error('Root element not found');
}

createRoot(container).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>
);
