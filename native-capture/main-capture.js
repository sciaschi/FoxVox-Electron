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
        const result = addon.initBuffer(opts.width, opts.height);

        return {
            ok: true,
            width: result.width,
            height: result.height,
            headerSize: result.headerSize,
            offsets: {
                OFFSET_DIRTY: result.offsets.OFFSET_DIRTY,
                OFFSET_FRAME_IDX: result.offsets.OFFSET_FRAME_IDX,
                OFFSET_WIDTH: result.offsets.OFFSET_WIDTH,
                OFFSET_HEIGHT: result.offsets.OFFSET_HEIGHT,
                OFFSET_TIMESTAMP: result.offsets.OFFSET_TIMESTAMP,
            },
        };
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