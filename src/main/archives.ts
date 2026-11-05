import * as path from 'path';
import * as fsp from 'fs/promises';
import { spawn } from 'child_process';
import { path7za } from '7zip-bin';

export type ArchiveFormat = 'zip' | '7z' | 'tar';

function sevenZipPath(): string {
  return path7za.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function runSevenZip(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZipPath(), args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-12000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0 || code === 1) resolve();
      else reject(new Error(output.trim() || `7-Zip завершился с кодом ${code ?? 'unknown'}`));
    });
  });
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
