import { contextBridge, ipcRenderer } from 'electron';

const electronAPI = {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  getStatus: () => ipcRenderer.invoke('app:status'),
  openBoard: () => ipcRenderer.invoke('app:open-board'),
  serviceCommand: (command) => ipcRenderer.invoke('app:service-command', command),
  setAppAutostart: (enabled) => ipcRenderer.invoke('app:set-app-autostart', enabled),
  setServiceAutostart: (enabled) => ipcRenderer.invoke('app:set-service-autostart', enabled),
  checkForUpdates: () => ipcRenderer.invoke('app:check-update'),
  quit: () => ipcRenderer.invoke('app:quit'),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
