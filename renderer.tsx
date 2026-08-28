import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

type Task = {
	id: string;
	taskName: string;
	taskPath: string;
	status: string;
	isRunning: boolean;
};

type OutputFormat = 'gltf' | 'ac3d';

const initialTasks: Task[] = [
	{
		id: 'task-1',
		taskName: 'KSEA Airport Conversion',
		taskPath: '/home/user/scenery/KSEA',
		status: 'Converting terminal meshes and extracting textures...',
		isRunning: true
	},
	{
		id: 'task-2',
		taskName: 'EGLL Photogrammetry',
		taskPath: '/home/user/scenery/EGLL',
		status: 'Queued',
		isRunning: false
	}
];

function App(): React.JSX.Element {
	const [tasks] = useState<Task[]>(initialTasks);
	const [showAddTask, setShowAddTask] = useState(false);
	const [showSettings, setShowSettings] = useState(false);

	const [folderPath, setFolderPath] = useState('');
	const [taskName, setTaskName] = useState('');
	const [outputFormat, setOutputFormat] = useState<OutputFormat>('gltf');
	const [outputDirectory, setOutputDirectory] = useState('');

	const hasTasks = tasks.length > 0;
	const runningCount = useMemo(() => tasks.filter((task) => task.isRunning).length, [tasks]);

	return (
		<main className="app-shell">
			<header className="navbar">
				<div className="brand-group">
					<div className="logo-tile" aria-hidden="true">
						<span>S</span>
					</div>
					<div>
						<h1>Scone</h1>
						<p className="muted">Scenery conversion workspace</p>
					</div>
				</div>

				<button className="btn btn-secondary" type="button" onClick={() => setShowSettings(true)}>
					Settings
				</button>
			</header>

			<section className="content-area">
				<div className="content-header">
					<h2>Download Tasks</h2>
					<p className="muted">{runningCount} running</p>
				</div>

				{hasTasks ? (
					<div className="task-list">
						{tasks.map((task) => (
							<article className="task-card" key={task.id}>
								<h3>{task.taskName}</h3>
								<p className="task-path" title={task.taskPath}>{task.taskPath}</p>

								<div className="task-status-row">
									<span className={task.isRunning ? 'spinner is-active' : 'spinner'} aria-hidden="true" />
									<p>{task.status}</p>
								</div>

								{task.isRunning ? (
									<div className="actions-row">
										<button className="btn btn-secondary" type="button">Cancel &amp; Save Progress</button>
										<button className="btn btn-danger" type="button">Cancel Entirely</button>
									</div>
								) : null}
							</article>
						))}
					</div>
				) : (
					<div className="empty-state">
						<h3>No active tasks</h3>
						<p>Click the + button to add a new task</p>
					</div>
				)}

				<button className="fab" type="button" aria-label="Add task" onClick={() => setShowAddTask(true)}>
					+
				</button>
			</section>

			{showAddTask ? (
				<div className="overlay" role="dialog" aria-modal="true" aria-label="Add Task">
					<section className="dialog">
						<h3>Convert New Scenery Folder</h3>

						<label className="field">
							<span>Scenery Folder Path</span>
							<div className="field-row">
								<input
									type="text"
									value={folderPath}
									onChange={(event) => setFolderPath(event.target.value)}
									placeholder="Enter folder path or browse..."
								/>
								<button className="btn btn-secondary" type="button">Browse</button>
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

						<fieldset className="field format-options">
							<legend>Output Format</legend>
							<label>
								<input
									type="radio"
									name="format"
									checked={outputFormat === 'gltf'}
									onChange={() => setOutputFormat('gltf')}
								/>
								glTF
							</label>
							<label>
								<input
									type="radio"
									name="format"
									checked={outputFormat === 'ac3d'}
									onChange={() => setOutputFormat('ac3d')}
								/>
								AC3D
							</label>
						</fieldset>

						<div className="dialog-actions">
							<button className="btn btn-secondary" type="button" onClick={() => setShowAddTask(false)}>
								Cancel
							</button>
							<button className="btn btn-primary" type="button" onClick={() => setShowAddTask(false)}>
								Add Task
							</button>
						</div>
					</section>
				</div>
			) : null}

			{showSettings ? (
				<div className="overlay" role="dialog" aria-modal="true" aria-label="Settings">
					<section className="dialog">
						<h3>Settings</h3>

						<label className="field">
							<span>Output Directory</span>
							<div className="field-row">
								<input
									type="text"
									value={outputDirectory}
									onChange={(event) => setOutputDirectory(event.target.value)}
									placeholder="Select output folder..."
								/>
								<button className="btn btn-secondary" type="button">Browse</button>
							</div>
						</label>

						<div className="dialog-actions">
							<button className="btn btn-secondary" type="button" onClick={() => setShowSettings(false)}>
								Cancel
							</button>
							<button className="btn btn-primary" type="button" onClick={() => setShowSettings(false)}>
								Save
							</button>
						</div>
					</section>
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
