const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('dragon', Object.freeze({
  getState: () => ipcRenderer.invoke('state'),
  refresh: () => ipcRenderer.invoke('refresh'),
  settings: () => ipcRenderer.send('settings'),
  saveSettings: (value) => ipcRenderer.invoke('save-settings', value),
  beginMove: () => ipcRenderer.send('begin-move'),
  move: () => ipcRenderer.send('move'),
  endMove: () => ipcRenderer.send('end-move'),
  setHitRegion: (value) => ipcRenderer.send('hit-region', value),
  action: (value) => ipcRenderer.send('action', value),
  onState: (callback) => { const listener = (_, value) => callback(value); ipcRenderer.on('state', listener); return () => ipcRenderer.removeListener('state', listener); },
  onNotice: (callback) => { const listener = (_, value) => callback(value); ipcRenderer.on('notice', listener); return () => ipcRenderer.removeListener('notice', listener); }
}));
