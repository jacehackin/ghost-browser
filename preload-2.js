// log
logAll: () => ipcRenderer.invoke('log:all'),
logClear: () => ipcRenderer.invoke('log:clear'),
logStats: () => ipcRenderer.invoke('log:stats'),
onLogEntry: (cb) => ipcRenderer.on('log:entry', (_e, rec) => cb(rec)),

// rules
rulesList: () => ipcRenderer.invoke('rules:list'),
rulesAdd: (rule) => ipcRenderer.invoke('rules:add', rule),
rulesUpdate: (id, patch) => ipcRenderer.invoke('rules:update', id, patch),
rulesRemove: (id) => ipcRenderer.invoke('rules:remove', id),
rulesSetEnabled: (id, enabled) => ipcRenderer.invoke('rules:setEnabled', id, enabled),
rulesReset: () => ipcRenderer.invoke('rules:reset'),

// cache
clearCache: () => ipcRenderer.invoke('clear-session')