import { fmtBytes, fmtDate, basename } from './util.js';

export type ConflictAnswer = 'overwrite' | 'skip' | 'overwriteAll' | 'skipAll' | 'cancel';

// --------------------------------------------------------------

export interface DialogHandle {
  close(): void;
}

type OnClose = () => void;

const overlayRoot = () => document.getElementById('overlay-root')!;

interface StackItem { el: HTMLElement; onClose: OnClose | null; escClosable: boolean }

/** Менеджер диалогов: стек оверлеев, Esc закрывает верхний */
class DialogManager {
  stack: StackItem[] = [];

  open(el: HTMLElement, opts: { onClose?: OnClose; escClosable?: boolean } = {}): DialogHandle {
    overlayRoot().appendChild(el);
    const item = { el, onClose: opts.onClose ?? null, escClosable: opts.escClosable ?? true };
    this.stack.push(item);
    const close = () => {
      const i = this.stack.indexOf(item);
      if (i >= 0) this.stack.splice(i, 1);
      el.remove();
      item.onClose?.();
    };
    return { close };
  }

  get top(): DialogHandle | null {
    return this.stack.length ? { close: () => this.closeTop() } : null;
  }

  closeTop(): void {
    const t = this.stack[this.stack.length - 1];
    if (t) this.closeItem(t);
  }

  closeItem(item: StackItem): void {
    const i = this.stack.indexOf(item);
    if (i >= 0) this.stack.splice(i, 1);
    item.el.remove();
    item.onClose?.();
  }

  handleEsc(): boolean {
    const t = this.stack[this.stack.length - 1];
    if (!t) return false;
    this.closeItem(t);
    return true;
  }

  get isOpen(): boolean {
    return this.stack.length > 0;
  }
}

export const dialogs = new DialogManager();

// Базовый каркас модального окна
function frame(title: string, bodyHtml: string): { root: HTMLElement; body: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'dlg-backdrop';
  root.innerHTML = `
    <div class="dlg">
      <div class="dlg-title">${escapeHtml(title)}</div>
      <div class="dlg-body">${bodyHtml}</div>
    </div>`;
  return { root, body: root.querySelector('.dlg-body')! };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buttonRow(buttons: Array<{ label: string; onClick: () => void; primary?: boolean; hint?: string }>): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'dlg-buttons';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    btn.className = 'dlg-btn' + (b.primary ? ' primary' : '');
    if (b.hint) btn.dataset.hint = b.hint;
    btn.addEventListener('click', b.onClick);
    bar.appendChild(btn);
  }
  return bar;
}

function messageTextLines(paths: string[], max = 8): string {
  const shown = paths.slice(0, max).map(p => escapeHtml(basename(p)));
  const rest = paths.length - shown.length;
  return shown.join('<br>') + (rest > 0 ? `<br><i>…и ещё ${rest}</i>` : '');
}

// --------------------------------------------------------------

/** Ввод текста (F7 — папка, Shift+F6 — переименование) */
export function promptDialog(title: string, label: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    const { root, body } = frame(title, `
      <div class="dlg-label">${escapeHtml(label)}</div>
      <input class="dlg-input" spellcheck="false" />
    `);
    const input = body.querySelector('.dlg-input') as HTMLInputElement;
    input.value = value;
    let done = false;
    const finish = (val: string | null) => {
      if (done) return;
      done = true;
      const item = dialogs.stack.find(x => x.el === root);
      if (item) dialogs.closeItem(item);
      resolve(val);
    };
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value); }
    });
    dialogs.open(root, { onClose: () => finish(null) });
    setTimeout(() => {
      input.focus();
      // выделяем базовое имя без расширения (как в ТС)
      const dot = value.lastIndexOf('.');
      if (dot > 0) input.setSelectionRange(0, dot); else input.select();
    }, 0);
  });
}

// --------------------------------------------------------------

/** Диалог копирования/переноса (F5/F6). Возвращает путь назначения или null */
export function copyMoveDialog(kind: 'copy' | 'move', defaultDest: string, summary: string): Promise<string | null> {
  return new Promise((resolve) => {
    const title = kind === 'copy' ? 'Копирование' : 'Перемещение';
    const { root, body } = frame(title, `
      <div class="dlg-label">${kind === 'copy' ? 'Копировать' : 'Переместить'} ${escapeHtml(summary)} в:</div>
      <input class="dlg-input" spellcheck="false" />
      <div class="dlg-hint">Enter — начать · Esc — отмена · можно указать новое имя в конце пути</div>
    `);
    const input = body.querySelector('.dlg-input') as HTMLInputElement;
    input.value = defaultDest;
    let done = false;
    const finish = (val: string | null) => {
      if (done) return;
      done = true;
      const item = dialogs.stack.find(x => x.el === root);
      if (item) dialogs.closeItem(item);
      resolve(val);
    };
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = input.value.trim();
        if (v) finish(v);
      }
    });
    dialogs.open(root, { onClose: () => finish(null) });
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  });
}

export type ArchiveFormat = 'zip' | '7z' | 'tar';
export interface ArchiveCreateChoice { archivePath: string; format: ArchiveFormat }

export function archiveCreateDialog(defaultPath: string, summary: string): Promise<ArchiveCreateChoice | null> {
  return new Promise(resolve => {
    const { root, body } = frame('Упаковка файлов', `
      <div class="dlg-label">Добавить в архив: ${escapeHtml(summary)}</div>
      <label class="dlg-label" for="archive-path">Имя архива:</label>
      <input class="dlg-input" id="archive-path" spellcheck="false" />
      <label class="dlg-label archive-format-label" for="archive-format">Формат:</label>
      <select class="dlg-select" id="archive-format">
        <option value="zip">ZIP</option><option value="7z">7-Zip</option><option value="tar">TAR</option>
      </select>
      <div class="dlg-hint">Можно указать полный путь. Содержимое папок будет добавлено рекурсивно.</div>
    `);
    const input = body.querySelector('#archive-path') as HTMLInputElement;
    const select = body.querySelector('#archive-format') as HTMLSelectElement;
    input.value = defaultPath;
    let settled = false;
    const finish = (value: ArchiveCreateChoice | null) => {
      if (settled) return;
      settled = true;
      const item = dialogs.stack.find(x => x.el === root);
      if (item) dialogs.closeItem(item);
      resolve(value);
    };
    body.appendChild(buttonRow([
      { label: 'Упаковать', primary: true, onClick: () => {
        const archivePath = input.value.trim();
        if (archivePath) finish({ archivePath, format: select.value as ArchiveFormat });
      } },
      { label: 'Отмена', onClick: () => finish(null) },
    ]));
    root.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); const archivePath = input.value.trim(); if (archivePath) finish({ archivePath, format: select.value as ArchiveFormat }); }
    });
    dialogs.open(root, { onClose: () => finish(null) });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

export function archiveExtractDialog(defaultDest: string, summary: string): Promise<string | null> {
  return new Promise(resolve => {
    const { root, body } = frame('Распаковка архивов', `
      <div class="dlg-label">Распаковать: ${escapeHtml(summary)}</div>
      <label class="dlg-label" for="archive-dest">Каталог назначения:</label>
      <input class="dlg-input" id="archive-dest" spellcheck="false" />
      <div class="dlg-hint">Существующие файлы пропускаются.</div>
    `);
    const input = body.querySelector('#archive-dest') as HTMLInputElement;
    input.value = defaultDest;
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      const item = dialogs.stack.find(x => x.el === root);
      if (item) dialogs.closeItem(item);
      resolve(value);
    };
    body.appendChild(buttonRow([
      { label: 'Распаковать', primary: true, onClick: () => { if (input.value.trim()) finish(input.value.trim()); } },
      { label: 'Отмена', onClick: () => finish(null) },
    ]));
    root.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); if (input.value.trim()) finish(input.value.trim()); } });
    dialogs.open(root, { onClose: () => finish(null) });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

export function archiveBusyDialog(title: string): DialogHandle {
  const { root, body } = frame(title, '<div class="archive-busy"><span class="archive-spinner"></span><span>Подождите…</span></div>');
  return dialogs.open(root, { escClosable: false });
}

// --------------------------------------------------------------

/** Подтверждение удаления. 'trash' | 'perm' | null */
export function deleteDialog(paths: string[], preselectPerm: boolean): Promise<'trash' | 'perm' | null> {
  return new Promise((resolve) => {
    const { root, body } = frame('Удаление', `
      <div class="dlg-label">Удалить ${paths.length === 1
        ? `«${escapeHtml(basename(paths[0]))}»`
        : `объекты (${paths.length} шт.)`}?</div>
      <div class="dlg-listbox">${messageTextLines(paths)}</div>
    `);
    let answered = false;
    const answer = (a: 'trash' | 'perm' | null) => {
      if (answered) return;
      answered = true;
      handle.close();
      resolve(a);
    };
    body.appendChild(buttonRow([
      { label: 'В корзину', onClick: () => answer('trash') },
      { label: 'Навсегда', onClick: () => answer('perm'), primary: preselectPerm },
      { label: 'Отмена', onClick: () => answer(null), primary: !preselectPerm },
    ]));
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') answer(preselectPerm ? 'perm' : 'trash');
    });
    const handle = dialogs.open(root);
    setTimeout(() => {
      const btns = body.querySelectorAll('.dlg-btn');
      (btns[preselectPerm ? 1 : 2] as HTMLElement)?.focus();
    }, 0);
  });
}

// --------------------------------------------------------------

export interface ProgressUi {
  update(d: { currentFile: string; filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number; bps: number }): void;
  close(): void;
}

/** Окно прогресса операции с кнопкой «Отмена» */
export function progressDialog(title: string, onCancel: () => void): ProgressUi {
  const { root, body } = frame(title, `
    <div class="dlg-progress-file"></div>
    <div class="dlg-bar"><div class="dlg-bar-fill"></div></div>
    <div class="dlg-progress-info"></div>
  `);
  root.dataset.dismissable = '0';
  const fileEl = body.querySelector('.dlg-progress-file')!;
  const fillEl = body.querySelector('.dlg-bar-fill') as HTMLElement;
  const infoEl = body.querySelector('.dlg-progress-info')!;
  body.appendChild(buttonRow([{ label: 'Отмена', onClick: onCancel }]));
  dialogs.open(root, { escClosable: false });
  return {
    update(d) {
      fileEl.textContent = d.currentFile;
      const pct = d.bytesTotal > 0 ? Math.min(100, Math.round((d.bytesDone / d.bytesTotal) * 100)) : 0;
      fillEl.style.width = pct + '%';
      const speed = d.bps > 0 ? ` · ${fmtBytes(d.bps)}/с` : '';
      infoEl.textContent = `Файлы: ${d.filesDone}/${d.filesTotal} · ${fmtBytes(d.bytesDone)} из ${fmtBytes(d.bytesTotal)}${speed}`;
    },
    close() {
      const item = dialogs.stack.find(x => x.el === root);
      if (item) dialogs.closeItem(item);
    },
  };
}

// --------------------------------------------------------------

/** Диалог конфликта «файл уже существует» */
export function conflictDialog(d: {
  srcName: string; destName: string; isDir: boolean;
  srcSize: number; srcTime: number; destSize: number; destTime: number;
}): Promise<ConflictAnswer> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (a: ConflictAnswer) => {
      if (answered) return;
      answered = true;
      handle.close();
      resolve(a);
    };
    const { root, body } = frame('Заменить файл?', `
      <div class="dlg-conflict">
        <table>
          <tr><th></th><th>Источник</th><th>Цель</th></tr>
          <tr><td>Имя</td><td>${escapeHtml(basename(d.srcName))}</td><td>${escapeHtml(basename(d.destName))}</td></tr>
          <tr><td>Размер</td><td>${fmtBytes(d.srcSize)}</td><td>${fmtBytes(d.destSize)}</td></tr>
          <tr><td>Изменён</td><td>${fmtDate(d.srcTime)}</td><td>${fmtDate(d.destTime)}</td></tr>
        </table>
        <div class="dlg-hint">Целевой файл уже существует. Заменить его?</div>
      </div>
    `);
    body.appendChild(buttonRow([
      { label: 'Заменить', onClick: () => answer('overwrite'), primary: true },
      { label: 'Пропустить', onClick: () => answer('skip') },
      { label: 'Заменить все', onClick: () => answer('overwriteAll') },
      { label: 'Пропустить все', onClick: () => answer('skipAll') },
      { label: 'Отмена', onClick: () => answer('cancel') },
    ]));
    root.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'y') answer('overwrite');
      else if (k === 'n') answer('skip');
      else if (k === 'a') answer('overwriteAll');
    });
    const handle = dialogs.open(root);
    setTimeout(() => (body.querySelector('.dlg-btn') as HTMLElement)?.focus(), 0);
  });
}

// --------------------------------------------------------------

/** Простое сообщение */
export function messageDialog(title: string, html: string): Promise<void> {
  return new Promise((resolve) => {
    const { root, body } = frame(title, `<div class="dlg-msg">${html}</div>`);
    const handle = dialogs.open(root, { onClose: () => resolve() });
    body.appendChild(buttonRow([{ label: 'ОК', onClick: () => handle.close(), primary: true }]));
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); handle.close(); }
    });
    setTimeout(() => (body.querySelector('.dlg-btn') as HTMLElement)?.focus(), 0);
  });
}

// --------------------------------------------------------------

/** Быстрый просмотр (F3) */
export async function viewerDialog(filePath: string): Promise<void> {
  const name = basename(filePath);
  const { root, body } = frame(`Просмотр: ${escapeHtml(name)}`, `
    <div class="dlg-viewer-head">Загрузка…</div>
    <pre class="dlg-viewer"></pre>
  `);
  root.classList.add('dlg-wide');
  const headEl = body.querySelector('.dlg-viewer-head')!;
  const pre = body.querySelector('.dlg-viewer') as HTMLElement;
  const handle = dialogs.open(root, { escClosable: true });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'PageDown') pre.scrollTop += pre.clientHeight * 0.9;
    if (e.key === 'PageUp') pre.scrollTop -= pre.clientHeight * 0.9;
  });
  body.appendChild(buttonRow([{ label: 'Закрыть (Esc)', onClick: () => handle.close(), primary: true }]));

  const res = await window.pos.readText(filePath);
  if (res.error) {
    headEl.textContent = 'Ошибка: ' + res.error;
    return;
  }
  const enc = res.encoding || '—';
  const trunc = res.truncated ? ' · файл усечён' : '';
  headEl.textContent = `${enc} · ${fmtBytes(res.size)}${trunc}`;
  pre.textContent = res.content;
}
