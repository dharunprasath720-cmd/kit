'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INBOUND = ['state', 'key', 'stretch', 'config', 'say', 'timer-start', 'timer-end'];
const OUTBOUND = ['ready', 'drag-start', 'drag-end', 'stretch-done', 'show-menu'];

contextBridge.exposeInMainWorld('catAPI', {
  on(channel, fn) {
    if (INBOUND.includes(channel)) ipcRenderer.on(channel, (_event, data) => fn(data || {}));
  },
  send(channel) {
    if (OUTBOUND.includes(channel)) ipcRenderer.send(channel);
  }
});
