import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fsp from 'fs/promises';
import { spawn } from 'child_process';
import * as fsservice from './fsservice';
import { startOperation, cancelOperation, resolveConflict, OpKind, ConflictAnswer } from './ops';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 550,
    title: 'POSCommander',
    backgroundColor: '#f0f0f0',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // без стандартного меню; DevTools по F12
  Menu.setApplicationMenu(null);
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  // самопроверка: `electron . --smoke` — проверить старт UI и выйти
  mainWindow.webContents.on('did-finish-load', async () => {
    if (!process.argv.includes('--smoke') || !mainWindow) return;
    try {
      const r = await mainWindow.webContents.executeJavaScript(
        'new Promise(res => { const t0 = Date.now(); const tick = () => {' +
        'const rows = document.querySelectorAll(".row").length;' +
        'const status = document.getElementById("status-left")?.textContent ?? "";' +
        'if (rows > 0 || status !== "" || Date.now() - t0 > 10000) ' +
        'res({pos: !!window.pos, rows, status, fkeys: document.querySelectorAll(".fkey").length});' +
        'else setTimeout(tick, 250); }; tick(); })');
      console.log('[SMOKE]', JSON.stringify(r));
      try {
        const img = await mainWindow.webContents.capturePage();
        const fsSync2 = require('fs') as typeof import('fs');
        fsSync2.writeFileSync(path.join(app.getAppPath(), 'smoke-shot.png'), img.toPNG());
        console.log('[SMOKE] screenshot saved');
      } catch (e2) { console.error('[SMOKE] shot fail', e2); }
      app.exit(0);
    } catch (e) {
      console.error('[SMOKE] FAIL', e);
      app.exit(1);
    }
  });

  // интеграционный тест файловых операций: `electron . --smoke-ops`
  mainWindow.webContents.on('did-finish-load', async () => {
    if (!process.argv.includes('--smoke-ops') || !mainWindow) return;
    try {
      const fsSync = require('fs') as typeof import('fs');
      const osMod = await import('os');
      const scriptPath = path.join(app.getAppPath(), 'scripts', 'smoke-renderer.js');
      let code = fsSync.readFileSync(scriptPath, 'utf8');
      code = code.replace('"__SRC__"', JSON.stringify(path.join(app.getAppPath(), 'dist', 'renderer')));
      code = code.replace('"__TMP__"', JSON.stringify(path.join(osMod.tmpdir(), 'posc-smoke-test')));
      const r = await mainWindow.webContents.executeJavaScript(code, true);
      console.log('[SMOKE-OPS]', JSON.stringify(r, null, 1));
      app.exit(0);
    } catch (e) {
      console.error('[SMOKE-OPS] FAIL', e);
      app.exit(1);
    }
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------------- IPC: файловая система ----------------

ipcMain.handle('fs:list', (_e, p: string) => fsservice.listDir(p));
ipcMain.handle('fs:statfs', (_e, p: string) => fsservice.statFs(p));
ipcMain.handle('fs:drives', () => fsservice.getDrives());
ipcMain.handle('fs:mkdir', async (_e, p: string) => {
  try { await fsservice.mkdirRecursive(p); return ''; }
  catch (e: any) { return fsservice.describeFsError(e, p); }
});
ipcMain.handle('fs:rename', async (_e, oldP: string, newP: string) => {
  try {
    await fsp.access(newP);
    return 'Цель уже существует: ' + newP;
  } catch { /* не существует — хорошо */ }
  try { await fsservice.renameEntry(oldP, newP); return ''; }
  catch (e: any) { return fsservice.describeFsError(e, oldP); }
});
ipcMain.handle('fs:readText', (_e, p: string, max?: number) => fsservice.readTextFile(p, max));
ipcMain.handle('shell:open', async (_e, p: string) => {
  const err = await fsservice.openWithSystem(p);
  return err;
});
ipcMain.handle('shell:run', async (_e, command: string, cwd: string) => {
  return new Promise<string>((resolve) => {
    try {
      const child = spawn(command, { cwd, shell: true, detached: true, stdio: 'ignore', windowsHide: true });
      let settled = false;
      const done = (message: string) => { if (!settled) { settled = true; resolve(message); } };
      child.once('spawn', () => { child.unref(); done(''); });
      child.once('error', (e: any) => done(e?.message ?? String(e)));
    } catch (e: any) { resolve(e?.message ?? String(e)); }
  });
});

// ---------------- IPC: операции ----------------

ipcMain.handle('ops:start', (_e, args: { kind: OpKind; srcs: string[]; destDir: string }) => {
  return startOperation(args.kind, args.srcs, args.destDir, mainWindow);
});
ipcMain.on('ops:cancel', (_e, opId: number) => cancelOperation(opId));
ipcMain.on('ops:conflict-reply', (_e, args: { conflictId: number; answer: ConflictAnswer }) => {
  resolveConflict(args.conflictId, args.answer);
});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:home', () => os.homedir());
