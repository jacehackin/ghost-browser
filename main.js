// main.js
'use strict';

require('./src/flags');

const { app, BrowserWindow } = require('electron');
const { bootstrap } = require('./src/app');

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(bootstrap);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) bootstrap();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});