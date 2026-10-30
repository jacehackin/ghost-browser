// src/flags.js
'use strict';

const { app } = require('electron');
const path = require('path');
const os = require('os');

// ── profile in a stable place so cache actually warms up ──
app.setPath('userData', path.join(os.homedir(), '.ghost-browser'));

// ── CORS + isolation off at the chromium layer ──
app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('disable-features',
  'OutOfBlinkCors,IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests,CrossOriginOpenerPolicy');
app.commandLine.appendSwitch('allow-running-insecure-content');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('ignore-urlfetcher-cert-requests');

// ── GPU + rendering acceleration ──
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('enable-native-gpu-memory-buffers');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-features',
  'VaapiVideoDecoder,VaapiVideoEncoder,CanvasOopRasterization,BackForwardCache,ParallelDownloading,UseEcoQoSForBackgroundProcess');

// ── network + cache tuning ──
app.commandLine.appendSwitch('enable-quic');
app.commandLine.appendSwitch('disk-cache-size', String(1024 * 1024 * 1024));       // 1 GB
app.commandLine.appendSwitch('media-cache-size', String(512 * 1024 * 1024));       // 512 MB
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess');

// ── V8 tuning for snappy JS ──
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096 --max-semi-space-size=64');
app.commandLine.appendSwitch('v8-cache-options', 'code');
app.commandLine.appendSwitch('v8-cache-strategies-for-cache-storage', 'normal');

// ── smooth input ──
app.commandLine.appendSwitch('enable-smooth-scrolling');
app.commandLine.appendSwitch('enable-threaded-scrolling');

// ── many tabs won't thrash ──
app.commandLine.appendSwitch('renderer-process-limit', '0');