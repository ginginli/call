const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  quit: () => ipcRenderer.send('quit'),
  retry: () => ipcRenderer.send('retry'),
  reload: () => ipcRenderer.send('reload'),
  getServer: () => ipcRenderer.invoke('get-server'),
  saveServer: (url) => ipcRenderer.invoke('save-server', url),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enable) => ipcRenderer.invoke('set-auto-launch', enable),
  minimize: () => ipcRenderer.send('window-minimize'),
  pulse: () => ipcRenderer.send('window-pulse'),
});
