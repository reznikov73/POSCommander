import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fsp from 'fs/promises';
import { execFile, spawn } from 'child_process';
import * as fsservice from './fsservice';
import { startOperation, cancelOperation, resolveConflict, OpKind, ConflictAnswer } from './ops';
import {
  createArchive, extractArchives, ArchiveFormat, listArchiveDirectory,
  parseArchivePath, extractArchiveEntries, deleteArchiveEntries, addFilesToArchive,
  renameArchiveEntry, createArchiveFolder, extractArchiveFileForView, stageArchiveEntries,
  stageArchiveDirectory, addStagedDirectoryToArchive,
} from './archives';

let mainWindow: BrowserWindow | null = null;
const fileIconCache = new Map<string, string>();

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
      code = code.replace('"__ASAR_FILE__"', JSON.stringify(path.join(path.dirname(process.execPath), 'resources', 'default_app.asar')));
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

function archiveProgress(event: Electron.IpcMainInvokeEvent, progressId?: string) {
  return (percent: number, currentFile: string) => {
    if (progressId) event.sender.send('archive:progress', { progressId, percent, currentFile });
  };
}

// Заголовок окна с системными показателями в стиле TC.
let cpuSnapshot = os.cpus();
let networkSnapshot: { rx: number; tx: number; at: number } | null = null;
let networkText = '0,0-0,0 Мбит/с';
let networkQueryRunning = false;
setInterval(() => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const cpu = readSystemCpu();
  const sysTotal = os.totalmem();
  const sysFree = os.freemem();
  const usedGb = (sysTotal - sysFree) / (1024 ** 3);
  const totalGb = sysTotal / (1024 ** 3);
  const pct = sysTotal ? Math.round(((sysTotal - sysFree) / sysTotal) * 100) : 0;
  const date = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
  const user = (() => { try { return os.userInfo().username; } catch { return 'User'; } })();
  const title = `${user}^ - POSCommander ${app.getVersion()}  ${date}  Сеть: ${networkText}  Память: ${formatRu(usedGb)}/${formatRu(totalGb)} Гб (${pct}%)  ЦП: ${cpu}%`;
  mainWindow.setTitle(title);
}, 1000).unref();

function readSystemCpu(): number {
  const current = os.cpus();
  let total = 0, idle = 0;
  for (let i = 0; i < current.length; i++) {
    const before = cpuSnapshot[i]?.times;
    const after = current[i].times;
    if (!before) continue;
    const delta = after.user - before.user + after.nice - before.nice + after.sys - before.sys +
      after.irq - before.irq + after.idle - before.idle;
    total += delta;
    idle += after.idle - before.idle;
  }
  cpuSnapshot = current;
  return total > 0 ? Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100))) : 0;
}

function formatRu(n: number): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function sampleNetwork(): void {
  if (process.platform !== 'win32' || networkQueryRunning) return;
  networkQueryRunning = true;
  const command = '$s=Get-NetAdapterStatistics -ErrorAction SilentlyContinue; if($s){' +
    '$rx=($s|Measure-Object -Property ReceivedBytes -Sum).Sum;' +
    '$tx=($s|Measure-Object -Property SentBytes -Sum).Sum; Write-Output "$rx,$tx"}';
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { timeout: 5000, windowsHide: true, maxBuffer: 4096 }, (error, stdout) => {
      networkQueryRunning = false;
      if (error) return;
      const [rx, tx] = stdout.trim().split(',').map(Number);
      if (!Number.isFinite(rx) || !Number.isFinite(tx)) return;
      const now = Date.now();
      if (networkSnapshot) {
        const sec = (now - networkSnapshot.at) / 1000;
        const down = Math.max(0, rx - networkSnapshot.rx) * 8 / sec / 1e6;
        const up = Math.max(0, tx - networkSnapshot.tx) * 8 / sec / 1e6;
        networkText = `${formatRu(down)}-${formatRu(up)} Мбит/с`;
      }
      networkSnapshot = { rx, tx, at: now };
    });
}

setInterval(sampleNetwork, 5000).unref();

// ---------------- IPC: файловая система ----------------

ipcMain.handle('fs:list', async (_e, p: string) => {
  if (!p.startsWith('archive://')) return fsservice.listDir(p);
  try {
    const parsed = parseArchivePath(p);
    if (!parsed) throw new Error('Некорректный путь внутри архива');
    const entries = await listArchiveDirectory(p);
    return { path: p, entries };
  } catch (e: any) { return { path: p, entries: [], error: e?.message ?? String(e) }; }
});
ipcMain.handle('fs:directorySize', async (_e, p: string) => {
  const parsed = parseArchivePath(p);
  return parsed ? 0 : fsservice.directorySize(p);
});
ipcMain.handle('fs:properties', async (_e, p: string) => fsservice.getFileProperties(p));
ipcMain.handle('fs:fileIcons', async (_e, paths: string[]) => {
  const limited = paths.slice(0, 512);
  const icons = await Promise.all(limited.map(async p => {
    if (p.startsWith('archive://')) return '';
    const key = path.resolve(p).toLowerCase();
    const cached = fileIconCache.get(key);
    if (cached) return cached;
    try {
      const image = await app.getFileIcon(p, { size: 'small' });
      const uri = image.toDataURL();
      fileIconCache.set(key, uri);
      if (fileIconCache.size > 4096) fileIconCache.delete(fileIconCache.keys().next().value!);
      return uri;
    } catch { return ''; }
  }));
  return icons.concat(Array(Math.max(0, paths.length - icons.length)).fill(''));
});
ipcMain.handle('fs:statfs', (_e, p: string) => {
  const parsed = parseArchivePath(p);
  return fsservice.statFs(parsed ? path.dirname(parsed.archive) : p);
});
ipcMain.handle('fs:search', (_e, args: { root: string; query: string }) => fsservice.searchFiles(args.root, args.query));
ipcMain.handle('fs:drives', () => fsservice.getDrives());
ipcMain.handle('archive:create', (_e, args: { srcs: string[]; archivePath: string; format: ArchiveFormat; cwd: string; progressId?: string }) =>
  createArchive(args.srcs, args.archivePath, args.format, args.cwd, archiveProgress(_e, args.progressId)).then(() => '').catch((e: any) => e?.message ?? String(e)));
ipcMain.handle('archive:extract', (_e, args: { archives: string[]; destination: string; progressId?: string }) =>
  extractArchives(args.archives, args.destination, archiveProgress(_e, args.progressId)).then(() => '').catch((e: any) => e?.message ?? String(e)));
ipcMain.handle('archive:extractEntries', (_e, args: { entries: string[]; destination: string; progressId?: string }) =>
  extractArchiveEntries(args.entries, args.destination, archiveProgress(_e, args.progressId)).then(() => '').catch((e: any) => e?.message ?? String(e)));
ipcMain.handle('archive:deleteEntries', (_e, args: { entries: string[]; progressId?: string }) =>
  deleteArchiveEntries(args.entries, archiveProgress(_e, args.progressId)).then(() => '').catch((e: any) => e?.message ?? String(e)));
ipcMain.handle('archive:addEntries', (_e, args: { srcs: string[]; destination: string; progressId?: string }) =>
  addFilesToArchive(args.srcs, args.destination, archiveProgress(_e, args.progressId)).then(() => '').catch((e: any) => e?.message ?? String(e)));
ipcMain.handle('archive:renameEntry', (_e, args: { entry: string; newName: string; progressId?: string }) =>
  renameArchiveEntry(args.entry, args.newName, archiveProgress(_e, args.progressId)).then(() => '').catch((e: any) => e?.message ?? String(e)));
ipcMain.handle('archive:createFolder', (_e, args: { path: string; progressId?: string }) =>
  createArchiveFolder(args.path, archiveProgress(_e, args.progressId)).then(() => '').catch((e: any) => e?.message ?? String(e)));
ipcMain.handle('archive:extractForView', (_e, args: { path: string; progressId?: string }) =>
  extractArchiveFileForView(args.path, archiveProgress(_e, args.progressId)).then(result => ({ path: result })).catch((e: any) => ({ error: e?.message ?? String(e) })));
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

ipcMain.handle('ops:start', async (_e, args: { kind: OpKind; srcs: string[]; destDir: string }) => {
  const archiveSources = args.srcs.length > 0 && args.srcs.every(src => src.startsWith('archive://'));
  const archiveDestination = args.destDir.startsWith('archive://');
  if (archiveSources && archiveDestination) throw new Error('Прямое копирование между архивами не поддерживается. Сначала скопируйте элементы в обычную папку.');
  if ((args.kind === 'copy' || args.kind === 'move') && args.srcs.length && args.srcs.every(src => src.startsWith('archive://'))) {
    const staged = await stageArchiveEntries(args.srcs);
    try {
      return startOperation(args.kind, staged.paths, args.destDir, mainWindow, async result => {
        try {
          if (args.kind === 'move') {
            if (result.cancelled || result.errors?.length || (result.skippedFiles ?? 0) > 0) {
              result.errors = [...(result.errors ?? []), 'Исходные элементы оставлены в архиве: операция завершилась не полностью.'];
            } else await deleteArchiveEntries(args.srcs);
          }
        } finally { await fsp.rm(staged.root, { recursive: true, force: true }); }
      });
    } catch (error) {
      await fsp.rm(staged.root, { recursive: true, force: true });
      throw error;
    }
  }
  if (archiveDestination && (args.kind === 'copy' || args.kind === 'move')) {
    const staged = await stageArchiveDirectory(args.destDir);
    try {
      return startOperation('copy', args.srcs, staged.path, mainWindow, async result => {
        try {
          if (result.cancelled || result.errors?.length) return;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('op:progress', {
              ...result, phase: 'progress', currentFile: 'Запись файлов в архив…',
              filesDone: result.filesTotal, bytesDone: result.bytesTotal, bps: 0,
            });
          }
          await addStagedDirectoryToArchive(staged.path, args.destDir);
          if (args.kind === 'move') {
            if ((result.skippedFiles ?? 0) > 0) {
              result.errors = [...(result.errors ?? []), 'Исходные файлы оставлены: часть объектов была пропущена.'];
            } else {
              for (const src of args.srcs) await fsp.rm(src, { recursive: true, force: false });
            }
          }
        } finally { await fsp.rm(staged.root, { recursive: true, force: true }); }
      });
    } catch (error) {
      await fsp.rm(staged.root, { recursive: true, force: true });
      throw error;
    }
  }
  return startOperation(args.kind, args.srcs, args.destDir, mainWindow);
});
ipcMain.on('ops:cancel', (_e, opId: number) => cancelOperation(opId));
ipcMain.on('ops:conflict-reply', (_e, args: { conflictId: number; answer: ConflictAnswer }) => {
  resolveConflict(args.conflictId, args.answer);
});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:home', () => os.homedir());
