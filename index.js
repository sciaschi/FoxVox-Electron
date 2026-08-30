const path = require("path");
const { app, BrowserWindow, ipcMain, desktopCapturer, clipboard, session, screen, protocol } = require("electron");
const { updateElectronApp } = require("update-electron-app");
const fs = require("fs");

let mainWindow = null;

if (require("electron-squirrel-startup")) {
    app.quit();
}

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
            webSecurity: true,
        },
    });

    mainWindow.loadURL("app://./index.html");

    mainWindow.on("close", (e) => {
        if (!mainWindow.isClearedForClose) {
            e.preventDefault();
            mainWindow.webContents.executeJavaScript(`localStorage.removeItem("server")`)
                .finally(() => {
                    mainWindow.isClearedForClose = true;
                    mainWindow.close();
                });
        }
    });
}

// MUST be registered before app.whenReady
protocol.registerSchemesAsPrivileged([
    {
        scheme: "app",
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
            allowServiceWorkers: true,
        },
    },
]);

app.whenReady().then(() => {
    updateElectronApp();

    // Force isolation headers on every response
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = { ...details.responseHeaders };

        responseHeaders["Cross-Origin-Opener-Policy"] = ["same-origin"];
        responseHeaders["Cross-Origin-Embedder-Policy"] = ["credentialless"];
        responseHeaders["Cross-Origin-Resource-Policy"] = ["cross-origin"];
        responseHeaders["Origin-Agent-Cluster"] = ["?1"];

        // Strict CSP – no external fonts / styles that block isolation
        responseHeaders["Content-Security-Policy"] = [`
            default-src   'self';
            script-src    'self';
            style-src     'self' 'unsafe-inline';
            font-src      'self';
            img-src       'self' file: data: blob: https:;
            media-src     'self' file: blob:;
            frame-src     'none';
            connect-src   'self'
                          https://api.foxvox.app
                          wss://gw.foxvox.app
                          https://*.amazonaws.com;
            worker-src    'self' blob:;
            object-src    'none';
            base-uri      'self';
            form-action   'self';
        `];

        callback({ responseHeaders });
    });

    // Custom protocol – also force the headers on the main document + assets
    protocol.handle("app", (request) => {
        const url = new URL(request.url);

        let filePath = path.join(__dirname, "dist", url.pathname);

        if (url.pathname === "/" || url.pathname === "" || !path.extname(filePath)) {
            filePath = path.join(__dirname, "dist", "index.html");
        }

        try {
            if (!fs.existsSync(filePath)) {
                return new Response("Not Found", { status: 404 });
            }

            const fileData = fs.readFileSync(filePath);
            const ext = path.extname(filePath).toLowerCase();

            const mimeTypes = {
                ".html": "text/html",
                ".js": "application/javascript",
                ".css": "text/css",
                ".json": "application/json",
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".svg": "image/svg+xml",
                ".wasm": "application/wasm",
                ".ico": "image/x-icon",
                ".woff": "font/woff",
                ".woff2": "font/woff2",
            };

            const contentType = mimeTypes[ext] || "application/octet-stream";

            return new Response(fileData, {
                status: 200,
                headers: {
                    "Content-Type": contentType,
                    "Cross-Origin-Opener-Policy": "same-origin",
                    "Cross-Origin-Embedder-Policy": "credentialless",
                    "Cross-Origin-Resource-Policy": "cross-origin",
                    "Origin-Agent-Cluster": "?1",
                },
            });
        } catch (error) {
            console.error("Failed to serve file via custom protocol:", error);
            return new Response("Internal Server Error", { status: 500 });
        }
    });

    createWindow();

    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        const allowed = ["media", "mediaKeySystem", "fullscreen", "openExternal"];
        callback(allowed.includes(permission));
    });

    ipcMain.handle("get-desktop-sources", async (_event, opts = {}) => {
        const includeScreens = opts.includeScreens !== false;
        const includeWindows = opts.includeWindows !== false;

        const displays = screen.getAllDisplays();
        console.log("[Displays raw]", displays.map((d) => ({
            id: d.id,
            bounds: d.bounds,
            scaleFactor: d.scaleFactor,
        })));

        const displaysSortedByPosition = [...displays].sort(
            (a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y
        );
        const displayBySequentialIndex = new Map(
            displaysSortedByPosition.map((d, idx) => [idx, d])
        );

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
                const display = displayBySequentialIndex.get(parsed.screenId);
                if (display) {
                    dxgiOutputIndex = parsed.screenId;
                    nativeWidth = display.bounds.width || null;
                    nativeHeight = display.bounds.height || null;
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

    ipcMain.on("window-close", () => {
        mainWindow?.close();
    });

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
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0)
        createWindow();
});