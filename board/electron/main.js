import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceController } from './service-controller.mjs';
import { deriveBoardState } from './health-monitor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const IS_DEV = !app.isPackaged && process.env.VITE_DEV === '1';
const HOST = process.env.HANDOFF_BOARD_HOST || '127.0.0.1';
const PORT = Number(process.env.HANDOFF_BOARD_PORT || 4319);
const BOARD_URL = `http://${HOST}:${PORT}`;
const UPDATE_URL = process.env.HANDOFF_BOARD_UPDATE_URL || '';

let tray = null;
let mainWindow = null;
let controller = null;
let status = { state: 'stopped', detail: 'Board service is not installed' };
let serviceStatus = { installed: false, running: false, supported: true };
let serviceAutostart = true;
let appAutostart = false;
let busy = false;
let updater = null;
let updaterState = 'disabled';
let refreshTimer = null;

function boardVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveNodeBinary() {
  const candidates = [
    process.env.SYSTEM_NODE,
    process.env.HOME ? join(process.env.HOME, '.local', 'bin', 'node') : null,
    process.platform === 'win32' ? join(process.env.ProgramFiles || '', 'nodejs', 'node.exe') : null,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    'node',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const version = execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 2000 }).trim();
      const [, major, minor] = version.match(/^v(\d+)\.(\d+)/) || [];
      if (Number(major) > 22 || (Number(major) === 22 && Number(minor) >= 5)) return candidate;
    } catch {
      // Continue searching the platform-specific locations.
    }
  }
  throw new Error('Node.js >= 22.5 is required to run the handoff-board service.');
}

function serverEntry() {
  if (IS_DEV) return join(ROOT, 'electron', 'server.mjs');
  return app.isPackaged
    ? join(process.resourcesPath, 'server', 'handoff-board-server.mjs')
    : join(ROOT, 'electron', 'server.mjs');
}

function distDirectory() {
  return app.isPackaged ? join(process.resourcesPath, 'dist') : join(ROOT, 'dist');
}

function trayIconPath() {
  return app.isPackaged
    ? join(process.resourcesPath, 'tray', 'tray-icon.png')
    : join(ROOT, 'assets', 'tray-icon.png');
}

function trayIcon() {
  const image = nativeImage.createFromPath(trayIconPath());
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image;
}

async function healthCheck() {
  try {
    const response = await fetch(`${BOARD_URL}/api/ops/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function refreshStatus() {
  if (!controller) return;
  serviceStatus = await controller.status();
  const health = await healthCheck();
  status = deriveBoardState({ health, service: serviceStatus });
  updateTray();
}

function updateTray() {
  if (!tray) return;
  tray.setImage(trayIcon());
  tray.setToolTip(`Loop Engineering Board: ${status.detail}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Loop Engineering Board · ${status.detail}`, enabled: false },
    { label: `App ${app.getVersion()} · Board ${boardVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Board', click: openBoard },
    { label: 'Open in Browser', click: openInBrowser },
    { label: 'Start', enabled: !busy && status.state !== 'running' && status.state !== 'starting', click: () => runService('start') },
    { label: 'Stop', enabled: !busy && serviceStatus.running, click: () => runService('stop') },
    { label: 'Restart', enabled: !busy && serviceStatus.installed, click: () => runService('restart') },
    { type: 'separator' },
    { label: 'Start Board at Login', type: 'checkbox', checked: serviceAutostart, click: (item) => setServiceAutostart(item.checked) },
    { label: 'Start App at Login', type: 'checkbox', checked: appAutostart, click: (item) => setAppAutostart(item.checked) },
    { label: 'Open Logs', click: () => shell.openPath(controller.logPaths.stdout) },
    { label: 'Check for Updates', enabled: Boolean(updater), click: checkForUpdates },
    { label: updaterState === 'available' ? 'Download Update' : `Updates: ${updaterState}`, enabled: updaterState === 'available', click: downloadUpdate },
    { label: 'Install Update', enabled: updaterState === 'downloaded', click: () => updater?.quitAndInstall() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

async function runService(command) {
  if (busy || !controller) return;
  busy = true;
  status = { state: 'starting', detail: `${command}ing Board service…` };
  updateTray();
  try {
    await controller[command]();
    await refreshStatus();
  } catch (error) {
    status = { state: 'error', detail: error.message };
    updateTray();
    dialog.showErrorBox('Loop Engineering Board', error.message);
  } finally {
    busy = false;
    await refreshStatus();
  }
}

function openBoard() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 600,
    title: 'Loop Engineering Board',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(BOARD_URL)) { event.preventDefault(); shell.openExternal(url); }
  });
  mainWindow.loadURL(BOARD_URL);
  mainWindow.on('closed', () => { mainWindow = null; });
}

function openInBrowser() {
  shell.openExternal(BOARD_URL);
}

function setAppAutostart(enabled) {
  if (process.platform === 'linux') {
    const file = join(app.getPath('appData'), 'autostart', 'com.agent-handoff.board.desktop');
    if (enabled) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Loop Engineering Board\nExec="${process.execPath}" --hidden\nX-GNOME-Autostart-enabled=true\n`, 'utf8');
    } else if (existsSync(file)) unlinkSync(file);
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
  }
  appAutostart = enabled;
  updateTray();
}

async function setServiceAutostart(enabled) {
  try {
    await controller.setAutostart(enabled);
    serviceAutostart = enabled;
    await refreshStatus();
  } catch (error) {
    dialog.showErrorBox('Loop Engineering Board', error.message);
  }
}

async function configureUpdater() {
  if (!app.isPackaged || !UPDATE_URL) return;
  try {
    const module = await import('electron-updater');
    updater = module.autoUpdater;
    updater.autoDownload = false;
    updater.setFeedURL({ provider: 'generic', url: UPDATE_URL });
    updater.on('checking-for-update', () => { updaterState = 'checking'; updateTray(); });
    updater.on('update-available', () => { updaterState = 'available'; updateTray(); });
    updater.on('update-not-available', () => { updaterState = 'current'; updateTray(); });
    updater.on('update-downloaded', () => { updaterState = 'downloaded'; updateTray(); });
    updater.on('error', (error) => { updaterState = `error: ${error.message}`; updateTray(); });
  } catch (error) {
    updaterState = `error: ${error.message}`;
  }
}

async function checkForUpdates() {
  if (!updater) return;
  await updater.checkForUpdates();
}

async function downloadUpdate() {
  if (!updater || updaterState !== 'available') return;
  updaterState = 'downloading';
  updateTray();
  try {
    await updater.downloadUpdate();
  } catch (error) {
    updaterState = `error: ${error.message}`;
    updateTray();
  }
}

ipcMain.handle('app:get-version', () => ({ app: app.getVersion(), board: boardVersion() }));
ipcMain.handle('app:status', () => ({ status, service: serviceStatus, serviceAutostart, appAutostart, updaterState }));
ipcMain.handle('app:open-board', openBoard);
ipcMain.handle('app:service-command', (_event, command) => {
  if (!['start', 'stop', 'restart'].includes(command)) throw new Error('Unsupported service command');
  return runService(command);
});
ipcMain.handle('app:set-app-autostart', (_event, enabled) => setAppAutostart(Boolean(enabled)));
ipcMain.handle('app:set-service-autostart', (_event, enabled) => setServiceAutostart(Boolean(enabled)));
ipcMain.handle('app:check-update', checkForUpdates);
ipcMain.handle('app:quit', () => app.quit());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.whenReady().then(async () => {
  try {
    const nodeBinary = resolveNodeBinary();
    controller = new ServiceController({ nodeBinary, serverEntry: serverEntry(), distDir: distDirectory(), host: HOST, port: PORT });
    serviceStatus = await controller.ensureInstalled({ autostart: serviceAutostart });
    appAutostart = process.platform === 'linux' ? existsSync(join(app.getPath('appData'), 'autostart', 'com.agent-handoff.board.desktop')) : app.getLoginItemSettings().openAtLogin;
    tray = new Tray(trayIcon());
    await configureUpdater();
    updateTray();
    await refreshStatus();
    refreshTimer = setInterval(refreshStatus, 5000);
    if (process.platform === 'darwin') app.dock?.hide();
  } catch (error) {
    dialog.showErrorBox('Loop Engineering Board', error.message);
    app.quit();
  }
});

app.on('second-instance', openBoard);
app.on('window-all-closed', () => {
  // This is a tray app on every supported platform. Closing the Board window
  // must not terminate the controller or remove its tray icon.
});
app.on('before-quit', () => { if (refreshTimer) clearInterval(refreshTimer); tray?.destroy(); });
