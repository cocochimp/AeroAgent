const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aeroAgentDesktop', {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
});
