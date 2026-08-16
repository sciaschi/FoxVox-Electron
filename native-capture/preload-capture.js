const path = require("path");

function registerNativeCapture(targetWindow) {
    let addon = null;
    let sharedBuffer = null;
    let headerInfo = null;
    let allocatedWidth = 0;
    let allocatedHeight = 0;

    try {
        const addonPath = path.join(__dirname, "build", "Release", "native_capture.node");

        addon = require(addonPath);
        headerInfo = addon.FrameHeader;
    } catch (err) {
        console.warn("[NativeCapture] Addon not available:", err.message);
        console.warn("[NativeCapture] Run: cd native-capture && npm run build");
    }

    function allocateBuffer(width, height) {
        if (!addon)
            return null;

        const safeWidth = Number(width);
        const safeHeight = Number(height);

        if (!Number.isFinite(safeWidth) || !Number.isFinite(safeHeight) || safeWidth <= 0 || safeHeight <= 0)
            throw new Error(`Invalid capture dimensions: ${width}x${height}`);

        if (typeof addon.getInfo === "function" && addon.getInfo()?.running) {
            try {
                addon.stopCapture();
            } catch (err) {
                console.error("[NativeCapture] stopCapture before buffer swap failed:", err);
            }
        }

        const size = Number(addon.requiredBufferSize(safeWidth, safeHeight));
        sharedBuffer = new SharedArrayBuffer(size);

        const view = new Uint8Array(sharedBuffer);
        addon.attachBuffer(view);

        allocatedWidth = safeWidth;
        allocatedHeight = safeHeight;

        return {
            buffer: sharedBuffer,
            headerSize: Number(headerInfo?.HEADER_SIZE ?? 0),
            offsets: headerInfo ? { ...headerInfo } : null,
        };
    }

    function resolveSourceSize(opts = {}) {
        const source = opts?.source ?? {};

        const width = Number(
            source?.nativeWidth ??
            source?.width ??
            source?.bounds?.width ??
            source?.contentBounds?.width ??
            0
        );

        const height = Number(
            source?.nativeHeight ??
            source?.height ??
            source?.bounds?.height ??
            source?.contentBounds?.height ??
            0
        );

        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
            return null;

        return { width, height };
    }

    function resolveCaptureSize(opts = {}) {
        const sourceSize = resolveSourceSize(opts);

        const width = Number(
            opts?.captureWidth ??
            opts?.targetWidth ??
            opts?.maxWidth ??
            sourceSize?.width ??
            allocatedWidth ??
            0
        );

        const height = Number(
            opts?.captureHeight ??
            opts?.targetHeight ??
            opts?.maxHeight ??
            sourceSize?.height ??
            allocatedHeight ??
            0
        );

        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            throw new Error(
                `Could not resolve capture size. ` +
                `captureWidth=${opts?.captureWidth}, captureHeight=${opts?.captureHeight}, ` +
                `target=${opts?.targetWidth ?? 0}x${opts?.targetHeight ?? 0}, ` +
                `max=${opts?.maxWidth ?? 0}x${opts?.maxHeight ?? 0}, ` +
                `sourceNative=${sourceSize?.width ?? 0}x${sourceSize?.height ?? 0}, ` +
                `allocated=${allocatedWidth}x${allocatedHeight}`
            );
        }

        return {
            width: Math.floor(width),
            height: Math.floor(height),
        };
    }

    function ensureBufferForCapture(opts = {}) {
        const { width, height } = resolveCaptureSize(opts);

        const needsNewBuffer =
            !sharedBuffer ||
            width !== allocatedWidth ||
            height !== allocatedHeight;

        if (!needsNewBuffer) {
            return {
                buffer: sharedBuffer,
                headerSize: Number(headerInfo?.HEADER_SIZE ?? 0),
                offsets: headerInfo ? { ...headerInfo } : null,
                width,
                height,
            };
        }

        const result = allocateBuffer(width, height);
        return {
            ...result,
            width,
            height,
        };
    }

    function startDisplayCaptureCompat(opts = {}) {
        if (!addon)
            return false;

        const ensured = ensureBufferForCapture(opts);

        const forwarded = {
            fps: Number(opts?.fps ?? 30),
            adapterIndex: Number(opts?.adapterIndex ?? 0),
            outputIndex: Number(opts?.outputIndex ?? 0),
            targetWidth: ensured.width,
            targetHeight: ensured.height,
        };

        console.log("[NativeCapture] startDisplayCapture forwarded:", forwarded);

        if (typeof addon.startDisplayCapture === "function")
            return !!addon.startDisplayCapture(forwarded);

        if (typeof addon.startCapture === "function")
            return !!addon.startCapture(forwarded);

        console.warn("[NativeCapture] No display start function exported by addon");
        return false;
    }

    function startWindowCaptureCompat(opts = {}) {
        if (!addon)
            return false;

        const ensured = ensureBufferForCapture(opts);

        const forwarded = {
            hwnd: Number(opts?.hwnd ?? 0),
            fps: Number(opts?.fps ?? 30),
            targetWidth: ensured.width,
            targetHeight: ensured.height,
        };

        console.log("[NativeCapture] startWindowCapture forwarded opts:", forwarded);

        if (typeof addon.startWindowCapture === "function")
            return !!addon.startWindowCapture(forwarded);

        console.warn("[NativeCapture] WGC window capture not exported by addon");
        return false;
    }

    targetWindow.nativeCapture = {
        isAvailable: () => !!addon,

        getCapabilities: () => {
            try {
                if (typeof addon?.getCapabilities === "function") {
                    const caps = addon.getCapabilities() ?? {};
                    return {
                        dxgiDisplay: !!caps.dxgiDisplay,
                        wgcWindow: !!caps.wgcWindow,
                    };
                }
            } catch (err) {
                console.warn("[NativeCapture] getCapabilities fallback due to error:", err);
            }

            return {
                dxgiDisplay:
                    !!addon?.startDisplayCapture ||
                    !!addon?.startCapture,
                wgcWindow: false,
            };
        },

        initBuffer: (width, height) => {
            if (!addon)
                return null;

            try {
                return allocateBuffer(width, height);
            } catch (err) {
                console.error("[NativeCapture] initBuffer failed:", err);
                sharedBuffer = null;
                allocatedWidth = 0;
                allocatedHeight = 0;
                return null;
            }
        },

        startCapture: (opts = {}) => {
            try {
                return startDisplayCaptureCompat(opts);
            } catch (err) {
                console.error("[NativeCapture] startCapture failed:", err);
                return false;
            }
        },

        startDisplayCapture: (opts = {}) => {
            try {
                return startDisplayCaptureCompat(opts);
            } catch (err) {
                console.error("[NativeCapture] startDisplayCapture failed:", err);
                return false;
            }
        },

        startWindowCapture: (opts = {}) => {
            try {
                return startWindowCaptureCompat(opts);
            } catch (err) {
                console.error("[NativeCapture] startWindowCapture failed:", err);
                return false;
            }
        },

        stopCapture: () => {
            if (!addon)
                return;

            try {
                addon.stopCapture();
            } catch (err) {
                console.error("[NativeCapture] stopCapture failed:", err);
            }
        },

        getInfo: () => {
            if (!addon)
                return {
                    width: 0,
                    height: 0,
                    outputWidth: 0,
                    outputHeight: 0,
                    running: false,
                    mode: "none",
                };

            try {
                const info = addon.getInfo();
                return {
                    width: Number(info?.width ?? 0),
                    height: Number(info?.height ?? 0),
                    outputWidth: Number(info?.outputWidth ?? 0),
                    outputHeight: Number(info?.outputHeight ?? 0),
                    running: !!info?.running,
                    mode: String(info?.mode ?? "unknown"),
                    bufferSize: Number(info?.bufferSize ?? 0),
                    slotBytes: Number(info?.slotBytes ?? 0),
                    lastHr: Number(info?.lastHr ?? 0),
                    lastAcquireMs: Number(info?.lastAcquireMs ?? 0),
                    lastMapMs: Number(info?.lastMapMs ?? 0),
                    targetHwnd: Number(info?.targetHwnd ?? 0),
                    allocatedWidth,
                    allocatedHeight,
                };
            } catch (err) {
                console.error("[NativeCapture] getInfo failed:", err);
                return {
                    width: 0,
                    height: 0,
                    outputWidth: 0,
                    outputHeight: 0,
                    running: false,
                    mode: "none",
                };
            }
        },
    };

    return targetWindow.nativeCapture;
}

module.exports = { registerNativeCapture };