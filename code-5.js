// body rules
bodyList: () => ipcRenderer.invoke('body:list'),
bodyAdd: (r) => ipcRenderer.invoke('body:add', r),
bodyUpdate: (id, p) => ipcRenderer.invoke('body:update', id, p),
bodyRemove: (id) => ipcRenderer.invoke('body:remove', id),
bodySetEnabled: (id, on) => ipcRenderer.invoke('body:setEnabled', id, on),
bodyReset: () => ipcRenderer.invoke('body:reset'),

// HAR
harExport: (meta) => ipcRenderer.invoke('har:export', meta),

// proxy
proxyGet: () => ipcRenderer.invoke('proxy:get'),
proxySetGlobal: (v) => ipcRenderer.invoke('proxy:setGlobal', v),
proxySetTab: (id, v) => ipcRenderer.invoke('proxy:setTab', id, v)