const { contextBridge, ipcRenderer, clipboard } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    isElectron: true,

    minimize:        () => ipcRenderer.send("window-minimize"),
    maximize:        () => ipcRenderer.send("window-maximize"),
    close:           () => ipcRenderer.send("window-close"),
    navigateBack:    () => ipcRenderer.send("navigate-back"),
    navigateForward: () => ipcRenderer.send("navigate-forward"),

    onMaximizeChange: (cb) => ipcRenderer.on("maximize-change", (_event, val) => cb(val)),

    getDesktopSources: () => ipcRenderer.invoke("get-desktop-sources"),
    writeText: (text) => ipcRenderer.send("clipboard-write", text),

    writeLog: (type, message, detail = null) => ipcRenderer.send("foxvox:log", { type, message, detail }),
    logPath: () => ipcRenderer.invoke("foxvox:logPath"),
});