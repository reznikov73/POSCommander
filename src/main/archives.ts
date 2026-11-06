import * as path from 'path';
import * as fsp from 'fs/promises';
import * as os from 'os';
import { constants as fsConstants } from 'fs';
import { spawn } from 'child_process';
import { path7za } from '7zip-bin';

export interface ArchivePath { archive: string; inner: string }
export interface ArchiveEntry { name: string; isDir: boolean; size: number; mtime: number }

/** Virtual panel path format: archive://<encoded physical path>!/<inner path> */
export function parseArchivePath(value: string): ArchivePath | null {
  if (!value.startsWith('archive://')) return null;
  const split = value.indexOf('!/');
  if (split < 0) return null;
  try {
    const archive = decodeURIComponent(value.slice('archive://'.length, split));
    const inner = value.slice(split + 2).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!archive || inner.split('/').some(part => part === '..')) return null;
    return { archive, inner };
  } catch { return null; }
}

export type ArchiveFormat = 'zip' | '7z' | 'tar';

function sevenZipPath(): string {
  return path7za.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function runSevenZip(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZipPath(), args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-64 * 1024 * 1024); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(output);
      else reject(new Error(output.trim() || `7-Zip завершился с кодом ${code ?? 'unknown'}`));
    });
  });
}

export async function listArchiveDirectory(virtualPath: string): Promise<ArchiveEntry[]> {
  const parsed = parseArchivePath(virtualPath);
  if (!parsed) throw new Error('Некорректный путь внутри архива');
  await fsp.access(parsed.archive);
  const output = await runSevenZip(['l', '-slt', '-sccUTF-8', path.resolve(parsed.archive)], path.dirname(path.resolve(parsed.archive)));
  const records = output.split(/\r?\n\r?\n/).map(block => {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const i = line.indexOf(' = ');
      if (i >= 0) fields.set(line.slice(0, i), line.slice(i + 3));
    }
    return fields;
  });
  const prefix = parsed.inner ? parsed.inner + '/' : '';
  const children = new Map<string, ArchiveEntry>();
  for (const fields of records) {
    const entryPath = fields.get('Path');
    if (!entryPath || entryPath === path.basename(parsed.archive) || entryPath === parsed.archive) continue;
    const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (!normalized.startsWith(prefix)) continue;
    const rest = normalized.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    if (!name || name === '.' || name === '..') continue;
    const explicitDir = fields.get('Folder') === '+' || normalized.endsWith('/');
    const isDir = explicitDir || slash >= 0;
    const existing = children.get(name);
    const size = Number(fields.get('Size') ?? 0);
    const dateText = fields.get('Modified') ?? '';
    const mtime = Date.parse(dateText) || 0;
    if (!existing || (existing.isDir && !isDir)) children.set(name, { name, isDir, size, mtime });
    else if (!existing.isDir) children.set(name, { name, isDir, size, mtime });
  }
  return [...children.values()];
}

function safeInner(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (normalized.split('/').some(part => part === '..' || part === '.')) throw new Error('Некорректный путь внутри архива');
  return normalized;
}

export async function extractArchiveEntries(virtualPaths: string[], destination: string): Promise<void> {
  if (!virtualPaths.length) throw new Error('Не выбраны файлы в архиве');
  const first = parseArchivePath(virtualPaths[0]);
  if (!first) throw new Error('Некорректный путь внутри архива');
  const archive = path.resolve(first.archive);
  const entries = virtualPaths.map(value => {
    const parsed = parseArchivePath(value);
    if (!parsed || path.resolve(parsed.archive).toLowerCase() !== archive.toLowerCase()) throw new Error('Выбраны файлы из разных архивов');
    const inner = safeInner(parsed.inner);
    if (!inner) throw new Error('Нельзя извлечь корень архива как файл');
    return inner;
  });
  const targetDir = path.resolve(destination);
  await fsp.mkdir(targetDir, { recursive: true });
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'poscommander-extract-'));
  try {
    await runSevenZip(['x', archive, `-o${tempRoot}`, '-y', '-sccUTF-8', '--', ...entries], path.dirname(archive));
    const copies = entries.map(inner => ({
      inner,
      source: path.join(tempRoot, ...inner.split('/')),
      target: path.join(targetDir, path.posix.basename(inner)),
    }));
    for (const item of copies) {
      try {
        await fsp.lstat(item.target);
        throw new Error(`Целевой объект уже существует: ${item.target}`);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await fsp.access(item.source);
    }
    for (const item of copies) {
      const stat = await fsp.lstat(item.source);
      if (stat.isDirectory()) await fsp.cp(item.source, item.target, { recursive: true, force: false, errorOnExist: true });
      else await fsp.copyFile(item.source, item.target, fsConstants.COPYFILE_EXCL);
    }
  } finally { await fsp.rm(tempRoot, { recursive: true, force: true }); }
}

export interface StagedArchiveEntries { root: string; paths: string[] }

export interface StagedArchiveDirectory { root: string; path: string }

export async function stageArchiveDirectory(virtualDestination: string): Promise<StagedArchiveDirectory> {
  const parsed = parseArchivePath(virtualDestination);
  if (!parsed) throw new Error('Некорректный путь назначения внутри архива');
  const prefix = safeInner(parsed.inner);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'poscommander-archive-dest-'));
  try {
    const extractedRoot = path.join(root, 'contents');
    await fsp.mkdir(extractedRoot);
    const args = ['x', path.resolve(parsed.archive), `-o${extractedRoot}`, '-y', '-sccUTF-8'];
    if (prefix) args.push('--', prefix);
    await runSevenZip(args, path.dirname(path.resolve(parsed.archive)));
    const target = prefix ? path.join(extractedRoot, ...prefix.split('/')) : extractedRoot;
    await fsp.mkdir(target, { recursive: true });
    return { root, path: target };
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function addStagedDirectoryToArchive(stagedDirectory: string, virtualDestination: string): Promise<void> {
  const parsed = parseArchivePath(virtualDestination);
  if (!parsed) throw new Error('Некорректный путь назначения внутри архива');
  const args = ['a', path.resolve(parsed.archive), '-mx=5', '-r', '-sccUTF-8'];
  const prefix = safeInner(parsed.inner);
  if (prefix) args.push(`-ap${prefix}/`);
  args.push('--', '*');
  await runSevenZip(args, stagedDirectory);
}

/** Extract selected archive members to isolated temporary files for the normal operation engine. */
export async function stageArchiveEntries(virtualPaths: string[]): Promise<StagedArchiveEntries> {
  if (!virtualPaths.length) throw new Error('Не выбраны файлы в архиве');
  const first = parseArchivePath(virtualPaths[0]);
  if (!first) throw new Error('Некорректный путь внутри архива');
  const archive = path.resolve(first.archive);
  const entries = virtualPaths.map(value => {
    const parsed = parseArchivePath(value);
    if (!parsed || path.resolve(parsed.archive).toLowerCase() !== archive.toLowerCase()) throw new Error('Выбраны файлы из разных архивов');
    const inner = safeInner(parsed.inner);
    if (!inner) throw new Error('Нельзя копировать корень архива как файл');
    return inner;
  });
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'poscommander-archive-op-'));
  try {
    const extractedRoot = path.join(root, 'contents');
    const selectedRoot = path.join(root, 'selected');
    await fsp.mkdir(extractedRoot);
    await fsp.mkdir(selectedRoot);
    await runSevenZip(['x', archive, `-o${extractedRoot}`, '-y', '-sccUTF-8', '--', ...entries], path.dirname(archive));
    const paths: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const inner = entries[i];
      const source = path.join(extractedRoot, ...inner.split('/'));
      const destination = path.join(selectedRoot, String(i), path.posix.basename(inner));
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      const stat = await fsp.lstat(source);
      if (stat.isDirectory()) await fsp.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
      else await fsp.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      paths.push(destination);
    }
    return { root, paths };
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function extractArchiveFileForView(virtualPath: string): Promise<string> {
  const parsed = parseArchivePath(virtualPath);
  if (!parsed) throw new Error('Некорректный путь внутри архива');
  const inner = safeInner(parsed.inner);
  if (!inner) throw new Error('Нельзя просмотреть корень архива');
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'poscommander-view-'));
  await extractArchiveEntries([virtualPath], tempRoot);
  const extracted = path.join(tempRoot, ...inner.split('/'));
  const stat = await fsp.stat(extracted);
  if (!stat.isFile()) throw new Error('Выбранный объект не является файлом');
  return extracted;
}

export async function deleteArchiveEntries(virtualPaths: string[]): Promise<void> {
  if (!virtualPaths.length) throw new Error('Не выбраны файлы в архиве');
  const first = parseArchivePath(virtualPaths[0]);
  if (!first) throw new Error('Некорректный путь внутри архива');
  const archive = path.resolve(first.archive);
  const entries = virtualPaths.map(value => {
    const parsed = parseArchivePath(value);
    if (!parsed || path.resolve(parsed.archive).toLowerCase() !== archive.toLowerCase()) throw new Error('Выбраны файлы из разных архивов');
    return safeInner(parsed.inner);
  });
  await runSevenZip(['d', archive, '-sccUTF-8', '--', ...entries], path.dirname(archive));
}

export async function addFilesToArchive(srcs: string[], virtualDestination: string): Promise<void> {
  const parsed = parseArchivePath(virtualDestination);
  if (!parsed || !srcs.length) throw new Error('Не выбраны файлы для добавления в архив');
  const base = path.dirname(path.resolve(srcs[0]));
  const relative = srcs.map(src => path.relative(base, path.resolve(src)));
  if (relative.some(p => !p || p === '..' || p.startsWith(`..${path.sep}`) || path.isAbsolute(p))) {
    throw new Error('Для добавления в архив выбраны файлы из разных каталогов');
  }
  const prefix = safeInner(parsed.inner);
  const archive = path.resolve(parsed.archive);
  const args = ['a', archive, '-mx=5', '-sccUTF-8'];
  if (prefix) args.push(`-ap${prefix}/`);
  args.push('--', ...relative);
  await runSevenZip(args, base);
}

export async function renameArchiveEntry(virtualPath: string, newName: string): Promise<void> {
  const parsed = parseArchivePath(virtualPath);
  const oldName = parsed ? safeInner(parsed.inner) : '';
  const cleanName = newName.trim().replace(/[\\/]/g, '');
  if (!parsed || !oldName || !cleanName || cleanName === '.' || cleanName === '..') throw new Error('Некорректное имя файла');
  const parent = path.posix.dirname(oldName);
  const target = parent === '.' ? cleanName : `${parent}/${cleanName}`;
  await runSevenZip(['rn', path.resolve(parsed.archive), oldName, target, '-sccUTF-8'], path.dirname(path.resolve(parsed.archive)));
}

export async function createArchiveFolder(virtualPath: string): Promise<void> {
  const parsed = parseArchivePath(virtualPath);
  const inner = parsed ? safeInner(parsed.inner) : '';
  if (!parsed || !inner) throw new Error('Нужно указать имя новой папки внутри архива');
  const leaf = path.posix.basename(inner);
  const parent = path.posix.dirname(inner);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'poscommander-archive-'));
  try {
    await fsp.mkdir(path.join(tempRoot, leaf));
    const args = ['a', path.resolve(parsed.archive), '-sccUTF-8'];
    if (parent !== '.') args.push(`-ap${parent}/`);
    args.push('--', leaf);
    await runSevenZip(args, tempRoot);
  } finally { await fsp.rm(tempRoot, { recursive: true, force: true }); }
}

export async function createArchive(srcs: string[], archivePath: string, format: ArchiveFormat, cwd: string): Promise<void> {
  if (!srcs.length) throw new Error('Не выбраны файлы для упаковки');
  const base = path.resolve(cwd);
  const relative = srcs.map(src => path.relative(base, path.resolve(src)));
  if (relative.some(p => !p || p === '..' || p.startsWith(`..${path.sep}`) || path.isAbsolute(p))) {
    throw new Error('Для архивации выбраны файлы из другого каталога');
  }
  for (const src of srcs) await fsp.access(src);
  const target = path.resolve(archivePath);
  if (srcs.some(src => path.resolve(src).toLowerCase() === target.toLowerCase())) {
    throw new Error('Архив не может перезаписать исходный файл');
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await runSevenZip(['a', `-t${format}`, '-mx=5', target, '--', ...relative], base);
}

export async function extractArchives(archives: string[], destination: string): Promise<void> {
  if (!archives.length) throw new Error('Не выбраны архивы для распаковки');
  const target = path.resolve(destination);
  await fsp.mkdir(target, { recursive: true });
  for (const archive of archives) {
    await fsp.access(archive);
    await runSevenZip(['x', path.resolve(archive), `-o${target}`, '-aos', '-y'], path.dirname(path.resolve(archive)));
  }
}

export function isArchivePath(filePath: string): boolean {
  return /\.(zip|7z|tar|gz|tgz|bz2|xz|wim|iso|cab|rar)$/i.test(filePath);
}
