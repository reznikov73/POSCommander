import { Entry } from './types.js';

export const ROW_H = 18; // высота строки списка TC, px

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

export function naturalCmp(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Человекочитаемый размер: 0, 12 КБ, 3.4 МБ ... */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${Math.round(n)} байт`;
  const units = ['Кб', 'Мб', 'Гб', 'Тб', 'Пб'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const amount = v.toFixed(1).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return amount + ' ' + units[u];
}

/** Дата в формате ТС: дд.мм.гг чч:мм */
export function fmtDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x: number, w = 2) => String(x).padStart(w, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${p(d.getFullYear() % 100)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Канонический вид пути: без завершающего \, кроме корней дисков (C:\) */
export function normalizePath(p: string): string {
  let r = p.trim().replace(/\//g, '\\');
  while (r.length > 1 && r.endsWith('\\')) r = r.slice(0, -1);
  if (/^[a-zA-Z]:$/.test(r)) r += '\\';
  return r;
}

/** Корень диска (C:\) или корень UNC-шары (\\server\share) */
export function isRoot(p: string): boolean {
  const n = normalizePath(p);
  return /^[a-zA-Z]:\\$/.test(n) || /^\\\\[^\\]+\\[^\\]+$/.test(n);
}

/** Родительский путь; для корня диска возвращает сам корень */
export function parentOf(p: string): string {
  const norm = normalizePath(p);
  if (/^[a-zA-Z]:\\$/.test(norm)) return norm;
  const idx = norm.lastIndexOf('\\');
  if (idx <= 2) return norm.slice(0, 2) + '\\';
  return norm.slice(0, idx);
}

export function joinPath(a: string, b: string): string {
  const na = normalizePath(a);
  return na.endsWith('\\') ? na + b : na + '\\' + b;
}

export function basename(p: string): string {
  const n = normalizePath(p);
  const idx = n.lastIndexOf('\\');
  return idx === -1 ? n : n.slice(idx + 1);
}

/** Расширение без точки; для имён вида ".gitignore" расширения нет */
export function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx <= 0 ? '' : name.slice(idx + 1).toLowerCase();
}

const ICONS: Record<string, string> = {
  txt: '📄', md: '📄', log: '📄', ini: '📄', cfg: '📄', pdf: '📕',
  zip: '📦', rar: '📦', '7z': '📦', gz: '📦', tar: '📦', bz2: '📦', cab: '📦', iso: '📀',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', bmp: '🖼️', webp: '🖼️', ico: '🖼️', svg: '🖼️',
  mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵', mid: '🎵',
  mp4: '🎬', avi: '🎬', mkv: '🎬', mov: '🎬', wmv: '🎬',
  js: '📜', ts: '📜', py: '📜', c: '📜', cpp: '📜', h: '📜', cs: '📜', java: '📜',
  html: '📜', css: '📜', json: '📜', xml: '📜', bat: '📜', cmd: '📜', ps1: '📜',
  exe: '⚙️', msi: '⚙️', dll: '⚙️', com: '⚙️',
  doc: '📘', docx: '📘', rtf: '📘',
  xls: '📗', xlsx: '📗', csv: '📗',
};

export function iconFor(e: Entry): string {
  if (e.isDir) return '📁';
  return ICONS[extOf(e.name)] ?? '📄';
}

export function extGroup(name: string): string {
  return extOf(name);
}
