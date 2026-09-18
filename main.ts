import { app, BrowserWindow } from 'electron';

function createWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 1180,
		height: 820,
		minWidth: 920,
		minHeight: 640,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	void win.loadFile('index.html');
	return win;
}

app.whenReady().then(() => {
	createWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on('window-all-closed', async () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});