import * as fs from 'original-fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as iconv from 'iconv-lite';

const fsp = fs.promises;

const exec = promisify(execFile);

/** Запись в панели файлового списка */
export interface Entry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number; // мс
}

export interface DirListResult {
  path: string;
  entries: Entry[];
  error?: string;
}

export interface SearchResultEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export async function searchFiles(root: string, query: string, maxResults = 500): Promise<{ entries: SearchResultEntry[]; truncated: boolean }> {
  const needle = query.trim().toLocaleLowerCase('ru');
  if (!needle) return { entries: [], truncated: false };
  const entries: SearchResultEntry[] = [];
  const pending = [path.resolve(root)];
  let visited = 0;
  const maxDirectories = 100_000;
  let truncated = false;
  while (pending.length) {
    if (++visited > maxDirectories) { truncated = true; break; }
    const dir = pending.pop()!;
    let items: fs.Dirent[];
    try { items = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      const isDir = item.isDirectory();
      if (item.name.toLocaleLowerCase('ru').includes(needle)) {
        let stat: fs.Stats | null = null;
        try { stat = await fsp.stat(full); } catch { /* vanished or inaccessible */ }
        entries.push({ path: full, name: item.name, isDir: isDir || !!stat?.isDirectory(), size: isDir ? 0 : Number(stat?.size ?? 0), mtime: stat?.mtimeMs ?? 0 });
        if (entries.length >= maxResults) return { entries, truncated: true };
      }
      if (item.isDirectory()) pending.push(full);
    }
  }
  return { entries, truncated };
}

/** Список файлов каталога; ошибки доступа возвращаются текстом, а не исключением */
export async function listDir(dir: string): Promise<DirListResult> {
  try {
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    const entries: Entry[] = [];
    for (const d of dirents) {
      try {
        let isDir = d.isDirectory();
        let size = 0;
        let mtime = 0;
        if (d.isSymbolicLink()) {
          // для ссылок берём данные цели
          try {
            const st = await fsp.stat(path.join(dir, d.name));
            isDir = st.isDirectory();
            size = isDir ? 0 : Number(st.size);
            mtime = st.mtimeMs;
          } catch {
            // битая ссылка — показываем как есть
          }
        } else if (!isDir) {
          const st = await fsp.stat(path.join(dir, d.name));
          size = Number(st.size);
          mtime = st.mtimeMs;
        } else {
          const st = await fsp.stat(path.join(dir, d.name));
          mtime = st.mtimeMs;
        }
        entries.push({ name: d.name, isDir, size, mtime });
      } catch {
        entries.push({ name: d.name, isDir: d.isDirectory(), size: 0, mtime: 0 });
      }
    }
    return { path: dir, entries };
  } catch (e: any) {
    return { path: dir, entries: [], error: describeFsError(e, dir) };
  }
}

/** Recursive file size, without following directory symlinks. */
export async function directorySize(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) {
        try { total += Number((await fsp.stat(full)).size); } catch { /* skip inaccessible entries */ }
      }
    }
  }
  return total;
}

export function describeFsError(e: any, where?: string): string {
  const code = e?.code ?? '';
  const base = e?.message ?? String(e);
  if (code === 'EACCES' || code === 'EPERM') return 'Отказано в доступе' + (where ? `: ${where}` : '');
  if (code === 'ENOENT') return 'Путь не найден' + (where ? `: ${where}` : '');
  if (code === 'EBUSY') return 'Устройство занято' + (where ? `: ${where}` : '');
  return base + (where ? ` (${where})` : '');
}

export interface StatFsResult { total: number; free: number; error?: string }

export async function showNativeProperties(filePath: string): Promise<void> {
  const pathBase64 = Buffer.from(path.resolve(filePath), 'utf8').toString('base64');
  const command = "$ErrorActionPreference='Stop';" +
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'));` +
    "$shell=New-Object -ComObject Shell.Application;" +
    "$parent=[IO.Path]::GetDirectoryName($p); $name=[IO.Path]::GetFileName($p);" +
    "$folder=$shell.Namespace($parent); if($null -eq $folder){throw 'Не удалось открыть каталог объекта'};" +
    "$item=$folder.ParseName($name); if($null -eq $item){throw 'Объект не найден в Проводнике'};" +
    "$item.InvokeVerb('properties')";
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
    windowsHide: true, maxBuffer: 1 << 20,
  });
}

export async function statFs(p: string): Promise<StatFsResult> {
  try {
    const s = await fsp.statfs(p);
    const bsize = Number(s.bsize);
    return { total: Number(s.blocks) * bsize, free: Number(s.bavail) * bsize };
  } catch (e: any) {
    return { total: 0, free: 0, error: describeFsError(e, p) };
  }
}

export async function mkdirRecursive(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

export async function renameEntry(oldP: string, newP: string): Promise<void> {
  await fsp.rename(oldP, newP);
}

export async function openWithSystem(p: string): Promise<string> {
  const { shell } = await import('electron');
  const err = await shell.openPath(p);
  return err || '';
}

export interface ReadTextResult {
  content: string;
  encoding: string;
  truncated: boolean;
  size: number;
  error?: string;
}

const MAX_VIEW = 4 * 1024 * 1024; // 4 МБ — предел быстрого просмотра

/** Чтение текстового файла с автоопределением кодировки (UTF-8/16, BOM, cp1251) */
export async function readTextFile(p: string, maxBytes = MAX_VIEW): Promise<ReadTextResult> {
  try {
    const st = await fsp.stat(p);
    if (st.isDirectory()) return { content: '', encoding: '', truncated: false, size: 0, error: 'Это каталог' };
    const size = Number(st.size);
    const limit = Math.min(size, maxBytes);
    const fh = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(limit);
      await fh.read(buf, 0, limit, 0);
      const truncated = size > limit;
      let encoding = 'UTF-8';
      let content: string;
      if (limit >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        content = buf.subarray(3).toString('utf8');
      } else if (limit >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        encoding = 'UTF-16LE';
        content = iconv.decode(buf.subarray(2), 'UTF-16LE');
      } else if (limit >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        encoding = 'UTF-16BE';
        content = iconv.decode(buf.subarray(2), 'UTF-16BE');
      } else {
        const utf8 = buf.toString('utf8');
        const bad = countBadUtf8(buf);
        if (bad > 0) {
          // не UTF-8 — считаем ANSI/Windows-1251 (русская локаль)
          encoding = 'Windows-1251';
          content = iconv.decode(buf, 'win1251');
        } else {
          content = utf8;
        }
      }
      return { content, encoding, truncated, size };
    } finally {
      await fh.close();
    }
  } catch (e: any) {
    return { content: '', encoding: '', truncated: false, size: 0, error: describeFsError(e, p) };
  }
}

/** Приблизительный подсчёт недопустимых UTF-8 последовательностей */
function countBadUtf8(buf: Buffer): number {
  let bad = 0;
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const b = buf[i];
    let len = 0;
    if (b < 0x80) len = 1;
    else if ((b & 0xe0) === 0xc0) len = 2;
    else if ((b & 0xf0) === 0xe0) len = 3;
    else if ((b & 0xf8) === 0xf0) len = 4;
    if (len === 0) { bad++; i++; continue; }
    if (i + len > n) { bad++; break; }
    let ok = true;
    for (let j = 1; j < len; j++) {
      if ((buf[i + j] & 0xc0) !== 0x80) { ok = false; break; }
    }
    if (!ok) bad++;
    i += len;
  }
  return bad;
}

// ---------- Диски ----------

export interface DriveInfo {
  letter: string;   // "C:"
  root: string;     // "C:\\"
  label: string;    // метка тома
  type: string;     // Локальный/Съёмный/Сетевой/CD
  total: number;
  free: number;
}

function driveTypeName(t: number): string {
  switch (t) {
    case 2: return 'Съёмный';
    case 3: return 'Локальный';
    case 4: return 'Сетевой';
    case 5: return 'CD/DVD';
    case 6: return 'RAM-диск';
    default: return 'Неизвестный';
  }
}

export async function getDrives(): Promise<DriveInfo[]> {
  // PowerShell передаёт метку тома в Base64, чтобы не зависеть от OEM-кодировки WMIC.
  try {
    const command = '$enc=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_LogicalDisk | ' +
      'Select-Object DeviceID,DriveType,FreeSpace,Size,@{Name="VolumeNameBase64";Expression={' +
      '[Convert]::ToBase64String($enc.GetBytes([string]$_.VolumeName))}} | ConvertTo-Csv -NoTypeInformation';
    const { stdout } = await exec('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: 15000, windowsHide: true, maxBuffer: 1 << 20 });
    const drives = parseCsv(stdout);
    if (drives.length) return drives;
  } catch { /* пробуем следующий способ */ }

  try {
    const { stdout } = await exec('wmic',
      ['logicaldisk', 'get', 'deviceID,drivetype,freespace,size,volumename'],
      { timeout: 6000, windowsHide: true, maxBuffer: 1 << 20 });
    const drives = parseWmic(stdout);
    if (drives.length) return drives;
  } catch { /* последний способ */ }

  return probeLetters();
}

function parseWmic(out: string): DriveInfo[] {
  const res: DriveInfo[] = [];
  const re = /^([A-Z]:)\s+(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/;
  for (const line of out.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (!m) continue;
    // WMIC text uses the active OEM code page; don't display a corrupted label.
    res.push(mkDrive(m[1], +m[2], +m[4], +m[3], ''));
  }
  return res.sort((a, b) => a.letter.localeCompare(b.letter));
}

function parseCsv(out: string): DriveInfo[] {
  const res: DriveInfo[] = [];
  const lines = out.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return res;
  const header = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const idx = (k: string) => header.indexOf(k);
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const letter = cells[idx('deviceid')];
    if (!letter) continue;
    const label64 = cells[idx('volumenamebase64')];
    const label = label64 !== undefined
      ? Buffer.from(label64, 'base64').toString('utf8')
      : cells[idx('volumename')];
    res.push(mkDrive(letter, +cells[idx('drivetype')], +cells[idx('freespace')], +cells[idx('size')], label));
  }
  return res.sort((a, b) => a.letter.localeCompare(b.letter));
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function mkDrive(letter: string, type: number, free: number, total: number, label: string): DriveInfo {
  return {
    letter,
    root: letter + '\\',
    label: label || '',
    type: driveTypeName(type),
    total: Number.isFinite(total) ? total : 0,
    free: Number.isFinite(free) ? free : 0,
  };
}

/** Резервный способ: опрашиваем буквы A..Z напрямую */
async function probeLetters(): Promise<DriveInfo[]> {
  const out: DriveInfo[] = [];
  await Promise.all(Array.from({ length: 26 }, async (_, i) => {
    const letter = String.fromCharCode(65 + i);
    const root = letter + ':\\';
    try {
      await fs.promises.access(root);
      let total = 0, free = 0;
      try {
        const s = await fs.promises.statfs(root);
        total = Number(s.blocks) * Number(s.bsize);
        free = Number(s.bavail) * Number(s.bsize);
      } catch { /* размер неизвестен — не страшно */ }
      out.push({ letter: letter + ':', root, label: '', type: 'Локальный', total, free });
    } catch { /* диска нет */ }
  }));
  return out.sort((a, b) => a.letter.localeCompare(b.letter));
}
