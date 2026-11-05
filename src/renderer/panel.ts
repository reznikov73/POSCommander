import { Entry, Drive, SortBy } from './types.js';
import { ROW_H, fmtBytes, fmtDate, naturalCmp, parentOf, joinPath, isRoot, normalizePath, iconFor, extOf } from './util.js';

export interface PanelSort { by: SortBy; asc: boolean }

const SORT_LABELS: Record<SortBy, string> = { name: 'Имя', ext: 'Расш.', size: 'Размер', date: 'Дата' };
const PARENT_FOLDER_ICON = '<svg class="parent-folder-icon" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M1 3.5h5l1.4 1.7H15v8.2H1z" fill="#d8d8d8" stroke="#777" />' +
  '<path d="M8 12V7.5M6.1 9.4 8 7.5l1.9 1.9" fill="none" stroke="#333" stroke-width="1.2" stroke-linecap="square" />' +
  '</svg>';

/**
 * Одна панель файлового списка: заголовок с диском и путём,
 * шапка сортировки, прокручиваемый список, выделение и курсор.
 */
export class Panel {
  path = 'C:\\';
  entries: Entry[] = [];
  sorted: Entry[] = [];
  sel = new Set<string>();
  cursor = 0;              // индекс в видимом списке (0 — это "..", если он есть)
  sort: PanelSort = { by: 'name', asc: true };
  error = '';
  free = 0;
  total = 0;
  drives: Drive[] = [];
  onStatus: () => void = () => {};

  private listEl: HTMLElement;
  private pathInput: HTMLInputElement;
  private pathHistoryEl: HTMLDataListElement;
  private pathHistory: string[] = [];
  private directorySizes = new Map<string, number>();
  private pendingDirectorySizes = new Set<string>();
  private iconRequestVersion = 0;
  private driveBtn: HTMLButtonElement;
  private driveStrip: HTMLElement;
  private tabStrip: HTMLElement;
  private tabs: string[] = ['C:\\'];
  private activeTab = 0;
  private navigationVersion = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private headerRow: HTMLElement;
  private anchor = -1;     // якорь выделения для Shift+клик

  constructor(
    public readonly idx: 0 | 1,
    container: HTMLElement,
    private hooks: {
      open: (panel: Panel, e: Entry) => void;
      driveMenu: (panel: Panel, anchor: HTMLElement) => void;
      activate: (panel: Panel) => void;
      statusChanged: () => void;
    },
  ) {
    container.classList.add('panel');
    container.innerHTML = `
      <div class="drive-strip"></div>
      <div class="tab-strip"></div>
      <div class="panel-head">
        <button class="drive-btn" title="Сменить диск (Alt+F${idx + 1})">?</button>
        <input class="path-input" list="path-history-${idx}" spellcheck="false" autocomplete="on" />
        <datalist id="path-history-${idx}"></datalist>
        <button class="reread-btn" title="Перечитать (Ctrl+R)">⟳</button>
      </div>
      <div class="columns">
        <span class="c-icon"></span>
        <span class="c-name" data-sort="name">Имя</span>
        <span class="c-ext" data-sort="ext">Тип</span>
        <span class="c-size" data-sort="size">Размер</span>
        <span class="c-date" data-sort="date">Дата</span>
      </div>
      <div class="list" tabindex="-1"></div>`;
    this.driveBtn = container.querySelector('.drive-btn')!;
    this.driveStrip = container.querySelector('.drive-strip')!;
    this.tabStrip = container.querySelector('.tab-strip')!;
    this.pathInput = container.querySelector('.path-input')!;
    this.pathHistoryEl = container.querySelector(`#path-history-${idx}`)!;
    this.listEl = container.querySelector('.list')!;
    this.headerRow = container.querySelector('.columns')!;

    this.driveBtn.addEventListener('click', () => { this.hooks.activate(this); this.hooks.driveMenu(this, this.driveBtn); });
    this.renderTabs();
    container.querySelector('.reread-btn')!.addEventListener('click', () => { this.hooks.activate(this); void this.refresh(); });
    this.headerRow.addEventListener('click', (ev) => {
      this.hooks.activate(this);
      const el = (ev.target as HTMLElement).closest('[data-sort]') as HTMLElement | null;
      if (!el) return;
      const by = el.dataset.sort as SortBy;
      if (this.sort.by === by) this.sort.asc = !this.sort.asc;
      else this.sort = { by, asc: true };
      this.sortEntries();
      this.cursor = 0;
      this.render();
      this.hooks.statusChanged();
    });

    this.pathInput.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        void this.setPath(this.pathInput.value).then(ok => {
          if (!ok) this.pathInput.value = this.path;
        });
      } else if (ev.key === 'Escape') {
        this.pathInput.value = this.path;
        this.pathInput.blur();
      }
    });
    this.pathInput.addEventListener('focus', () => { this.hooks.activate(this); this.pathInput.select(); });
    this.loadPathHistory();

    // мышь
    this.listEl.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      this.hooks.activate(this);
      const row = (ev.target as HTMLElement).closest('.row') as HTMLElement | null;
      if (!row) return;
      const i = Number(row.dataset.i);
      const entry = this.visible()[i];
      if (!entry) return;
      this.cursor = i;
      if (ev.ctrlKey || ev.metaKey) {
        if (this.sel.has(entry.name)) this.sel.delete(entry.name);
        else this.sel.add(entry.name);
        this.anchor = i;
      } else if (ev.shiftKey) {
        this.selectRange(this.anchor >= 0 ? this.anchor : i);
      } else {
        this.anchor = i;
      }
      // Не заменяем DOM строки на mousedown: иначе браузер теряет dblclick target.
      this.syncRowStates();
      this.requestSelectedDirectorySizes();
      this.scrollCursorIntoView();
      this.hooks.statusChanged();
    });
    this.listEl.addEventListener('dblclick', (ev) => {
      const row = (ev.target as HTMLElement).closest('.row') as HTMLElement | null;
      if (!row) return;
      const entry = this.visible()[Number(row.dataset.i)];
      if (entry) this.hooks.open(this, entry);
    });
  }

  /** Видимый список: ".." сверху (вне корня) + отсортированные записи */
  visible(): Entry[] {
    const dotdot: Entry[] = isRoot(this.path) ? [] : [{ name: '..', isDir: true, size: 0, mtime: 0 }];
    return dotdot.concat(this.sorted);
  }

  private sortEntries(): void {
    const dirs = this.entries.filter(e => e.isDir);
    const files = this.entries.filter(e => !e.isDir);
    const cmpName = (a: Entry, b: Entry) => naturalCmp(a.name, b.name);
    const byExt = (a: Entry, b: Entry) => naturalCmp(extOf(a.name), extOf(b.name)) || cmpName(a, b);
    const cmp: Record<SortBy, (a: Entry, b: Entry) => number> = {
      name: cmpName,
      ext: byExt,
      size: (a, b) => a.size - b.size || cmpName(a, b),
      date: (a, b) => a.mtime - b.mtime || cmpName(a, b),
    };
    const f = cmp[this.sort.by];
    const dir = this.sort.asc ? 1 : -1;
    dirs.sort((a, b) => dir * f(a, b));
    files.sort((a, b) => dir * f(a, b));
    this.sorted = dirs.concat(files);
  }

  private loadPathHistory(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(`poscommander.pathHistory.${this.idx}`) || '[]');
      if (Array.isArray(saved)) this.pathHistory = saved.filter((x): x is string => typeof x === 'string').slice(0, 50);
    } catch { this.pathHistory = []; }
    this.renderPathHistory();
  }

  private rememberPath(path: string): void {
    this.pathHistory = [path, ...this.pathHistory.filter(p => p.toLowerCase() !== path.toLowerCase())].slice(0, 50);
    try { localStorage.setItem(`poscommander.pathHistory.${this.idx}`, JSON.stringify(this.pathHistory)); } catch { /* ignore */ }
    this.renderPathHistory();
  }

  private renderPathHistory(): void {
    this.pathHistoryEl.replaceChildren(...this.pathHistory.map(path => {
      const option = document.createElement('option'); option.value = path; return option;
    }));
  }

  async refresh(): Promise<void> {
    const version = ++this.navigationVersion;
    const requestedPath = this.path;
    const keepCursorName = this.visible()[this.cursor]?.name;
    const res = await window.pos.list(requestedPath);
    if (version !== this.navigationVersion) return;
    if (res.error) {
      this.error = res.error;
      this.entries = [];
    } else {
      this.error = '';
      this.entries = res.entries;
      if (res.path) this.path = normalizePath(res.path);
    }
    this.pathInput.value = this.path;
    this.rememberPath(this.path);
    // убираем из выделения исчезнувшие имена
    const names = new Set(this.entries.map(e => e.name));
    for (const n of Array.from(this.sel)) if (!names.has(n)) this.sel.delete(n);
    this.sortEntries();
    this.directorySizes.clear();
    this.pendingDirectorySizes.clear();
    // курсор: на прежнее имя, иначе на первое место
    const vis = this.visible();
    let idx = vis.findIndex(e => e.name === keepCursorName);
    if (idx < 0) idx = 0;
    this.cursor = idx;
    this.render();
    this.loadFileIcons();
    this.updateDriveButton();
    void this.loadFree();
    this.hooks.statusChanged();
  }

  async setPath(p: string, trackHistory = true): Promise<boolean> {
    const np = this.resolvePathInput(p);
    const version = ++this.navigationVersion;
    const res = await window.pos.list(np);
    if (version !== this.navigationVersion) return false;
    if (res.error) {
      this.error = res.error;
      this.hooks.statusChanged();
      return false;
    }
    const previous = this.path;
    this.path = normalizePath(res.path || np);
    this.tabs[this.activeTab] = this.path;
    this.rememberPath(this.path);
    if (trackHistory && previous !== np) {
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(this.path);
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex >= 0) {
      const hit = this.history.lastIndexOf(this.path);
      if (hit >= 0) this.historyIndex = hit;
    }
    this.sel.clear();
    this.anchor = -1;
    this.error = '';
    this.entries = res.entries;
    this.directorySizes.clear();
    this.pendingDirectorySizes.clear();
    this.pathInput.value = this.path;
    this.sortEntries();
    this.cursor = 0;
    this.render();
    this.loadFileIcons();
    this.updateDriveButton();
    void this.loadFree();
    this.hooks.statusChanged();
    return true;
  }

  resolvePathInput(input: string): string {
    const raw = input.trim().replace(/\//g, '\\');
    if (!raw) return this.path;
    if (/^[a-zA-Z]:$/.test(raw)) return raw + '\\';
    if (/^[a-zA-Z]:\\/.test(raw) || raw.startsWith('\\\\')) return normalizePath(raw);
    const parts = raw.startsWith('\\')
      ? [this.path.slice(0, 2)]
      : this.path.split('\\').filter(Boolean);
    const tail = raw.replace(/^\\+/, '').split('\\');
    for (const part of tail) {
      if (!part || part === '.') continue;
      if (part === '..') { if (parts.length > 1) parts.pop(); }
      else parts.push(part);
    }
    return normalizePath(parts.join('\\'));
  }

  goUp(): void {
    if (!isRoot(this.path)) void this.setPath(parentOf(this.path));
  }

  goHistory(delta: -1 | 1): void {
    const next = this.historyIndex + delta;
    if (next < 0 || next >= this.history.length || next === this.historyIndex) return;
    const old = this.historyIndex;
    this.historyIndex = next;
    void this.setPath(this.history[next], false).then(ok => {
      if (!ok) this.historyIndex = old;
    });
  }

  newTab(): void {
    this.tabs.splice(this.activeTab + 1, 0, this.path);
    this.activeTab++;
    this.renderTabs();
  }

  private async loadFree(): Promise<void> {
    const r = await window.pos.statfs(this.path);
    this.free = r.free;
    this.total = r.total;
    this.hooks.statusChanged();
  }

  updateDriveButton(): void {
    const letter = this.path.slice(0, 2).toUpperCase();
    const drv = this.drives.find(d => d.letter === letter);
    this.driveBtn.textContent = drv ? (drv.label ? `${letter} ${drv.label}` : letter) : (letter + '?');
    this.renderTabs();
    this.driveStrip.textContent = '';
    for (const d of this.drives) {
      const b = document.createElement('button');
      b.className = 'drive-letter' + (d.letter === letter ? ' selected' : '');
      b.textContent = d.letter.slice(0, 1).toLowerCase();
      b.title = `${d.letter} ${d.label || d.type} · свободно ${fmtBytes(d.free)} из ${fmtBytes(d.total)}`;
      b.addEventListener('click', () => { this.hooks.activate(this); void this.setPath(d.root); });
      this.driveStrip.appendChild(b);
    }
  }

  private renderTabs(): void {
    this.tabStrip.textContent = '';
    this.tabs.forEach((tabPath, i) => {
      const b = document.createElement('button');
      b.className = 'path-tab' + (i === this.activeTab ? ' active' : '');
      b.textContent = tabPath.split('\\').filter(Boolean).pop() || tabPath;
      b.title = tabPath;
      b.addEventListener('click', () => { this.hooks.activate(this); this.activeTab = i; void this.setPath(tabPath); });
      this.tabStrip.appendChild(b);
    });
    const add = document.createElement('button');
    add.className = 'tab-new'; add.textContent = '+'; add.title = 'Новая вкладка';
    add.addEventListener('click', () => this.newTab());
    this.tabStrip.appendChild(add);
  }

  render(): void {
    const vis = this.visible();
    this.listEl.textContent = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < vis.length; i++) {
      const e = vis[i];
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.i = String(i);
      if (i === this.cursor) row.classList.add('cursor');
      const dotdot = e.name === '..';
      const selected = !dotdot && this.sel.has(e.name);
      const hidden = e.name.startsWith('.') || (e.name.startsWith('$') && !e.isDir);
      if (selected) row.classList.add('sel');
      if (hidden) row.classList.add('hidden');
      if (dotdot) row.classList.add('dotdot');
      const typeTxt = e.isDir ? '' : escapeHtml(extOf(e.name).toUpperCase());
      const sizeTxt = e.isDir ? '&lt;Папка&gt;' : fmtBytes(e.size);
      row.innerHTML = `
        <span class="c-icon">${dotdot ? PARENT_FOLDER_ICON : this.iconHtml(e)}</span>
        <span class="c-name${e.isDir ? ' isdir' : ''}" title="${escapeAttr(e.name)}">${escapeHtml(e.name)}</span>
        <span class="c-ext">${typeTxt}</span>
        <span class="c-size">${sizeTxt}</span>
        <span class="c-date">${dotdot ? '' : fmtDate(e.mtime)}</span>`;
      frag.appendChild(row);
    }
    this.listEl.appendChild(frag);
    this.updateDirectorySizeCells();
    this.updateSortHeader();
    this.scrollCursorIntoView();
  }

  private syncRowStates(): void {
    const vis = this.visible();
    for (let i = 0; i < this.listEl.children.length; i++) {
      const row = this.listEl.children[i] as HTMLElement;
      const entry = vis[i];
      row.classList.toggle('cursor', i === this.cursor);
      row.classList.toggle('sel', !!entry && entry.name !== '..' && this.sel.has(entry.name));
    }
    this.updateDirectorySizeCells();
  }

  private iconHtml(e: Entry): string {
    return e.icon
      ? `<img src="${escapeAttr(e.icon)}" alt="" />`
      : escapeHtml(iconFor(e));
  }

  private async loadFileIcons(): Promise<void> {
    const version = ++this.iconRequestVersion;
    const paths = this.entries.map(e => joinPath(this.path, e.name));
    if (!paths.length) return;
    const icons = await window.pos.fileIcons(paths).catch(() => []);
    if (version !== this.iconRequestVersion) return;
    for (let i = 0; i < Math.min(icons.length, this.entries.length); i++) {
      this.entries[i].icon = icons[i];
      const visibleIndex = this.visible().findIndex(e => e.name === this.entries[i].name);
      const iconCell = this.listEl.children[visibleIndex]?.querySelector('.c-icon');
      if (iconCell) iconCell.innerHTML = this.iconHtml(this.entries[i]);
    }
  }

  private async requestDirectorySize(entry: Entry): Promise<void> {
    if (!entry.isDir || this.directorySizes.has(entry.name) || this.pendingDirectorySizes.has(entry.name)) return;
    this.pendingDirectorySizes.add(entry.name);
    this.updateDirectorySizeCells();
    const directoryPath = this.path;
    const fullPath = joinPath(directoryPath, entry.name);
    const size = await window.pos.directorySize(fullPath).catch(() => 0);
    this.pendingDirectorySizes.delete(entry.name);
    if (this.path !== directoryPath) return;
    this.directorySizes.set(entry.name, size);
    this.updateDirectorySizeCells();
    this.hooks.statusChanged();
  }

  private requestSelectedDirectorySizes(): void {
    for (const e of this.sorted) if (e.isDir && this.sel.has(e.name)) void this.requestDirectorySize(e);
  }

  private updateDirectorySizeCells(): void {
    const visible = this.visible();
    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i];
      if (!entry.isDir) continue;
      const cell = this.listEl.children[i]?.querySelector('.c-size');
      if (!cell) continue;
      if (this.sel.has(entry.name)) {
        cell.textContent = this.directorySizes.has(entry.name)
          ? fmtBytes(this.directorySizes.get(entry.name)!)
          : this.pendingDirectorySizes.has(entry.name) ? '…' : '<Папка>';
      } else cell.textContent = '<Папка>';
    }
  }

  private updateSortHeader(): void {
    for (const el of Array.from(this.headerRow.querySelectorAll('[data-sort]'))) {
      const by = (el as HTMLElement).dataset.sort;
      el.classList.toggle('sorted', by === this.sort.by);
      if (by === this.sort.by) {
        (el as HTMLElement).dataset.dir = this.sort.asc ? 'asc' : 'desc';
      }
    }
  }

  scrollCursorIntoView(): void {
    const row = this.listEl.children[this.cursor] as HTMLElement | undefined;
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + ROW_H;
    if (top < this.listEl.scrollTop) this.listEl.scrollTop = top;
    else if (bottom > this.listEl.scrollTop + this.listEl.clientHeight) {
      this.listEl.scrollTop = bottom - this.listEl.clientHeight;
    }
  }

  // ---------- Навигация курсором ----------

  pageRows(): number {
    return Math.max(1, Math.floor(this.listEl.clientHeight / ROW_H) - 1);
  }

  moveCursor(delta: number, select: boolean): void {
    const vis = this.visible();
    const target = Math.min(vis.length - 1, Math.max(0, this.cursor + delta));
    if (select) {
      const from = Math.min(this.cursor, target);
      const to = Math.max(this.cursor, target);
      for (let i = from; i <= to; i++) {
        if (!vis[i].name.startsWith('..')) this.sel.add(vis[i].name);
      }
    }
    this.cursor = target;
    this.anchor = target;
    this.render();
    this.hooks.statusChanged();
  }

  cursorHomeEnd(end: boolean): void {
    this.cursor = end ? this.visible().length - 1 : 0;
    this.render();
    this.hooks.statusChanged();
  }

  /** Insert: переключает выделение и сдвигает курсор (как в ТС) */
  toggleSelectAndMove(): void {
    const e = this.visible()[this.cursor];
    if (e && !e.name.startsWith('..')) {
      this.toggleSelect(e, true);
      this.requestSelectedDirectorySizes();
    }
    this.moveCursor(1, false);
  }

  toggleSelect(e: Entry, advance: boolean): void {
    if (this.sel.has(e.name)) this.sel.delete(e.name);
    else this.sel.add(e.name);
    if (!advance) {
      this.render();
      this.hooks.statusChanged();
    }
  }

  selectAll(): void {
    for (const e of this.sorted) this.sel.add(e.name);
    this.render();
    this.hooks.statusChanged();
  }

  clearSelection(): void {
    if (this.sel.size === 0) return;
    this.sel.clear();
    this.render();
    this.hooks.statusChanged();
  }

  invertSelection(): void {
    for (const e of this.sorted) {
      if (this.sel.has(e.name)) this.sel.delete(e.name);
      else this.sel.add(e.name);
    }
    this.render();
    this.hooks.statusChanged();
  }

  /** Выделение по расширению текущего файла: mode '+', '-' или '*' */
  selectByExt(mode: '+' | '-' | '*'): void {
    const cur = this.visible()[this.cursor];
    const ext = cur && !cur.isDir ? extOf(cur.name) : null;
    if (mode === '*') { this.invertSelection(); return; }
    if (ext === null) return;
    for (const e of this.sorted) {
      if (e.isDir) continue;
      if (extOf(e.name) === ext) {
        if (mode === '+') this.sel.add(e.name);
        else this.sel.delete(e.name);
      }
    }
    this.render();
    this.hooks.statusChanged();
  }

  selectRange(fromIdx: number): void {
    const vis = this.visible();
    const from = Math.min(fromIdx, this.cursor);
    const to = Math.max(fromIdx, this.cursor);
    for (let i = from; i <= to; i++) {
      if (vis[i] && !vis[i].name.startsWith('..')) this.sel.add(vis[i].name);
    }
  }

  /** Пути выделенных; без выделения — текущий под курсором (как в ТС) */
  selectedPaths(): string[] {
    if (this.sel.size > 0) {
      return this.sorted.filter(e => this.sel.has(e.name)).map(e => joinPath(this.path, e.name));
    }
    const cur = this.visible()[this.cursor];
    if (cur && !cur.name.startsWith('..')) return [joinPath(this.path, cur.name)];
    return [];
  }

  /** Одиночный путь для переименования/просмотра */
  currentPath(): string | null {
    const cur = this.visible()[this.cursor];
    if (!cur || cur.name.startsWith('..')) return null;
    return joinPath(this.path, cur.name);
  }

  /** Кнопка выбора диска (для позиционирования меню) */
  driveBtnEl(): HTMLElement {
    return this.driveBtn;
  }

  countSummary(): { dirs: number; files: number; bytes: number } {
    let dirs = 0, files = 0, bytes = 0;
    for (const e of this.sorted) {
      if (e.isDir) dirs++;
      else { files++; bytes += e.size; }
    }
    return { dirs, files, bytes };
  }

  selectedSummary(): { files: number; bytes: number } | null {
    if (this.sel.size === 0) return null;
    let files = 0, bytes = 0;
    for (const e of this.sorted) {
      if (this.sel.has(e.name) && !e.isDir) { files++; bytes += e.size; }
    }
    return { files, bytes };
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s);
}

export { SORT_LABELS };
