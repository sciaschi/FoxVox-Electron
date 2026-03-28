const { ipcRenderer } = require("electron");
const { registerNativeCapture } = require("./native-capture/preload-capture");

registerNativeCapture(window);

window.electronAPI = {
    isElectron: true,

    minimize: () => ipcRenderer.send("window-minimize"),
    maximize: () => ipcRenderer.send("window-maximize"),
    close: () => ipcRenderer.send("window-close"),
    navigateBack: () => ipcRenderer.send("navigate-back"),
    navigateForward: () => ipcRenderer.send("navigate-forward"),
    clipboardWrite: (text) => ipcRenderer.send("clipboard-write", text),

    onMaximizeChange: (cb) => {
        ipcRenderer.on("maximize-change", (_event, value) => cb(value));
    },

    getDesktopSources: () => ipcRenderer.invoke("get-desktop-sources"),
};