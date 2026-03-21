const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require("electron");
const path = require("path");

const isDev = !app.isPackaged;

ipcMain.on("window-minimize", () => {
    BrowserWindow.getFocusedWindow()?.minimize();
});

ipcMain.on("window-maximize", () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win?.isMaximized()) win.unmaximize();
    else win?.maximize();
});

ipcMain.on("window-close", () => {
    BrowserWindow.getFocusedWindow()?.destroy();
});

ipcMain.on("navigate-back", () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win?.webContents.navigationHistory.canGoBack())
        win.webContents.navigationHistory.goBack();
});

ipcMain.on("navigate-forward", () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win?.webContents.navigationHistory.canGoForward())
        win.webContents.navigationHistory.goForward();
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        frame: false,
        titleBarStyle: "hidden",
        backgroundColor: "#141414",
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            partition: "persist:main",
            preload: path.join(__dirname, "preload.js"),
        },
    });

    const ses = session.fromPartition("persist:main");

    // CORS fix — inject missing headers for api.foxvox.app
    ses.webRequest.onHeadersReceived(
        { urls: ["https://api.foxvox.app/*"] },
        (details, callback) => {
            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    "Access-Control-Allow-Origin":      ["*"],
                    "Access-Control-Allow-Methods":     ["GET, POST, PUT, DELETE, OPTIONS"],
                    "Access-Control-Allow-Headers":     ["Content-Type, Authorization"],
                    "Access-Control-Allow-Credentials": ["true"],
                },
            });
        }
    );

    ses.setPermissionRequestHandler(
        (webContents, permission, callback) => {
            const allowed = ["media", "mediaKeySystem", "fullscreen", "openExternal"];
            callback(allowed.includes(permission));
        }
    );

    ses.setDisplayMediaRequestHandler(
        (request, callback) => {
            desktopCapturer.getSources({ types: ["screen", "window"] }).then((sources) => {
                callback({ video: sources[0], audio: "loopback" });
            });
        }
    );

    win.setMinimumSize(800, 400);

    win.loadFile(path.join(__dirname, "dist/index.html"));

    if (isDev) {
        win.webContents.openDevTools();
    }

    win.on("maximize",   () => win.webContents.send("maximize-change", true));
    win.on("unmaximize", () => win.webContents.send("maximize-change", false));
}

ipcMain.handle("get-desktop-sources", async () => {
    const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
    });

    return sources.map((s) => ({
        id:         s.id,
        name:       s.name,
        thumbnail:  s.thumbnail.toDataURL(),
        appIcon:    s.appIcon ? s.appIcon.toDataURL() : null,
        display_id: s.display_id,
    }));
});

app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});

app.on("before-quit", () => {
    setTimeout(() => app.exit(0), 2000);
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        app.quit();
});