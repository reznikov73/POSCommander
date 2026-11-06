import { Entry, Drive, SortBy } from './types.js';
import { ROW_H, fmtBytes, fmtDate, naturalCmp, parentOf, joinPath, isRoot, normalizePath, iconFor, extOf, archivePathParts, archiveRootPath, basename, displayPath } from './util.js';

export interface PanelSort { by: SortBy; asc: boolean }

const SORT_LABELS: Record<SortBy, string> = { name: 'Имя', ext: 'Расш.', size: 'Размер', date: 'Дата' };
const FOLDER_ICON = '<svg class="folder-icon" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M1 3.1h5l1.5 1.7H15v8.1H1z" fill="#e8ad27" stroke="#9a741b" stroke-width=".8" />' +
  '<path d="M1.5 5.4h13l-1 6.8H1.5z" fill="#ffd765" stroke="#c19225" stroke-width=".6" />' +
  '<path d="M2 6h11.8" stroke="#fff0ae" stroke-width=".7" />' +
  '</svg>';
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
  private maskSelect: HTMLSelectElement;
  private fileMask = '*.*';
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
      <div class="drive-info-row"><button class="drive-btn" title="Сменить диск (Alt+F${idx + 1})">?</button></div>
      <div class="tab-strip"></div>
      <div class="panel-head">
        <input class="path-input" list="path-history-${idx}" spellcheck="false" autocomplete="on" />
        <datalist id="path-history-${idx}"></datalist>
        <select class="mask-select" title="Маска файлов">
          <option value="*.*">*</option><option value="*.txt">*.txt</option>
          <option value="*.exe">*.exe</option><option value="*.zip">*.zip</option><option value="*.pdf">*.pdf</option>
        </select>
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
    this.maskSelect = container.querySelector('.mask-select')!;
    this.pathHistoryEl = container.querySelector(`#path-history-${idx}`)!;
    this.listEl = container.querySelector('.list')!;
    this.headerRow = container.querySelector('.columns')!;

    this.driveBtn.addEventListener('click', () => { this.hooks.activate(this); this.hooks.driveMenu(this, this.driveBtn); });
    this.maskSelect.addEventListener('change', () => {
      this.fileMask = this.maskSelect.value || '*.*';
      this.pathInput.value = this.pathInputText();
      this.sel.clear();
      this.sortEntries(); this.render(); this.hooks.statusChanged();
    });
    this.loadTabs();
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
        const raw = this.pathInput.value.trim();
        const normalized = raw.replace(/\//g, '\\');
        const lastSlash = normalized.lastIndexOf('\\');
        const leaf = normalized.slice(lastSlash + 1);
        const hasMask = /[*?]/.test(leaf);
        const target = hasMask ? (lastSlash < 0 ? this.path : normalized.slice(0, lastSlash) || normalized) : raw;
        this.fileMask = hasMask ? leaf : '*.*';
        this.maskSelect.value = this.fileMask;
        void this.setPath(target).then(ok => {
          if (!ok) this.pathInput.value = this.pathInputText();
          else { this.sortEntries(); this.render(); this.hooks.statusChanged(); }
        });
      } else if (ev.key === 'Escape') {
        this.pathInput.value = this.pathInputText();
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
    const files = this.entries.filter(e => !e.isDir && this.matchesMask(e.name));
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

  private matchesMask(name: string): boolean {
    const masks = this.fileMask.split(';').map(mask => mask.trim()).filter(Boolean);
    if (!masks.length || masks.some(mask => mask === '*.*' || mask === '*')) return true;
    return masks.some(mask => {
      const source = mask.split('').map(char => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
      return new RegExp(`^${source}$`, 'i').test(name);
    });
  }

  private pathInputText(): string {
    const path = displayPath(this.path);
    return `${path.endsWith('\\') ? path : path + '\\'}${this.fileMask}`;
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
      const option = document.createElement('option'); option.value = displayPath(path); return option;
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
    this.pathInput.value = this.pathInputText();
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
    this.saveTabs();
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
    this.pathInput.value = this.pathInputText();
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
    if (input.trim().startsWith('archive://')) return normalizePath(input.trim());
    const raw = input.trim().replace(/\//g, '\\');
    if (!raw) return this.path;
    const archive = archivePathParts(this.path);
    if (archive) {
      const archiveRoot = archive.archive.replace(/\//g, '\\').replace(/\\+$/g, '');
      if (raw.toLowerCase() === archiveRoot.toLowerCase()) return archiveRootPath(archive.archive);
      if (raw.toLowerCase().startsWith(archiveRoot.toLowerCase() + '\\')) {
        return archiveRootPath(archive.archive) + raw.slice(archiveRoot.length + 1).replace(/\\/g, '/');
      }
    }
    const archiveInput = /^(.+\.(?:zip|7z|tar|gz|tgz|bz2|xz|wim|iso|cab|rar))(?:\\(.*))?$/i.exec(raw);
    if (archiveInput) return archiveRootPath(archiveInput[1]) + (archiveInput[2] ?? '').replace(/\\/g, '/');
    if (/^[a-zA-Z]:$/.test(raw)) return raw + '\\';
    if (/^[a-zA-Z]:\\/.test(raw) || raw.startsWith('\\\\')) return normalizePath(raw);
    if (archive) {
      const parts = raw.startsWith('\\') ? [] : archive.inner.split('/').filter(Boolean);
      for (const part of raw.replace(/^\\+/, '').split('\\')) {
        if (!part || part === '.') continue;
        if (part === '..') parts.pop();
        else parts.push(part);
      }
      return archiveRootPath(archive.archive) + parts.join('/');
    }
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
    const archive = archivePathParts(this.path);
    if (archive && !archive.inner) void this.setPath(parentOf(archive.archive));
    else if (!isRoot(this.path)) void this.setPath(parentOf(this.path));
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
    this.openTabInNew(this.path);
  }

  private openTabInNew(path: string): void {
    this.tabs.splice(this.activeTab + 1, 0, this.path);
    this.activeTab++;
    this.tabs[this.activeTab] = path;
    this.saveTabs();
    this.renderTabs();
    if (path !== this.path) void this.setPath(path, false);
  }

  private loadTabs(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(`poscommander.tabs.${this.idx}`) || 'null');
      if (!saved || !Array.isArray(saved.tabs)) return;
      const tabs = saved.tabs.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0);
      if (tabs.length) this.tabs = tabs.map(normalizePath);
      this.activeTab = Math.max(0, Math.min(this.tabs.length - 1, Number(saved.activeTab) || 0));
    } catch { this.tabs = ['C:\\']; this.activeTab = 0; }
  }

  private saveTabs(): void {
    try { localStorage.setItem(`poscommander.tabs.${this.idx}`, JSON.stringify({ tabs: this.tabs, activeTab: this.activeTab })); }
    catch { /* storage can be disabled */ }
  }

  private closeTab(index: number): void {
    if (this.tabs.length === 1) {
      this.tabs[0] = this.path;
      this.activeTab = 0;
      this.saveTabs();
      this.renderTabs();
      return;
    }
    const wasActive = index === this.activeTab;
    this.tabs.splice(index, 1);
    if (index < this.activeTab) this.activeTab--;
    else if (wasActive) this.activeTab = Math.max(0, index - 1);
    this.saveTabs();
    this.renderTabs();
    if (wasActive) void this.setPath(this.tabs[this.activeTab], false);
  }

  closeActiveTab(): void { this.closeTab(this.activeTab); }

  private closeOtherTabs(index: number): void {
    const keep = this.tabs[index];
    this.tabs = [keep];
    this.activeTab = 0;
    this.saveTabs(); this.renderTabs();
    if (this.path !== keep) void this.setPath(keep, false);
  }

  private reorderTab(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.tabs.length || to >= this.tabs.length) return;
    const [value] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, value);
    if (this.activeTab === from) this.activeTab = to;
    else if (from < this.activeTab && to >= this.activeTab) this.activeTab--;
    else if (from > this.activeTab && to <= this.activeTab) this.activeTab++;
    this.saveTabs(); this.renderTabs();
  }

  private showTabContextMenu(index: number, x: number, y: number): void {
    document.querySelector('.tab-context-menu')?.remove();
    const tabPath = this.tabs[index];
    const menu = document.createElement('div');
    menu.className = 'tab-context-menu';
    const actions: Array<[string, () => void]> = [
      ['Новая вкладка', () => this.openTabInNew(this.path)],
      ['Открыть эту папку в новой вкладке', () => this.openTabInNew(tabPath)],
      ['Закрыть вкладку', () => this.closeTab(index)],
      ['Закрыть остальные вкладки', () => this.closeOtherTabs(index)],
    ];
    for (const [label, action] of actions) {
      const item = document.createElement('button'); item.type = 'button'; item.textContent = label;
      item.addEventListener('click', () => { menu.remove(); action(); });
      menu.appendChild(item);
    }
    menu.style.left = `${Math.min(x, window.innerWidth - 240)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 150)}px`;
    document.body.appendChild(menu);
    const close = (event: MouseEvent) => {
      if (!menu.contains(event.target as Node)) { menu.remove(); document.removeEventListener('mousedown', close, true); }
    };
    document.addEventListener('mousedown', close, true);
  }

  private async loadFree(): Promise<void> {
    const r = await window.pos.statfs(this.path);
    this.free = r.free;
    this.total = r.total;
    this.updateDriveButton();
    this.hooks.statusChanged();
  }

  updateDriveButton(): void {
    const archive = archivePathParts(this.path);
    const letter = (archive?.archive.slice(0, 2) ?? this.path.slice(0, 2)).toUpperCase();
    const drv = this.drives.find(d => d.letter === letter);
    const label = drv?.label ? `[${drv.label}]` : `[${letter}]`;
    this.driveBtn.textContent = this.total > 0
      ? `${label} ${fmtBytes(this.free)} из ${fmtBytes(this.total)} свободно`
      : `${label} · сведения о диске загружаются`;
    this.driveBtn.title = `${label} · свободно ${fmtBytes(this.free)} из ${fmtBytes(this.total)}. Нажмите, чтобы сменить диск.`;
    this.renderTabs();
    this.driveStrip.textContent = '';
    for (const d of this.drives) {
      const b = document.createElement('button');
      b.className = 'drive-letter' + (d.letter === letter ? ' selected' : '');
      b.innerHTML = `<span class="drive-icon" aria-hidden="true"></span><span>${d.letter.slice(0, 1).toLowerCase()}</span>`;
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
      b.title = displayPath(tabPath);
      const icon = document.createElement('span');
      icon.className = 'tab-folder-icon';
      icon.innerHTML = FOLDER_ICON;
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = this.tabLabel(tabPath);
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Закрыть вкладку';
      close.addEventListener('click', ev => { ev.stopPropagation(); this.hooks.activate(this); this.closeTab(i); });
      b.append(icon, label, close);
      b.addEventListener('click', () => {
        this.hooks.activate(this);
        if (this.activeTab === i && this.path === tabPath) return;
        const previous = this.activeTab;
        this.activeTab = i;
        this.saveTabs();
        void this.setPath(tabPath, false).then(ok => {
          if (!ok) { this.activeTab = previous; this.saveTabs(); this.renderTabs(); }
        });
      });
      b.addEventListener('auxclick', ev => { if (ev.button === 1) this.closeTab(i); });
      b.addEventListener('contextmenu', ev => {
        ev.preventDefault(); this.hooks.activate(this); this.showTabContextMenu(i, ev.clientX, ev.clientY);
      });
      b.draggable = true;
      b.addEventListener('dragstart', ev => {
        ev.dataTransfer?.setData('text/plain', String(i));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
        b.classList.add('dragging');
      });
      b.addEventListener('dragend', () => b.classList.remove('dragging'));
      b.addEventListener('dragover', ev => { ev.preventDefault(); b.classList.add('drag-over'); });
      b.addEventListener('dragleave', () => b.classList.remove('drag-over'));
      b.addEventListener('drop', ev => {
        ev.preventDefault(); b.classList.remove('drag-over');
        const from = Number(ev.dataTransfer?.getData('text/plain'));
        if (Number.isInteger(from)) this.reorderTab(from, i);
      });
      this.tabStrip.appendChild(b);
    });
    const add = document.createElement('button');
    add.className = 'tab-new'; add.textContent = '+'; add.title = 'Новая вкладка';
    add.addEventListener('click', () => this.newTab());
    this.tabStrip.appendChild(add);
  }

  private tabLabel(tabPath: string): string {
    const shown = displayPath(tabPath);
    const drive = /^([a-z]):\\(.*)$/i.exec(shown);
    if (drive) return `${drive[1].toLowerCase()}:${drive[2].replace(/\\/g, '\\')}`;
    return basename(tabPath) || shown;
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
    if (e.isDir) return FOLDER_ICON;
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

  selectEntryByName(name: string): boolean {
    let index = this.visible().findIndex(entry => entry.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'));
    if (index < 0 && this.fileMask !== '*.*') {
      this.fileMask = '*.*'; this.maskSelect.value = '*.*'; this.sortEntries();
      this.pathInput.value = this.pathInputText();
      index = this.visible().findIndex(entry => entry.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'));
    }
    if (index < 0) return false;
    this.sel.clear(); this.cursor = index; this.anchor = index;
    this.render(); this.scrollCursorIntoView(); this.hooks.statusChanged();
    return true;
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
