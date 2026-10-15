'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  reset: () => ipcRenderer.invoke('settings:reset'),
  action: (name) => ipcRenderer.invoke('settings:action', name),
  timerStart: (label, minutes) => ipcRenderer.invoke('timer:start', label, minutes),
  timerCancel: (id) => ipcRenderer.invoke('timer:cancel', id),
  onChange: (fn) => ipcRenderer.on('settings:changed', (_e, state) => fn(state))
});
