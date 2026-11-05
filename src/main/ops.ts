import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow, shell } from 'electron';
import { describeFsError } from './fsservice';

export type OpKind = 'copy' | 'move' | 'deletePerm' | 'trash';

export type ConflictAnswer = 'overwrite' | 'skip' | 'overwriteAll' | 'skipAll' | 'cancel';

export interface OpProgressData {
  opId: number;
  kind: OpKind;
  phase: 'start' | 'progress' | 'done';
  currentFile: string;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  bps: number; // байт/сек
  cancelled?: boolean;
  errors?: string[];
}

export interface ConflictInfo {
  opId: number;
  conflictId: number;
  srcName: string;
  destName: string;
  isDir: boolean;
  srcSize: number;
  srcTime: number;
  destSize: number;
  destTime: number;
}

interface Task {
  src: string;
  dest: string;      // для copy/move; для delete не нужен
  isDir: boolean;
  size: number;
  srcDir?: string;   // каталог-родитель для очистки при move
}

let nextOpId = 1;
const running = new Map<number, FileOperation>();
const conflictWaiters = new Map<number, (a: ConflictAnswer) => void>();

export function cancelOperation(opId: number): void {
  running.get(opId)?.cancel();
}

export function resolveConflict(conflictId: number, answer: ConflictAnswer): void {
  const w = conflictWaiters.get(conflictId);
  if (w) {
    conflictWaiters.delete(conflictId);
    w(answer);
  }
}

function send(win: BrowserWindow | null, data: OpProgressData | ConflictInfo, channel: string): void {
  try {
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  } catch { /* окно уже закрыто */ }
}

/** Движок файловых операций: копирование, перенос, удаление (в корзину и навсегда) */
export class FileOperation {
  readonly opId = nextOpId++;
  private cancelled = false;
  private overwriteAll = false;
  private skipAll = false;
  private errors: string[] = [];
  private filesDone = 0;
  private bytesDone = 0;
  private bytesTotal = 0;
  private filesTotal = 0;
  private currentFile = '';
  private lastEmit = 0;
  private recentBytes: Array<{ t: number; b: number }> = [];

  constructor(
    private kind: OpKind,
    private srcs: string[],
    private destDir: string,
    private win: BrowserWindow | null,
  ) {}

  cancel(): void { this.cancelled = true; }

  private emitProgress(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 90) return;
    this.lastEmit = now;
    // скорость по скользящему окну ~1 сек
    const t = now;
    this.recentBytes.push({ t, b: this.bytesDone });
    while (this.recentBytes.length > 1 && t - this.recentBytes[0].t > 1200) this.recentBytes.shift();
    const first = this.recentBytes[0];
    const dt = (t - first.t) / 1000;
    const bps = dt > 0.15 ? (this.bytesDone - first.b) / dt : 0;
    send(this.win, {
      opId: this.opId, kind: this.kind, phase: 'progress',
      currentFile: this.currentFile,
      filesDone: this.filesDone, filesTotal: this.filesTotal,
      bytesDone: this.bytesDone, bytesTotal: this.bytesTotal,
      bps: Math.max(0, bps),
    }, 'op:progress');
  }

  private async askConflict(info: Omit<ConflictInfo, 'opId' | 'conflictId'>): Promise<ConflictAnswer> {
    const conflictId = nextOpId++;
    return new Promise<ConflictAnswer>((resolve) => {
      conflictWaiters.set(conflictId, resolve);
      send(this.win, { ...info, opId: this.opId, conflictId }, 'op:conflict');
    });
  }

  /** Собирает плоский список задач по исходным путям */
  private async collectTasks(): Promise<Task[]> {
    const tasks: Task[] = [];
    const walk = async (src: string, dest: string, srcDir?: string): Promise<void> => {
      let st;
      try {
        st = await fsp.lstat(src);
      } catch (e: any) {
        this.errors.push(`${src}: ${describeFsError(e)}`);
        return;
      }
      if (st.isDirectory()) {
        tasks.push({ src, dest, isDir: true, size: 0, srcDir });
        let names: string[] = [];
        try {
          names = (await fsp.readdir(src, { withFileTypes: true })).map(d => d.name);
        } catch (e: any) {
          this.errors.push(`${src}: ${describeFsError(e)}`);
          return;
        }
        for (const name of names) {
          if (this.cancelled) return;
          await walk(path.join(src, name), path.join(dest, name), src);
        }
      } else {
        tasks.push({ src, dest, isDir: false, size: Number(st.size), srcDir });
      }
    };
    for (const src of this.srcs) {
      if (this.cancelled) break;
      const base = path.basename(src);
      if (this.kind === 'deletePerm') {
        await walk(src, src);
      } else if (this.kind === 'trash') {
        let st;
        try { st = await fsp.lstat(src); } catch { continue; }
        tasks.push({ src, dest: '', isDir: st.isDirectory(), size: 0 });
      } else {
        await walk(src, path.join(this.destDir, base));
      }
    }
    this.filesTotal = tasks.filter(t => !t.isDir).length;
    this.bytesTotal = tasks.reduce((s, t) => s + (t.isDir ? 0 : t.size), 0);
    return tasks;
  }

  /** Разрешение конфликта для отдельного файла/каталога назначения */
  private async checkConflict(task: Task): Promise<'do' | 'skip' | 'stop'> {
    if (this.kind === 'deletePerm' || this.kind === 'trash') return 'do';
    let destSt;
    try {
      destSt = await fsp.lstat(task.dest);
    } catch {
      return 'do'; // назначения нет — просто выполняем
    }
    // каталог поверх каталога — слияние
    if (task.isDir && destSt.isDirectory()) return 'do';
    if (this.skipAll) return 'skip';
    if (this.overwriteAll) return 'do';

    let srcSt;
    try { srcSt = await fsp.lstat(task.src); } catch { return 'skip'; }
    const answer = await this.askConflict({
      srcName: task.src,
      destName: task.dest,
      isDir: false,
      srcSize: Number(srcSt.size),
      srcTime: srcSt.mtimeMs,
      destSize: Number(destSt.size),
      destTime: destSt.mtimeMs,
    });
    switch (answer) {
      case 'overwrite': return 'do';
      case 'skip': return 'skip';
      case 'overwriteAll': this.overwriteAll = true; return 'do';
      case 'skipAll': this.skipAll = true; return 'skip';
      case 'cancel': this.cancelled = true; return 'stop';
    }
  }

  private async doFileTask(task: Task): Promise<void> {
    if (task.isDir) {
      if (this.kind === 'copy' || this.kind === 'move') {
        try { await fsp.mkdir(task.dest, { recursive: true }); } catch (e: any) {
          if (e?.code !== 'EEXIST') throw e;
        }
        if (this.kind === 'move' && task.srcDir) {
          // исходный каталог удалим после переноса содержимого
        }
      }
      return;
    }
    // файл
    if (this.kind === 'copy' || this.kind === 'move') {
      const st = await fsp.stat(task.src);
      this.currentFile = path.basename(task.dest);
      await fsp.mkdir(path.dirname(task.dest), { recursive: true });
      if (this.kind === 'move' && path.parse(task.src).root === path.parse(task.dest).root) {
        // тот же том — быстрый переименовательный перенос
        try {
          await fsp.rename(task.src, task.dest);
          this.filesDone++;
          this.bytesDone += Number(st.size);
          this.emitProgress(true);
          return;
        } catch (e: any) {
          if (e?.code !== 'EPERM' && e?.code !== 'EACCES' && e?.code !== 'EXDEV' && e?.code !== 'EISDIR') {
            throw e;
          }
          // падаем в копирование
        }
      }
      await this.copyWithProgress(task.src, task.dest, Number(st.size));
      // сохраняем время изменения, как это делает TC
      await fsp.utimes(task.dest, st.atime, st.mtime).catch(() => {});
      if (this.kind === 'move') {
        await fsp.unlink(task.src).catch(() => {});
      }
      this.filesDone++;
    } else if (this.kind === 'deletePerm') {
      this.currentFile = path.basename(task.src);
      await fsp.unlink(task.src);
      this.filesDone++;
    }
  }

  /** Потоковое копирование с подсчётом байтов */
  private copyWithProgress(src: string, dest: string, size: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(src, { highWaterMark: 512 * 1024 });
      const ws = fs.createWriteStream(dest, { flags: 'w' });
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        try { rs.destroy(); } catch { /* уже закрыт */ }
        try { ws.destroy(); } catch { /* уже закрыт */ }
        reject(err);
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      rs.on('data', (chunk: Buffer) => {
        this.bytesDone += chunk.length;
        this.emitProgress();
        if (this.cancelled) fail(new Error('cancelled'));
      });
      rs.on('error', fail);
      ws.on('error', fail);
      ws.on('finish', ok);
      rs.pipe(ws);
    });
  }

  private async cleanupMovedDirs(tasks: Task[]): Promise<void> {
    if (this.kind !== 'move') return;
    // удаляем опустевшие исходные каталоги, снизу вверх
    const dirs = tasks.filter(t => t.isDir).map(t => t.src);
    dirs.sort((a, b) => b.length - a.length);
    for (const d of dirs) {
      if (this.cancelled) return;
      await fsp.rmdir(d).catch(() => {});
    }
  }

  async run(): Promise<void> {
    running.set(this.opId, this);
    let tasks: Task[] = [];
    try {
      tasks = await this.collectTasks();
      if (this.kind !== 'trash') {
        // каталоги обрабатываем до файлов внутри них (создание), файлы отдельно
        for (const t of tasks.filter(t => t.isDir)) {
          if (this.cancelled) break;
          try { await this.doFileTask(t); } catch (e: any) {
            this.errors.push(`${t.src}: ${describeFsError(e)}`);
          }
        }
      }
      for (const t of tasks) {
        if (this.cancelled) break;
        if (t.isDir && this.kind !== 'trash' && this.kind !== 'deletePerm') continue; // уже создали
        if (t.isDir) continue;
        const verdict = await this.checkConflict(t);
        if (verdict === 'stop') break;
        if (verdict === 'skip') { this.filesDone++; continue; }
        try {
          await this.doFileTask(t);
        } catch (e: any) {
          if (e?.message === 'cancelled') { this.cancelled = true; break; }
          this.errors.push(`${t.src}: ${describeFsError(e)}`);
        }
        this.emitProgress();
      }
      // удаление каталогов при deletePerm (снизу вверх)
      if (this.kind === 'deletePerm') {
        const dirs = tasks.filter(t => t.isDir).map(t => t.src);
        dirs.sort((a, b) => b.length - a.length);
        for (const d of dirs) {
          if (this.cancelled) break;
          await fsp.rmdir(d).catch(e => this.errors.push(`${d}: ${describeFsError(e)}`));
        }
      }
      if (this.kind === 'trash') {
        for (const t of tasks) {
          if (this.cancelled) break;
          this.currentFile = path.basename(t.src);
          try {
            await shell.trashItem(t.src);
          } catch (e: any) {
            this.errors.push(`${t.src}: ${describeFsError(e)}`);
          }
          this.filesDone++;
          this.emitProgress(true);
        }
      }
      await this.cleanupMovedDirs(tasks);
    } finally {
      running.delete(this.opId);
      this.emitProgress(true);
      send(this.win, {
        opId: this.opId, kind: this.kind, phase: 'done',
        currentFile: '', filesDone: this.filesDone, filesTotal: this.filesTotal,
        bytesDone: this.bytesDone, bytesTotal: this.bytesTotal, bps: 0,
        cancelled: this.cancelled,
        errors: this.errors.slice(0, 50),
      }, 'op:done');
    }
  }
}

export function startOperation(kind: OpKind, srcs: string[], destDir: string, win: BrowserWindow | null): number {
  const op = new FileOperation(kind, srcs, destDir, win);
  // запускаем в фоне, ID возвращаем сразу
  op.run().catch(() => { /* ошибки уже собраны внутри */ });
  return op.opId;
}
