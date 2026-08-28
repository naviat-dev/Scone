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
	convertScenery('/home/israel-emmanuel/Documents/Aviation/scone-packs/neptune-ljbl_1.0.2_jdesn', '/home/israel-emmanuel/Documents/Scone/Output', true, false);
})

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit()
	}
})