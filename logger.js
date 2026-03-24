import { app, ipcMain } from "electron";
import { createWriteStream, mkdirSync } from "fs";
import { join } from "path";

const LOG_DIR  = join(app.getPath("userData"), "logs");
const LOG_FILE = join(LOG_DIR, "foxvox.log");

mkdirSync(LOG_DIR, { recursive: true });

const logStream = createWriteStream(LOG_FILE, { flags: "a", encoding: "utf8" });

function writeToLog(line) {
    const ts = new Date().toISOString();
    logStream.write(`[${ts}] ${line}\n`);
}

process.on("uncaughtException", (err) => {
    writeToLog(`[MAIN] uncaughtException: ${err?.stack ?? err}`);
});

process.on("unhandledRejection", (reason) => {
    writeToLog(`[MAIN] unhandledRejection: ${reason?.stack ?? reason}`);
});

writeToLog(`[MAIN] App starting — version ${app.getVersion()}, pid ${process.pid}`);


ipcMain.on("foxvox:log", (_event, { type, message, detail }) => {
    const detailPart = detail ? `\n  ${detail.replace(/\n/g, "\n  ")}` : "";
    writeToLog(`[RENDERER] [${type}] ${message}${detailPart}`);
});

ipcMain.handle("foxvox:logPath", () => LOG_FILE);