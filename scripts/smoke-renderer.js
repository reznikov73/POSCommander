// Интеграционный тест рендерера: выполняется в контексте окна при `electron . --smoke-ops`.
// Плейсхолдеры __SRC__ и __TMP__ подставляются main-процессом.
(async () => {
  const p = window.pos;
  const src = "__SRC__";
  const tmp = "__TMP__";
  const evs = [];
  const conflicts = [];
  const progress = [];
  const unsub = p.onOpEvent(e => {
    evs.push(e);
    if (e.conflictId) { conflicts.push(e); p.conflictReply(e.conflictId, 'skip'); }
    if (e.phase === 'progress') progress.push(e);
  });
  const waitDone = () => new Promise(r => {
    const t = setInterval(() => {
      const d = evs.find(e => e.phase === 'done' && !e._used);
      if (d) { d._used = 1; clearInterval(t); r(d); }
    }, 100);
  });
  const out = {};
  try {
    await p.mkdir(tmp);
    out.before = (await p.list(src)).entries.length;

    // 1) копирование каталога: копия появляется как tmp\renderer\...
    await p.startOp('copy', [src], tmp);
    const d1 = await waitDone();
    out.copyErrors = d1.errors || [];
    const copied = await p.list(tmp + '\\renderer');
    out.after = copied.entries.length;

    // 2) переименование
    out.renameErr = await p.rename(tmp + '\\renderer\\styles.css', tmp + '\\renderer\\renamed.css');
    const l2 = await p.list(tmp + '\\renderer');
    out.renameOk = !out.renameErr && l2.entries.some(e => e.name === 'renamed.css');

    // 3) чтение с определением кодировки
    const rd = await p.readText(tmp + '\\renderer\\renamed.css', 2000);
    out.readOk = !rd.error && rd.content.length > 0;
    out.readEnc = rd.encoding;

    // 4) перенос файла на уровень выше (тот же том — быстрый rename)
    await p.startOp('move', [tmp + '\\renderer\\renamed.css'], tmp);
    const d3 = await waitDone();
    out.moveErrors = d3.errors || [];
    out.movedToParent = (await p.list(tmp)).entries.some(e => e.name === 'renamed.css');

    // 6) открытие архива и копирование элемента с сохранением его имени
    const archivePath = tmp + '\\smoke.zip';
    out.archiveCreateErr = await p.createArchive([tmp + '\\renamed.css'], archivePath, 'zip', tmp);
    const archiveRoot = 'archive://' + encodeURIComponent(archivePath) + '!/';
    const archiveList = await p.list(archiveRoot);
    out.archiveListed = !archiveList.error && archiveList.entries.some(e => e.name === 'renamed.css');
    const fromArchive = tmp + '\\from-archive';
    await p.mkdir(fromArchive);
    await p.startOp('copy', [archiveRoot + 'renamed.css'], fromArchive);
    const d6 = await waitDone();
    out.archiveCopyErrors = d6.errors || [];
    out.archiveCopyOk = !!(await p.readText(fromArchive + '\\renamed.css', 1000)).content;

    // 7) move из архива удаляет исходный элемент только после успешной передачи
    const movedFromArchive = tmp + '\\moved-from-archive';
    await p.mkdir(movedFromArchive);
    await p.startOp('move', [archiveRoot + 'renamed.css'], movedFromArchive);
    const d7 = await waitDone();
    out.archiveMoveErrors = d7.errors || [];
    out.archiveMoveDeletedSource = !(await p.list(archiveRoot)).entries.some(e => e.name === 'renamed.css');
    out.archiveMoveCopiedFile = !!(await p.readText(movedFromArchive + '\\renamed.css', 1000)).content;

    // 8) копирование в архив использует обычный диалог конфликтов и прогресс операции
    await p.startOp('copy', [src + '\\styles.css'], archiveRoot);
    const d8 = await waitDone();
    await p.startOp('copy', [src + '\\styles.css'], archiveRoot);
    const d9 = await waitDone();
    out.archiveAddOk = (await p.list(archiveRoot)).entries.some(e => e.name === 'styles.css');
    out.archiveConflictShown = conflicts.length > 0;
    out.archiveConflictSkipped = (d9.skippedFiles ?? 0) > 0;
    out.progressEvents = progress.length;

    // 9) физический move в архив удаляет исходный файл после успешного обновления архива
    const moveSource = tmp + '\\move-into-archive.html';
    await p.startOp('copy', [src + '\\index.html'], tmp);
    await waitDone();
    const copiedIndex = tmp + '\\index.html';
    await p.rename(copiedIndex, moveSource);
    await p.startOp('move', [moveSource], archiveRoot);
    const d10 = await waitDone();
    out.moveIntoArchiveErrors = d10.errors || [];
    out.moveIntoArchiveDeletedSource = !!(await p.list(moveSource)).error;
    out.moveIntoArchiveAdded = (await p.list(archiveRoot)).entries.some(e => e.name === 'move-into-archive.html');

    // 10) быстрый поиск по имени возвращает полный путь результата
    const search = await p.search(tmp, 'moved-from-archive');
    out.searchFound = search.entries.some(e => e.path.toLowerCase() === movedFromArchive.toLowerCase());
    out.searchResults = search.entries.length;

    // 11) UI вкладок, контекстное меню и автодополнение файлов
    const tabCount = document.querySelectorAll('.path-tab').length;
    (document.querySelector('#panel0 .tab-new') || document.querySelector('#panel1 .tab-new'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    out.tabCreated = document.querySelectorAll('.path-tab').length === tabCount + 1;
    const tab = document.querySelector('.path-tab');
    if (tab) tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
    out.tabContextMenu = !!document.querySelector('.tab-context-menu');
    document.querySelector('.tab-context-menu')?.remove();
    const activePanel = document.querySelector('.panel.active');
    const pathInput = activePanel?.querySelector('.path-input');
    if (pathInput) {
      pathInput.value = tmp + '\\*.*';
      pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const command = document.getElementById('command-input');
    if (command) {
      command.value = 'renamed'; command.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 300));
      command.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
      out.commandCompletion = command.value.toLowerCase() === 'renamed.css';
      out.commandSuggestionCount = document.querySelectorAll('#command-suggestions .command-suggestion').length;
      command.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    document.querySelector('.tab-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // 12) удаление каталога в корзину
    await p.startOp('trash', [tmp], '');
    const d5 = await waitDone();
    out.trashErrors = d5.errors || [];
    out.gone = !!(await p.list(tmp)).error;
  } catch (e) {
    out.fatal = String(e && e.message || e);
  } finally {
    unsub();
  }
  return out;
})()

