// Интеграционный тест рендерера: выполняется в контексте окна при `electron . --smoke-ops`.
// Плейсхолдеры __SRC__ и __TMP__ подставляются main-процессом.
(async () => {
  const p = window.pos;
  const src = "__SRC__";
  const tmp = "__TMP__";
  const evs = [];
  const unsub = p.onOpEvent(e => evs.push(e));
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
    await p.startOp('deletePerm', [tmp + '\\renamed.css'], '');
    await waitDone();

    // 5) удаление каталога в корзину
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
