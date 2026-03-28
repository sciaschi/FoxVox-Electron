const path = require("path");

function registerNativeCapture(targetWindow) {
    let addon = null;
    let sharedBuffer = null;
    let headerInfo = null;

    try {
        const addonPath = path.join(__dirname, "build", "Release", "native_capture.node");
        console.log("[NativeCapture] Loading addon from:", addonPath);

        addon = require(addonPath);
        headerInfo = addon.FrameHeader;

        console.log("[NativeCapture] Addon loaded");
        console.log("[NativeCapture] Build tag:", addon.buildTag ?? "unknown");
    } catch (err) {
        console.warn("[NativeCapture] Addon not available:", err.message);
        console.warn("[NativeCapture] Run: cd native-capture && npm run build");
    }

    targetWindow.nativeCapture = {
        isAvailable: () => !!addon,

        initBuffer: (width = 1920, height = 1080) => {
            if (!addon)
                return null;

            try {
                const safeWidth = Number(width);
                const safeHeight = Number(height);

                if (!Number.isFinite(safeWidth) || !Number.isFinite(safeHeight))
                    throw new Error("Invalid capture dimensions");

                const size = Number(addon.requiredBufferSize(safeWidth, safeHeight));
                sharedBuffer = new SharedArrayBuffer(size);

                const view = new Uint8Array(sharedBuffer);
                addon.attachBuffer(view);

                return {
                    buffer: sharedBuffer,
                    headerSize: Number(headerInfo?.HEADER_SIZE ?? 0),
                    offsets: headerInfo ? { ...headerInfo } : null,
                };
            } catch (err) {
                console.error("[NativeCapture] initBuffer failed:", err);
                sharedBuffer = null;
                return null;
            }
        },

        startCapture: (opts = {}) => {
            if (!addon || !sharedBuffer)
                return false;

            try {
                const forwarded = {
                    fps: Number(opts?.fps ?? 30),
                    adapterIndex: Number(opts?.adapterIndex ?? 0),
                    outputIndex: Number(opts?.outputIndex ?? 0),
                    targetWidth: Number(opts?.targetWidth ?? 1920),
                    targetHeight: Number(opts?.targetHeight ?? 1080),
                };

                console.log("[NativeCapture] startCapture forwarded opts:", forwarded);

                return !!addon.startCapture(forwarded);
            } catch (err) {
                console.error("[NativeCapture] Start failed:", err);
                return false;
            }
        },

        stopCapture: () => {
            if (!addon)
                return;

            try {
                addon.stopCapture();
            } catch (err) {
                console.error("[NativeCapture] Stop failed:", err);
            }
        },

        getInfo: () => {
            if (!addon)
                return { width: 0, height: 0, outputWidth: 0, outputHeight: 0, running: false };

            try {
                const info = addon.getInfo();
                return {
                    width: Number(info?.width ?? 0),
                    height: Number(info?.height ?? 0),
                    outputWidth: Number(info?.outputWidth ?? 0),
                    outputHeight: Number(info?.outputHeight ?? 0),
                    running: !!info?.running,
                    bufferSize: Number(info?.bufferSize ?? 0),
                    slotBytes: Number(info?.slotBytes ?? 0),
                    lastHr: Number(info?.lastHr ?? 0),
                    lastAcquireMs: Number(info?.lastAcquireMs ?? 0),
                    lastMapMs: Number(info?.lastMapMs ?? 0),
                };
            } catch (err) {
                console.error("[NativeCapture] getInfo failed:", err);
                return { width: 0, height: 0, outputWidth: 0, outputHeight: 0, running: false };
            }
        },
    };

    return targetWindow.nativeCapture;
}

module.exports = { registerNativeCapture };
