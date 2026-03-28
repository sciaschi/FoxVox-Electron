// native-capture/main-capture.js
// Runs in the MAIN process. Loads the addon, creates SharedArrayBuffer,
// shares it to renderer via one-time IPC.

const path = require("path");

let addon = null;
let sharedBuffer = null;
let headerInfo = null;

try {
    addon = require(path.join(__dirname, "build", "Release", "native_capture.node"));
    headerInfo = addon.FrameHeader;
} catch (err) {
    console.warn("[NativeCapture] Addon not available:", err.message);
}

function register(ipcMain) {
    if (!addon) {
        console.warn("[NativeCapture] Skipping IPC registration — addon not loaded");
        return;
    }

    // Renderer calls this once to get the SharedArrayBuffer + header layout
    ipcMain.handle("native-capture:init", async (_event, opts) => {
        try {
            const width = opts.width || 1920;
            const height = opts.height || 1080;
            const size = Number(addon.requiredBufferSize(width, height));
            
            sharedBuffer = new SharedArrayBuffer(size);
            const view = new Uint8Array(sharedBuffer);
            addon.attachBuffer(view);

            return {
                ok: true,
                buffer: sharedBuffer,
                width,
                height,
                headerSize: headerInfo.HEADER_SIZE,
                offsets: { ...headerInfo },
            };
        } catch (err) {
            console.error("[NativeCapture] init failed:", err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle("native-capture:start", (_event, opts = {}) => {
        if (!sharedBuffer) return false;

        try {
            return addon.startCapture(opts);
        } catch (err) {
            console.error("[NativeCapture] Start failed:", err);
            return false;
        }
    });

    ipcMain.handle("native-capture:stop", () => {
        try {
            addon.stopCapture();
            return true;
        } catch (err) {
            console.error("[NativeCapture] Stop failed:", err);
            return false;
        }
    });

    ipcMain.handle("native-capture:info", () => {
        try {
            return addon.getInfo();
        } catch {
            return { width: 0, height: 0, running: false };
        }
    });
}

module.exports = { register };