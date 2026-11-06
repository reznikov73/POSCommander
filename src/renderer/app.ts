import { Panel } from './panel.js';
import { fmtBytes, basename, joinPath, archiveRootPath, archivePathParts, displayPath, parentOf } from './util.js';
import { Drive, Entry } from './types.js';
import {
  dialogs, promptDialog, copyMoveDialog, deleteDialog, progressDialog,
  conflictDialog, messageDialog, viewerDialog, ProgressUi,
  archiveCreateDialog, archiveExtractDialog, archiveBusyDialog,
  searchDialog,
} from './dialogs.js';

type OpEvent = {
  opId: number;
  kind: string;
  phase?: 'progress' | 'done';
  currentFile?: string;
  filesDone?: number;
  filesTotal?: number;
  bytesDone?: number;
  bytesTotal?: number;
  bps?: number;
  cancelled?: boolean;
  errors?: string[];
  conflictId?: number;
  srcName?: string;
  destName?: string;
  isDir?: boolean;
  srcSize?: number;
  srcTime?: number;
  destSize?: number;
  destTime?: number;
};

const app = {
  panels: [] as Panel[],
  active: 0 as 0 | 1,
  drives: [] as Drive[],
  progressUi: null as ProgressUi | null,
  progressOpId: -1,
};
const COMMAND_HISTORY_KEY = 'poscommander.commandHistory';
let commandHistory: string[] = [];
let commandHistoryIndex = 0;
let commandDraft = '';
let completionValues: Array<{ value: string; kind: string }> = [];
let completionPrefix = '';
let completionIndex = -1;
let completionCurrent = '';
let completionRequest = 0;

// ---------- Инициализация ----------

function init(): void {
  const containers = [
    document.getElementById('panel0')!,
    document.getElementById('panel1')!,
  ];
  for (let i = 0; i < 2; i++) {
    const p = new Panel(i as 0 | 1, containers[i], {
      open: (panel, e) => openEntry(panel, e),
      driveMenu: (panel, anchor) => openDriveMenu(panel, anchor),
      activate: (panel) => setActive(panel.idx),
      statusChanged: updateStatus,
      fileAction: (owner, action) => {
        setActive(owner.idx);
        if (action === 'open') { const entry = owner.visible()[owner.cursor]; if (entry) openEntry(owner, entry); }
        else if (action === 'copy') doCopy();
        else if (action === 'move') doMove();
        else if (action === 'rename') doRename();
        else if (action === 'extract') doExtract();
        else doDelete(false);
      },
      dropFiles: (sourceIdx, paths, target, destination, forceCopy) => dropFiles(sourceIdx, paths, target, destination, forceCopy),
    });
    app.panels.push(p);
  }
  buildFKeyBar();
  buildChrome();
  window.pos.onOpEvent(onOpEvent);
  window.addEventListener('keydown', onKeyDown);
  void (async () => {
    app.drives = await window.pos.drives();
    const home = await window.pos.home();
    const saved = readSavedView();
    const leftOk = await app.panels[0].setPath(saved.paths[0] || home);
    if (!leftOk) await app.panels[0].setPath(home);
    const rightFallback = app.drives[0]?.root || home;
    const rightOk = await app.panels[1].setPath(saved.paths[1] || rightFallback);
    if (!rightOk) await app.panels[1].setPath(rightFallback);
    for (const p of app.panels) p.drives = app.drives;
    for (const p of app.panels) p.updateDriveButton();
    setActive(saved.active);
    updateStatus();
  })();
  const command = document.getElementById('command-input') as HTMLInputElement;
  commandHistory = readCommandHistory();
  commandHistoryIndex = commandHistory.length;
  renderCommandSuggestions();
  command.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Tab') {
      ev.preventDefault();
      void completeCommand(command);
      return;
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (completionValues.length) {
        ev.preventDefault();
        moveCommandSuggestion(command, ev.key === 'ArrowDown' ? 1 : -1);
      }
      return;
    }
    if (ev.key === 'Escape') {
      if (!document.getElementById('command-suggestions')!.hidden) hideCommandSuggestions();
      else { command.value = ''; command.blur(); }
    }
    if (ev.ctrlKey && ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (commandHistoryIndex === commandHistory.length) commandDraft = command.value;
      commandHistoryIndex = Math.max(0, commandHistoryIndex - 1);
      command.value = commandHistory[commandHistoryIndex] ?? '';
      resetCommandCompletion(command.value);
      return;
    }
    if (ev.ctrlKey && ev.key === 'ArrowDown') {
      ev.preventDefault();
      commandHistoryIndex = Math.min(commandHistory.length, commandHistoryIndex + 1);
      command.value = commandHistoryIndex === commandHistory.length ? commandDraft : commandHistory[commandHistoryIndex] ?? '';
      resetCommandCompletion(command.value);
      return;
    }
    if (ev.key === 'Enter') {
      const value = command.value.trim();
      if (!value) return;
      rememberCommand(value);
      const p = panel();
      const targetPath = p.resolvePathInput(value);
      void window.pos.list(targetPath).then(result => {
        if (!result.error) return p.setPath(targetPath).then(() => undefined);
        return window.pos.runCommand(value, p.path).then(err => {
          if (err) void messageDialog('Ошибка команды', escapeHtml(err));
        });
      });
      command.value = '';
      command.blur();
      completionPrefix = ''; completionCurrent = ''; completionIndex = -1; completionValues = [];
      renderCommandSuggestions();
    }
  });
  command.addEventListener('input', () => {
    completionPrefix = command.value.trim();
    completionIndex = -1;
    completionCurrent = '';
    completionValues = [];
    hideCommandSuggestions();
    void loadCommandSuggestions(command, completionPrefix);
  });
  command.addEventListener('blur', () => setTimeout(hideCommandSuggestions, 120));
}

function readCommandHistory(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(COMMAND_HISTORY_KEY) || '[]');
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string').slice(0, 100) : [];
  } catch { return []; }
}

function rememberCommand(value: string): void {
  commandHistory = [value, ...commandHistory.filter(x => x !== value)].slice(0, 100);
  commandHistoryIndex = commandHistory.length;
  commandDraft = '';
  try { localStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(commandHistory)); } catch { /* storage may be unavailable */ }
}

function renderCommandSuggestions(): void {
  if (!completionPrefix) { hideCommandSuggestions(); return; }
  renderCommandSuggestionList();
}

async function completeCommand(input: HTMLInputElement): Promise<void> {
  const value = input.value.trim();
  if (!value) return;
  if (value !== completionCurrent && value !== completionPrefix) {
    completionPrefix = value;
    completionIndex = -1;
    completionCurrent = '';
    await loadCommandSuggestions(input, value);
  } else if (!completionValues.length || completionPrefix !== value && value !== completionCurrent) {
    await loadCommandSuggestions(input, completionPrefix || value);
  }
  if (!completionValues.length) return;
  completionIndex = (completionIndex + 1) % completionValues.length;
  completionCurrent = completionValues[completionIndex].value;
  input.value = completionCurrent;
  renderCommandSuggestionList();
}

function resetCommandCompletion(value: string): void {
  completionPrefix = value.trim();
  completionCurrent = '';
  completionIndex = -1;
  void loadCommandSuggestions(document.getElementById('command-input') as HTMLInputElement, completionPrefix);
}

async function loadCommandSuggestions(input: HTMLInputElement, prefix: string): Promise<void> {
  const request = ++completionRequest;
  const lower = prefix.toLocaleLowerCase('ru');
  if (!lower) { completionValues = []; hideCommandSuggestions(); return; }
  const values: Array<{ value: string; kind: string }> = [];
  const seen = new Set<string>();
  for (const value of commandHistory) {
    if (value.toLocaleLowerCase('ru').startsWith(lower) && !seen.has(value.toLocaleLowerCase('ru'))) {
      values.push({ value, kind: 'История' }); seen.add(value.toLocaleLowerCase('ru'));
    }
  }
  try {
    const result = await window.pos.list(panel().path);
    if (!result.error) {
      const matches = result.entries
        .filter(entry => entry.name.toLocaleLowerCase('ru').startsWith(lower))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' }));
      for (const entry of matches) {
        const value = entry.name + (entry.isDir ? '\\' : '');
        const key = value.toLocaleLowerCase('ru');
        if (!seen.has(key)) { values.push({ value, kind: entry.isDir ? 'Папка' : 'Файл' }); seen.add(key); }
      }
    }
  } catch { /* список подсказок может быть недоступен */ }
  if (request !== completionRequest) return;
  completionValues = values.slice(0, 100);
  if (input.value.trim() === prefix) completionIndex = -1;
  renderCommandSuggestionList();
}

function renderCommandSuggestionList(): void {
  const list = document.getElementById('command-suggestions');
  if (!list) return;
  list.replaceChildren();
  if (!completionValues.length) { list.hidden = true; return; }
  completionValues.forEach((item, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'command-suggestion' + (index === completionIndex ? ' active' : '');
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', index === completionIndex ? 'true' : 'false');
    const kind = document.createElement('span'); kind.className = 'suggestion-kind'; kind.textContent = item.kind;
    const value = document.createElement('span'); value.className = 'suggestion-value'; value.textContent = item.value;
    option.append(kind, value);
    option.addEventListener('mousedown', ev => ev.preventDefault());
    option.addEventListener('click', () => {
      const input = document.getElementById('command-input') as HTMLInputElement;
      completionIndex = index; completionCurrent = item.value; input.value = item.value; input.focus(); renderCommandSuggestionList();
    });
    list.appendChild(option);
  });
  list.hidden = false;
}

function moveCommandSuggestion(input: HTMLInputElement, delta: -1 | 1): void {
  if (!completionValues.length) return;
  completionIndex = completionIndex < 0
    ? (delta > 0 ? 0 : completionValues.length - 1)
    : (completionIndex + delta + completionValues.length) % completionValues.length;
  completionCurrent = completionValues[completionIndex].value;
  input.value = completionCurrent;
  renderCommandSuggestionList();
}

function hideCommandSuggestions(): void {
  const list = document.getElementById('command-suggestions');
  if (list) list.hidden = true;
}

function readSavedView(): { paths: [string, string]; active: 0 | 1 } {
  try {
    const saved = JSON.parse(localStorage.getItem('poscommander.view') || '{}');
    return {
      paths: [typeof saved.paths?.[0] === 'string' ? saved.paths[0] : '', typeof saved.paths?.[1] === 'string' ? saved.paths[1] : ''],
      active: saved.active === 1 ? 1 : 0,
    };
  } catch { return { paths: ['', ''], active: 0 }; }
}

function saveView(): void {
  try {
    const value = JSON.stringify({ paths: [panel(0).path, panel(1).path], active: app.active });
    if (localStorage.getItem('poscommander.view') !== value) localStorage.setItem('poscommander.view', value);
  } catch { /* хранилище может быть недоступно */ }
}

function buildChrome(): void {
  const menus: Array<[string, Array<[string, () => void]>]> = [
    ['Файл', [['Просмотр  F3', doView], ['Правка  F4', editCurrent], ['Копирование  F5', doCopy], ['Перемещение  F6', doMove], ['Создать каталог  F7', doMkdir], ['Удаление  F8', () => doDelete(false)], ['Упаковать  Alt+F5', doPack], ['Распаковать  Alt+F9', doExtract], ['Выход  Alt+F4', () => window.close()]]],
    ['Выделение', [['Выделить всё  Ctrl+A', () => panel().selectAll()], ['Снять выделение  Esc', () => panel().clearSelection()], ['Инвертировать  Ctrl+Num *', () => panel().invertSelection()]]],
    ['Навигация', [['Назад  Alt+←', () => panel().goHistory(-1)], ['Вперёд  Alt+→', () => panel().goHistory(1)], ['На уровень выше  Backspace', () => panel().goUp()], ['Поиск файлов  Ctrl+F', doSearch], ['Обновить  Ctrl+R', () => { void panel().refresh(); }], ['Поменять панели  Ctrl+U', swapPanels]]],
    ['Сеть', [['Список дисков  Alt+F1', () => void openDriveMenu(panel(0), panel(0).driveBtnEl())], ['Список дисков  Alt+F2', () => void openDriveMenu(panel(1), panel(1).driveBtnEl())]]],
    ['Вид', [['Сортировать по имени', () => sortActive('name')], ['Сортировать по размеру', () => sortActive('size')], ['Сортировать по дате', () => sortActive('date')]]],
    ['Вкладки', [['Новая вкладка', () => panel().newTab()]]],
    ['Конфигурация', [['Параметры отображения', () => void messageDialog('POSCommander', 'Двухпанельный режим · сортировка по имени, расширению, размеру и дате.')]]],
    ['Инструменты', [['Быстрый просмотр  F3', doView], ['Переименовать  Shift+F6', doRename], ['Упаковать  Alt+F5', doPack], ['Распаковать  Alt+F9', doExtract]]],
  ];
  const bar = document.getElementById('menubar')!;
  for (const [label, items] of menus) {
    const wrap = document.createElement('div'); wrap.className = 'menu-wrap';
    const trigger = document.createElement('button'); trigger.className = 'menu-trigger'; trigger.textContent = label;
    const pop = document.createElement('div'); pop.className = 'menu-pop';
    for (const [text, fn] of items) {
      const item = document.createElement('button'); item.textContent = text;
      item.addEventListener('click', () => { pop.classList.remove('open'); fn(); }); pop.appendChild(item);
    }
    trigger.addEventListener('click', () => { document.querySelectorAll('.menu-pop.open').forEach(m => m.classList.remove('open')); pop.classList.toggle('open'); });
    wrap.append(trigger, pop); bar.appendChild(wrap);
  }
  document.addEventListener('mousedown', ev => {
    if (!(ev.target as HTMLElement).closest('.menu-wrap')) document.querySelectorAll('.menu-pop.open').forEach(m => m.classList.remove('open'));
  });

  const tools: Array<[string, string, () => void]> = [
    ['📂', 'На уровень выше', () => panel().goUp()], ['↻', 'Обновить', () => { void panel().refresh(); }],
    ['🔍', 'Поиск файлов (Ctrl+F)', doSearch],
    ['📦', 'Копировать', doCopy], ['➡', 'Переместить', doMove], ['🗑', 'Удалить', () => doDelete(false)],
    ['📁', 'Создать папку', doMkdir], ['✎', 'Переименовать', doRename], ['⇄', 'Поменять панели', swapPanels],
    ['🗜', 'Упаковать файлы (Alt+F5)', doPack], ['📦', 'Распаковать архив (Alt+F9)', doExtract],
  ];
  const toolbar = document.getElementById('toolbar')!;
  for (const [icon, title, fn] of tools) {
    const b = document.createElement('button'); b.className = 'tool-button'; b.textContent = icon; b.title = title;
    b.addEventListener('click', () => { if (!dialogs.isOpen) fn(); }); toolbar.appendChild(b);
  }
  const mid = document.getElementById('midbar')!;
  const middleActions: Array<[string, string, () => void]> = [
    ['←', 'Копировать в другую панель', doCopy], ['→', 'Переместить в другую панель', doMove],
    ['▤', 'Быстрый просмотр', doView], ['＋', 'Создать папку', doMkdir],
    ['－', 'Удалить', () => doDelete(false)], ['↻', 'Обновить обе панели', () => { void panel(0).refresh(); void panel(1).refresh(); }],
    ['⇄', 'Поменять панели', swapPanels], ['✎', 'Переименовать', doRename],
    ['▣', 'Выделить всё', () => panel().selectAll()], ['□', 'Снять выделение', () => panel().clearSelection()],
  ];
  middleActions.forEach(([icon, title, fn], i) => {
    const b = document.createElement('button'); b.textContent = icon; b.title = title; b.addEventListener('click', fn); mid.appendChild(b);
    if (i === 1 || i === 4 || i === 6) b.classList.add('mid-separator');
  });
}

function editCurrent(): void {
  const cur = panel().currentPath();
  if (cur?.startsWith('archive://')) {
    void messageDialog('Редактирование файла в архиве', 'Сначала скопируйте файл из архива клавишей F5, затем отредактируйте извлечённую копию.');
    return;
  }
  if (cur) void resolveViewPath(cur).then(local => { if (local) return window.pos.openPath(local); });
}

async function resolveViewPath(filePath: string): Promise<string | null> {
  if (!filePath.startsWith('archive://')) return filePath;
  const extracted = await runArchiveCommand('Извлечение файла для просмотра', async () => {
    const result = await window.pos.extractArchiveFileForView(filePath);
    return result.error ? `!ERROR!${result.error}` : result.path ?? '!ERROR!Не удалось извлечь файл';
  });
  if (extracted.startsWith('!ERROR!')) {
    void messageDialog('Ошибка извлечения файла', escapeHtml(extracted.slice('!ERROR!'.length)));
    return null;
  }
  return extracted;
}

function doPack(): void {
  const sourcePanel = panel();
  const srcs = sourcePanel.selectedPaths();
  if (!srcs.length) return;
  if (srcs.some(p => p.startsWith('archive://'))) {
    void messageDialog('Упаковка из архива', 'Сначала извлеките выбранные файлы в обычную папку, затем создайте из неё архив.');
    return;
  }
  const baseName = srcs.length === 1 ? basename(srcs[0]) : 'Архив';
  const defaultPath = joinPath(otherPanel().path, baseName + '.zip');
  void archiveCreateDialog(defaultPath, srcs.length === 1 ? `«${baseName}»` : `${srcs.length} объектов`).then(async choice => {
    if (!choice) return;
    const ext = `.${choice.format}`;
    const stem = choice.archivePath.replace(/\.(zip|7z|tar)$/i, '');
    const rawPath = stem + ext;
    const archivePath = sourcePanel.resolvePathInput(rawPath);
    const busy = archiveBusyDialog('Создание архива');
    const error = await window.pos.createArchive(srcs, archivePath, choice.format, sourcePanel.path).catch(e => String(e));
    busy.close();
    void sourcePanel.refresh(); void otherPanel().refresh();
    if (error) void messageDialog('Ошибка упаковки', escapeHtml(error));
  });
}

function doExtract(): void {
  const sourcePanel = panel();
  const selected = sourcePanel.selectedPaths();
  const archives = selected.filter(p => /\.(zip|7z|tar|gz|tgz|bz2|xz|wim|iso|cab|rar)$/i.test(p));
  if (!archives.length) {
    void messageDialog('Распаковка архивов', 'Выберите архив (ZIP, 7z, TAR, GZIP, CAB, ISO или RAR).');
    return;
  }
  const defaultDest = otherPanel().path;
  const summary = archives.length === 1 ? `«${basename(archives[0])}»` : `${archives.length} архивов`;
  void archiveExtractDialog(defaultDest, summary).then(async dest => {
    if (!dest) return;
    const destination = otherPanel().resolvePathInput(dest);
    const busy = archiveBusyDialog('Распаковка архивов');
    const error = await window.pos.extractArchives(archives, destination).catch(e => String(e));
    busy.close();
    void sourcePanel.refresh(); void otherPanel().refresh();
    if (error) void messageDialog('Ошибка распаковки', escapeHtml(error));
  });
}
function copyTo(target: 0 | 1): void {
  const src = panel().selectedPaths(); if (src.length) startOp('copy', src, panel(target).path);
}
function sortActive(by: 'name' | 'size' | 'date'): void {
  const p = panel();
  const header = document.querySelector(`#panel${app.active} [data-sort="${by}"]`) as HTMLElement | null;
  header?.click();
}

// ---------- Активная панель ----------

function setActive(idx: 0 | 1): void {
  app.active = idx;
  for (let i = 0; i < 2; i++) {
    const cont = document.getElementById(`panel${i}`)!;
    cont.classList.toggle('active', i === idx);
  }
  updateStatus();
}

function panel(i?: number): Panel {
  return app.panels[i ?? app.active];
}

function otherPanel(): Panel {
  return app.panels[1 - app.active];
}

// ---------- Открытие объектов ----------

function openEntry(p: Panel, e: Entry): void {
  if (e.name === '..') { p.goUp(); return; }
  const full = joinPath(p.path, e.name);
  if (e.isDir) {
    void p.setPath(full);
  } else if (!p.path.startsWith('archive://') && /\.(zip|7z|tar|gz|tgz|bz2|xz|wim|iso|cab|rar)$/i.test(e.name)) {
    void p.setPath(archiveRootPath(full));
  } else if (p.path.startsWith('archive://')) {
    void resolveViewPath(full).then(local => {
      if (local) return window.pos.openPath(local).then(err => { if (err) void messageDialog('Ошибка', escapeHtml(err)); });
    });
  } else {
    // файл — системное открытие ассоциированной программой
    void window.pos.openPath(full).then(err => {
      if (err) void messageDialog('Ошибка', escapeHtml(err));
    });
  }
}

// ---------- Диски ----------

async function openDriveMenu(p: Panel, anchor: HTMLElement): Promise<void> {
  app.drives = await window.pos.drives();
  p.drives = app.drives;
  const menu = document.createElement('div');
  menu.className = 'drive-menu';
  menu.style.left = anchor.getBoundingClientRect().left + 'px';
  menu.style.top = anchor.getBoundingClientRect().bottom + 'px';
  for (const d of app.drives) {
    const item = document.createElement('div');
    item.className = 'drive-menu-item';
    item.innerHTML = `<b>${d.letter}</b> ${escapeHtml(d.label || d.type)}
      <span class="drive-free">свободно ${fmtBytes(d.free)} из ${fmtBytes(d.total)}</span>`;
    item.addEventListener('click', () => {
      closeMenu();
      void p.setPath(d.root);
    });
    menu.appendChild(item);
  }
  const refresh = document.createElement('div');
  refresh.className = 'drive-menu-item';
  refresh.innerHTML = '<b>⟳</b> Обновить список дисков';
  refresh.addEventListener('click', () => { closeMenu(); void openDriveMenu(p, anchor); });
  menu.appendChild(refresh);

  const closeMenu = () => { menu.remove(); document.removeEventListener('mousedown', outside, true); };
  const outside = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) closeMenu();
  };
  document.body.appendChild(menu);
  document.addEventListener('mousedown', outside, true);
}

// ---------- Операции ----------

function startOp(kind: 'copy' | 'move' | 'deletePerm' | 'trash', srcs: string[], destDir: string): void {
  const titles: Record<string, string> = {
    copy: 'Копирование', move: 'Перемещение', deletePerm: 'Удаление', trash: 'Удаление в корзину',
  };
  app.progressUi = progressDialog(titles[kind] + '…', () => {
    if (app.progressOpId >= 0) window.pos.cancelOp(app.progressOpId);
  });
  app.progressOpId = -1;
  void window.pos.startOp(kind, srcs, destDir).then(opId => {
    app.progressOpId = opId;
  }).catch(error => {
    app.progressUi?.close(); app.progressUi = null; app.progressOpId = -1;
    void messageDialog('Ошибка операции', escapeHtml(String(error)));
  });
}

function dropFiles(sourceIdx: 0 | 1, paths: string[], target: Panel, destination: string, forceCopy: boolean): void {
  if (!paths.length) return;
  setActive(target.idx);
  const physicalPath = (value: string) => archivePathParts(value)?.archive ?? value;
  const rootKey = (value: string) => {
    const p = physicalPath(value).replace(/\//g, '\\');
    const drive = /^[a-z]:/i.exec(p);
    if (drive) return drive[0].toLowerCase();
    if (p.startsWith('\\\\')) return p.split('\\').slice(0, 4).join('\\').toLowerCase();
    return p.toLowerCase();
  };
  const sameVolume = paths.every(src => rootKey(src) === rootKey(destination));
  const copy = forceCopy || !sameVolume;
  const destLower = destination.replace(/\\+$/, '').toLocaleLowerCase('ru');
  if (!copy && paths.every(src => parentOf(src).replace(/\\+$/, '').toLocaleLowerCase('ru') === destLower)) return;
  if (paths.some(src => {
    const sourcePath = src.replace(/\\+$/, '').toLocaleLowerCase('ru');
    return destLower === sourcePath || destLower.startsWith(sourcePath + '\\');
  })) {
    void messageDialog('Перетаскивание файлов', 'Нельзя скопировать или переместить папку внутрь самой себя.');
    return;
  }
  startOp(copy ? 'copy' : 'move', paths, destination);
}

async function runArchiveCommand(title: string, run: () => Promise<string>): Promise<string> {
  const busy = archiveBusyDialog(title);
  try { return await run(); }
  catch (error) { return String(error); }
  finally { busy.close(); }
}

function onOpEvent(ev: OpEvent): void {
  if ('conflictId' in ev && ev.conflictId !== undefined) {
    void conflictDialog({
      srcName: ev.srcName!,
      destName: ev.destName!,
      isDir: !!ev.isDir,
      srcSize: ev.srcSize ?? 0,
      srcTime: ev.srcTime ?? 0,
      destSize: ev.destSize ?? 0,
      destTime: ev.destTime ?? 0,
    }).then(answer => window.pos.conflictReply(ev.conflictId!, answer));
    return;
  }
  if (ev.opId !== app.progressOpId) return;
  if (ev.phase === 'progress' && app.progressUi) {
    app.progressUi.update({
      currentFile: ev.currentFile ?? '',
      filesDone: ev.filesDone ?? 0,
      filesTotal: ev.filesTotal ?? 0,
      bytesDone: ev.bytesDone ?? 0,
      bytesTotal: ev.bytesTotal ?? 0,
      bps: ev.bps ?? 0,
    });
  } else if (ev.phase === 'done') {
    app.progressUi?.close();
    app.progressUi = null;
    app.progressOpId = -1;
    // перечитываем обе панели
    void panel(0).refresh();
    void panel(1).refresh();
    const errors = ev.errors ?? [];
    if (errors.length) {
      const list = errors.map(e => escapeHtml(e)).join('<br>');
      void messageDialog(ev.cancelled ? 'Операция прервана' : 'Завершено с ошибками',
        (ev.cancelled ? 'Операция была отменена.' : 'Часть файлов обработать не удалось:') + '<br><br>' + list);
    }
  }
}

// ---------- Команды клавиш ----------

function doCopy(): void {
  const src = panel().selectedPaths();
  if (!src.length) return;
  void copyMoveDialog('copy', otherPanel().path, summaryText(src)).then(dest => {
    if (!dest) return;
    const destination = otherPanel().resolvePathInput(dest);
    if (destination.startsWith('archive://') && src.every(p => p.startsWith('archive://'))) {
      void messageDialog('Копирование между архивами', 'Сначала извлеките файлы в обычную папку, затем добавьте их в другой архив.');
      return;
    }
    if (destination.startsWith('archive://')) {
      startOp('copy', src, destination);
    } else if (src.every(p => p.startsWith('archive://'))) {
      startOp('copy', src, destination);
    } else startOp('copy', src, dest);
  });
}

function doMove(): void {
  const src = panel().selectedPaths();
  if (!src.length) return;
  void copyMoveDialog('move', otherPanel().path, summaryText(src)).then(dest => {
    if (!dest) return;
    const destination = otherPanel().resolvePathInput(dest);
    if (destination.startsWith('archive://') && src.every(p => p.startsWith('archive://'))) {
      void messageDialog('Перемещение между архивами', 'Сначала извлеките файлы в обычную папку, затем добавьте их в другой архив.');
      return;
    }
    if (destination.startsWith('archive://')) {
      startOp('move', src, destination);
    } else if (src.every(p => p.startsWith('archive://'))) {
      startOp('move', src, destination);
    } else startOp('move', src, dest);
  });
}

function doMkdir(): void {
  const p = panel();
  void promptDialog('Создание папки', 'Имя папки (можно с путём):', '').then(name => {
    if (!name) return;
    const full = name.includes('\\') || name.includes('/')
      ? p.resolvePathInput(name)
      : joinPath(p.path, name);
    const create = full.startsWith('archive://')
      ? runArchiveCommand('Создание папки в архиве', () => window.pos.createArchiveFolder(full))
      : window.pos.mkdir(full);
    void create.then(err => {
      if (err) void messageDialog('Ошибка создания папки', escapeHtml(err));
      void p.refresh();
    });
  });
}

function doDelete(preselectPerm: boolean): void {
  const src = panel().selectedPaths();
  if (!src.length) return;
  const archiveEntries = src.every(p => p.startsWith('archive://'));
  void deleteDialog(src, preselectPerm, archiveEntries).then(answer => {
    if (src.every(p => p.startsWith('archive://'))) {
      if (answer !== 'perm') return;
      void runArchiveCommand('Удаление файлов из архива', () => window.pos.deleteArchiveEntries(src)).then(err => {
        if (err) void messageDialog('Ошибка удаления из архива', escapeHtml(err));
        else void panel().refresh();
      });
    } else if (answer === 'trash') startOp('trash', src, '');
    else if (answer === 'perm') startOp('deletePerm', src, '');
  });
}

function doRename(): void {
  const p = panel();
  const cur = p.currentPath();
  if (!cur) return;
  void promptDialog('Переименование', 'Новое имя:', basename(cur)).then(newPath => {
    if (!newPath) return;
    const rename = cur.startsWith('archive://')
      ? runArchiveCommand('Переименование в архиве', () => window.pos.renameArchiveEntry(cur, newPath))
      : window.pos.rename(cur, joinPath(parentOf(cur), newPath));
    void rename.then(err => {
      if (err) void messageDialog('Ошибка переименования', escapeHtml(err));
      void p.refresh();
    });
  });
}

function doSearch(): void {
  const p = panel();
  if (p.path.startsWith('archive://')) {
    void messageDialog('Поиск файлов', 'Сначала выйдите из архива. Поиск выполняется в обычной папке или на диске.');
    return;
  }
  const drive = p.drives.find(item => p.path.toLocaleLowerCase('ru').startsWith(item.root.toLocaleLowerCase('ru')));
  const driveRoot = drive?.root ?? p.path;
  void searchDialog(p.path, driveRoot).then(async found => {
    if (!found) return;
    const ok = await p.setPath(parentOf(found));
    if (ok) p.selectEntryByName(basename(found));
  });
}

function doView(): void {
  const p = panel();
  const cur = p.visible()[p.cursor];
  if (!cur || cur.name === '..') return;
  const full = joinPath(p.path, cur.name);
  if (cur.isDir) return;
  void resolveViewPath(full).then(local => { if (local) void viewerDialog(local); });
}

function swapPanels(): void {
  const a = panel(0).path, b = panel(1).path;
  void panel(0).setPath(b).then(() => panel(1).setPath(a));
}

function summaryText(paths: string[]): string {
  return paths.length === 1 ? `«${basename(paths[0])}»` : `${paths.length} объект(ов)`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Статус-бар ----------

function updateStatus(): void {
  const left = statusTextFor(panel(0));
  const right = statusTextFor(panel(1));
  document.getElementById('status-left')!.innerHTML = left;
  document.getElementById('status-right')!.innerHTML = right;
  document.getElementById('command-prompt')!.textContent = displayPath(panel().path) + '>';
  saveView();
}

function statusTextFor(p: Panel): string {
  if (p.error) return `<span class="st-error">${escapeHtml(p.error)}</span>`;
  const s = p.countSummary();
  const sel = p.idx === app.active ? p.selectedSummary() : null;
  const archive = archivePathParts(p.path);
  const letter = (archive?.archive.slice(0, 2) ?? p.path.slice(0, 2)).toUpperCase();
  const drive = p.drives.find(d => d.letter.toUpperCase() === letter);
  const driveLabel = drive?.label ? `[${escapeHtml(drive.label)}]` : escapeHtml(letter);
  const freeTxt = p.total > 0 ? `${fmtBytes(p.free)} из ${fmtBytes(p.total)} свободно` : '';
  const main = sel && sel.files > 0
    ? `выделено ${sel.files} файл(ов) — ${fmtBytes(sel.bytes)}`
    : `${s.dirs} пап. · ${s.files} файл. · ${fmtBytes(s.bytes)}`;
  return `${driveLabel}${freeTxt ? ' ' + freeTxt : ''} &nbsp;|&nbsp; ${main}`;
}

// ---------- Функциональные клавиши (нижняя панель) ----------

function buildFKeyBar(): void {
  const bar = document.getElementById('fkeys')!;
  const keys: Array<[string, string, () => void]> = [
    ['F3', 'Просмотр', doView],
    ['F4', 'Правка', () => {
      editCurrent();
    }],
    ['F5', 'Копирование', doCopy],
    ['F6', 'Перемещение', doMove],
    ['F7', 'Каталог', doMkdir],
    ['F8', 'Удаление', () => doDelete(false)],
    ['Alt+F4', 'Выход', () => window.close()],
  ];
  for (const [key, label, fn] of keys) {
    const b = document.createElement('button');
    b.className = 'fkey';
    b.innerHTML = `<span class="fkey-k">${key}</span> ${label}`;
    b.addEventListener('click', () => { if (!dialogs.isOpen) fn(); });
    bar.appendChild(b);
  }
}

// ---------- Обработка клавиатуры ----------

function onKeyDown(ev: KeyboardEvent): void {
  // открытые диалоги: Enter/Esc обрабатывают себя, прочие клавиши пропускаем
  if (dialogs.isOpen) {
    if (ev.key === 'Escape') { ev.preventDefault(); dialogs.handleEsc(); }
    return;
  }
  // поле пути — редактируем обычно
  const ae = document.activeElement;
  if (ae instanceof HTMLInputElement && ae.classList.contains('path-input')) return;

  const p = panel();
  const key = ev.key;

  if (ev.ctrlKey && (key === 't' || key === 'T')) { ev.preventDefault(); p.newTab(); return; }
  if (ev.ctrlKey && (key === 'w' || key === 'W')) { ev.preventDefault(); p.closeActiveTab(); return; }

  const handle = (): boolean => {
    switch (key) {
      case 'Enter': {
        const e = p.visible()[p.cursor];
        if (e) openEntry(p, e);
        return true;
      }
      case 'Backspace': p.goUp(); return true;
      case 'ArrowUp': p.moveCursor(-1, ev.shiftKey); return true;
      case 'ArrowDown': p.moveCursor(1, ev.shiftKey); return true;
      case 'PageUp': p.moveCursor(-p.pageRows(), ev.shiftKey); return true;
      case 'PageDown': p.moveCursor(p.pageRows(), ev.shiftKey); return true;
      case 'Home': p.cursorHomeEnd(false); return true;
      case 'End': p.cursorHomeEnd(true); return true;
      case 'Insert': p.toggleSelectAndMove(); return true;
      case ' ': p.toggleSelectAndMove(); return true;
      case 'Delete': doDelete(ev.shiftKey); return true;
      case 'F2': case 'F3': case 'F4': case 'F5': case 'F6': case 'F7': case 'F8':
        return handleFKey(key, ev);
      case 'Tab': setActive((1 - app.active) as 0 | 1); return true;
      case 'f': case 'F':
        if (ev.ctrlKey) { doSearch(); return true; }
        return false;
      case 'a': case 'A': case 'ф': case 'Ф':
        if (ev.ctrlKey) { p.selectAll(); return true; }
        return false;
      case 'r': case 'R': case 'к': case 'К':
        if (ev.ctrlKey) { void p.refresh(); return true; }
        return false;
      case 'u': case 'U': case 'г': case 'Г':
        if (ev.ctrlKey) { swapPanels(); return true; }
        return false;
      case 'Escape': p.clearSelection(); return true;
      case '+':
        if (ev.code === 'NumpadAdd') { p.selectByExt('+'); return true; }
        return false;
      case '-':
        if (ev.code === 'NumpadSubtract') { p.selectByExt('-'); return true; }
        return false;
      case '*':
        if (ev.code === 'NumpadMultiply') { p.selectByExt('*'); return true; }
        return false;
    }
    return false;
  };

  // Alt+F1/F2 — меню дисков
  if (ev.altKey && (key === 'F1' || key === 'F2')) {
    ev.preventDefault();
    const target = app.panels[key === 'F1' ? 0 : 1];
    void openDriveMenu(target, target.driveBtnEl());
    return;
  }
  if (ev.altKey && key === 'F5') { ev.preventDefault(); doPack(); return; }
  if (ev.altKey && key === 'F9') { ev.preventDefault(); doExtract(); return; }
  if (ev.altKey && key === 'ArrowLeft') { ev.preventDefault(); panel().goHistory(-1); return; }
  if (ev.altKey && key === 'ArrowRight') { ev.preventDefault(); panel().goHistory(1); return; }

  // Shift+F6 — переименование
  if (key === 'F6' && ev.shiftKey) { ev.preventDefault(); doRename(); return; }
  if (key === 'F4' && ev.altKey) { ev.preventDefault(); window.close(); return; }

  if (handle()) ev.preventDefault();
}

function handleFKey(key: string, ev: KeyboardEvent): boolean {
  ev.preventDefault();
  switch (key) {
    case 'F2': void panel().refresh(); return true;
    case 'F3': doView(); return true;
    case 'F4': editCurrent(); return true;
    case 'F5': doCopy(); return true;
    case 'F6': doMove(); return true;
    case 'F7': doMkdir(); return true;
    case 'F8': doDelete(false); return true;
  }
  return false;
}

init();
