// main.js
const { app, BrowserWindow, session, ipcMain, shell } = require('electron');
const path = require('path');
const { startProxy, stopProxy, getProxyUrl } = require('./proxy');

// ── Chromium-level bypass: kill same-origin policy before app boots ──
app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors,IsolateOrigins,site-per-process');
app.commandLine.appendSwitch('allow-running-insecure-content');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('ignore-urlfetcher-cert-requests');
app.commandLine.appendSwitch('disable-features', 'BlockInsecurePrivateNetworkRequests');
app.commandLine.appendSwitch('user-data-dir', path.join(__dirname, '.chrome-profile'));

const PROXY_PORT = 8899;
let mainWindow = null;

function buildHeaderRewriter() {
  return (details, callback) => {
    const headers = Object.assign({}, details.responseHeaders);

    // lower-case lookup map for deletions
    const lower = {};
    Object.keys(headers).forEach((k) => { lower[k.toLowerCase()] = k; });

    const kill = [
      'content-security-policy',
      'content-security-policy-report-only',
      'x-content-security-policy',
      'x-webkit-csp',
      'x-frame-options',
      'access-control-allow-origin',
      'access-control-allow-methods',
      'access-control-allow-headers',
      'access-control-allow-credentials',
      'access-control-expose-headers',
      'access-control-max-age',
      'cross-origin-opener-policy',
      'cross-origin-embedder-policy',
      'cross-origin-resource-policy',
      'strict-transport-security',
      'feature-policy',
      'permissions-policy'
    ];

    kill.forEach((name) => {
      if (lower[name]) delete headers[lower[name]];
    });

    // Inject permissive everything
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD'];
    headers['Access-Control-Allow-Headers'] = ['*'];
    headers['Access-Control-Expose-Headers'] = ['*'];
    headers['Access-Control-Max-Age'] = ['86400'];
    // Note: no Allow-Credentials with wildcard origin — that combo is rejected by spec.
    // For cookie-bearing requests we fall back to reflecting origin below.
    if (details.responseHeaders && (lower['set-cookie'] || lower['set-cookie2'])) {
      headers['Access-Control-Allow-Origin'] = ['*'];
      delete headers['Access-Control-Allow-Credentials'];
    }

    callback({ responseHeaders: headers });
  };
}

function configureSession() {
  const ses = session.defaultSession;

  ses.webRequest.onHeadersReceived(buildHeaderRewriter());

  // Auto-fill CORS headers on preflight-ish requests
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = Object.assign({}, details.requestHeaders);
    headers['Origin'] = headers['Origin'] || 'https://localhost';
    headers['User-Agent'] = headers['User-Agent'] ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    callback({ requestHeaders: headers });
  });

  // Grant every permission silently
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(true));
  ses.setPermissionCheckHandler(() => true);

  // Wipe any client cert prompts
  ses.setCertificateVerifyProc((request, callback) => callback(0));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      mainWindow.webContents.send('open-new-tab', url);
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  configureSession();
  startProxy(PROXY_PORT);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopProxy();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => stopProxy());

// ── IPC surface ──
ipcMain.handle('get-proxy-url', () => getProxyUrl());
ipcMain.handle('get-proxy-port', () => PROXY_PORT);
ipcMain.handle('clear-session', async () => {
  await session.defaultSession.clearCache();
  await session.defaultSession.clearStorageData();
  return true;
});