const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  quit: () => ipcRenderer.send('quit'),
  retry: () => ipcRenderer.send('retry'),
  reload: () => ipcRenderer.send('reload'),
});
