const path = require("path");
const { app, BrowserWindow, ipcMain, desktopCapturer, clipboard, session } = require("electron");

let mainWindow = null;

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
    // Apply COOP/COEP to the actual app document too, not just API responses.
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

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowed = ["media", "mediaKeySystem", "fullscreen", "openExternal"];
        callback(allowed.includes(permission));
    });

    ipcMain.handle("get-desktop-sources", async () => {
        const sources = await desktopCapturer.getSources({
            types: ["window", "screen"],
            thumbnailSize: { width: 320, height: 180 },
            fetchWindowIcons: true,
        });

        return sources.map((source) => ({
            id: source.id,
            name: source.name,
            thumbnail: source.thumbnail?.toDataURL?.() ?? "",
            appIcon: source.appIcon?.toDataURL?.() ?? "",
        }));
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