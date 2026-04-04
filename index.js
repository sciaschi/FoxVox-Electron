const path = require("path");
const { app, BrowserWindow, ipcMain, desktopCapturer, clipboard, session, screen, autoUpdater } = require("electron");
const { updateElectronApp } = require("update-electron-app");

let mainWindow = null;

function normalizeSourceKind(sourceId = "") {
    if (sourceId.startsWith("window:")) return "window";
    if (sourceId.startsWith("screen:")) return "screen";
    return "unknown";
}

function parseElectronSourceId(sourceId = "") {
    const kind = normalizeSourceKind(sourceId);

    if (kind === "window") {
        const parts = sourceId.split(":");
        const rawWindowId = Number(parts[1] ?? 0);
        return {
            kind,
            windowId: Number.isFinite(rawWindowId) ? rawWindowId : 0,
            hwnd: Number.isFinite(rawWindowId) ? rawWindowId : 0,
        };
    }

    if (kind === "screen") {
        const parts = sourceId.split(":");
        const screenId = Number(parts[1] ?? 0);
        return {
            kind,
            screenId: Number.isFinite(screenId) ? screenId : 0,
        };
    }

    return { kind: "unknown" };
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        frame: false,
        titleBarStyle: "hidden",
        backgroundColor: "#141414",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: false,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    mainWindow.loadFile(path.join(__dirname, "dist/index.html"));
}

app.whenReady().then(() => {

    updateElectronApp();

    autoUpdater.once("update-not-available", createWindow);
    autoUpdater.once("error", createWindow);

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                "Cross-Origin-Opener-Policy": ["same-origin"],
                "Cross-Origin-Embedder-Policy": ["credentialless"],
                "Access-Control-Allow-Origin": ["*"],
                "Access-Control-Allow-Methods": ["GET, POST, PUT, DELETE, OPTIONS"],
                "Access-Control-Allow-Headers": ["Content-Type, Authorization"],
            },
        });
    });

    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        const allowed = ["media", "mediaKeySystem", "fullscreen", "openExternal"];
        callback(allowed.includes(permission));
    });

    ipcMain.handle("get-desktop-sources", async (_event, opts = {}) => {
        const includeScreens = opts.includeScreens !== false;
        const includeWindows = opts.includeWindows !== false;

        const displays = screen.getAllDisplays();
        const displayIndexById = new Map(displays.map((d, idx) => [Number(d.id), idx]));
        const displayById = new Map(displays.map((d) => [Number(d.id), d]));

        const sources = await desktopCapturer.getSources({
            types: [
                ...(includeWindows ? ["window"] : []),
                ...(includeScreens ? ["screen"] : []),
            ],
            thumbnailSize: { width: 320, height: 180 },
            fetchWindowIcons: true,
        });

        return sources.map((source) => {
            const parsed = parseElectronSourceId(source.id);

            let dxgiOutputIndex = null;
            let nativeWidth = null;
            let nativeHeight = null;
            let screenId = parsed.screenId ?? null;
            let hwnd = parsed.hwnd ?? null;
            let windowId = parsed.windowId ?? null;

            if (parsed.kind === "screen") {
                dxgiOutputIndex = displayIndexById.get(parsed.screenId) ?? 0;

                const display = displayById.get(parsed.screenId);
                if (display) {
                    nativeWidth = Number(display.bounds?.width ?? display.size?.width ?? 0) || null;
                    nativeHeight = Number(display.bounds?.height ?? display.size?.height ?? 0) || null;
                    screenId = Number(display.id);
                }
            }

            if (parsed.kind === "window") {
                nativeWidth = null;
                nativeHeight = null;

                hwnd = hwnd || null;
                windowId = windowId || null;
            }

            return {
                id: source.id,
                name: source.name,
                kind: parsed.kind,
                thumbnail: source.thumbnail?.toDataURL?.() ?? "",
                appIcon: source.appIcon?.toDataURL?.() ?? "",
                hwnd,
                windowId,
                screenId,
                dxgiOutputIndex,
                nativeWidth,
                nativeHeight,
            };
        });
    });

    ipcMain.on("window-minimize", () => mainWindow?.minimize());

    ipcMain.on("window-maximize", () => {
        if (!mainWindow) return;

        if (mainWindow.isMaximized())
            mainWindow.unmaximize();
        else
            mainWindow.maximize();

        mainWindow.webContents.send("maximize-change", mainWindow.isMaximized());
    });

    ipcMain.on("window-close", () => mainWindow?.close());

    ipcMain.on("navigate-back", () => {
        if (mainWindow?.webContents.canGoBack())
            mainWindow.webContents.goBack();
    });

    ipcMain.on("navigate-forward", () => {
        if (mainWindow?.webContents.canGoForward())
            mainWindow.webContents.goForward();
    });

    ipcMain.on("clipboard-write", (_event, text) => {
        clipboard.writeText(text ?? "");
    });

    createWindow();
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        app.quit();
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0)
        createWindow();
});