import { app, BrowserWindow } from 'electron/main';
import { config, loadConfig, saveConfig } from './config.js';
import { convertScenery } from './converter.js';

const createWindow = () => {
	const win = new BrowserWindow({
		width: 800,
		height: 600	
	})

	win.loadFile('index.html')
}

app.whenReady().then(async () => {
	await loadConfig();
	createWindow()

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow()
		}
	})
})

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit()
	}
})