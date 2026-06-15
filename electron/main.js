import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
if (isDev) app.commandLine.appendSwitch('remote-debugging-port', '9222');

// macOS 27's sandbox profile is newer than Electron 33's bundled Chromium,
// so sandbox init fails and crashes the renderer. Safe to disable for a
// local-only game that never loads remote content. Remove after upgrading Electron.
app.commandLine.appendSwitch('no-sandbox');

function createWindow() {
  const win = new BrowserWindow({
    width: 1300,
    height: 820,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: '#0b1622',
    title: 'Air Bucks',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
