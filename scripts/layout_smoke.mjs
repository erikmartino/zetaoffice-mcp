#!/usr/bin/env node
/*
 * Smoke test for the UNO-native deterministic layout layer.
 *
 *   node scripts/layout_smoke.mjs
 *
 * Talks to a running bridge (default http://localhost:8765) and pins every call
 * to the Node runtime so a browser tab cannot take over mid-test.
 */
const BASE = process.env.LIBREOFFICE_URL || 'http://localhost:8765';
const TARGET = process.env.LIBREOFFICE_TARGET || 'node';

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

async function call(tool, params = {}) {
  const url = `${BASE}/tools/${tool}?target=${encodeURIComponent(TARGET)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (json && json.success === false) {
    throw new Error(`${tool}: ${json.error || JSON.stringify(json)}`);
  }
  return json;
}

async function styleOf(path) {
  const resolved = await call('layout_live', { action: 'resolve', path });
  const value = await call('uno_live', { op: 'get', h: resolved.handle, name: 'ParaStyleName' });
  return value.value;
}

async function main() {
  console.log(`layout smoke: ${BASE} (target=${TARGET})`);

  await call('create_document_live', { doc_type: 'writer' });
  await call('insert_text_live', { text: 'Layout smoke test\nFirst paragraph.\nSecond paragraph.' });

  const p1 = await call('layout_live', { action: 'resolve', path: 'doc/body/p[1]' });
  check('resolve paragraph path', p1.kind === 'text-range' && p1.preview === 'Layout smoke test', p1);

  const before = await call('layout_live', { action: 'status' });
  check('status has a revision and hash', Number.isInteger(before.rev) && typeof before.hash === 'string', before);

  const begin = await call('layout_live', { action: 'begin' });
  check('begin opens an undo group', begin.success === true && begin.mode === 'undo-group', begin);

  const applied = await call('layout_live', {
    action: 'apply',
    ops: [
      { op: 'set', path: 'doc/body/p[1]', values: { ParaStyleName: 'Title' } },
      { op: 'set', path: 'doc/body/p[1]', values: { ParaAdjust: { $e: 'com.sun.star.style.ParagraphAdjust', v: 'CENTER' } } },
      { op: 'set', path: 'doc/body/p[2]', values: { ParaTopMargin: 500 } },
      { op: 'bookmark', path: 'doc/body/p[3]', name: 'third' },
    ],
  });
  check('apply reports every mutation', Array.isArray(applied.results) && applied.results.length >= 4, applied);

  const titleStyle = await styleOf('doc/body/p[1]');
  check('set is applied and readable', titleStyle === 'Title', titleStyle);

  const bookmark = await call('layout_live', { action: 'resolve', path: 'doc/body/bookmark:third' });
  check('bookmark resolves as a stable ID', bookmark.kind === 'text-range' && bookmark.handle > 0, bookmark);

  const measured = await call('layout_live', {
    action: 'measure',
    paths: ['doc/body/p[1]', 'doc/body/p[2]', 'doc/body/p[3]'],
  });
  check('measure returns three boxes', measured.boxes.length === 3, measured);
  const boxes = measured.boxes.map((b) => b.box);
  check('boxes carry numeric geometry', boxes.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.h)), boxes);
  check('vertical order is stable', boxes[0].y <= boxes[1].y && boxes[1].y <= boxes[2].y, boxes);

  const checked = await call('layout_live', {
    action: 'check',
    paths: ['doc/body/p[1]', 'doc/body/p[2]', 'doc/body/p[3]'],
    inside_page: true,
    no_overlap: true,
  });
  check('check passes on a clean page', checked.ok === true, checked.diagnostics);

  const commit = await call('layout_live', { action: 'commit' });
  check('commit advances the revision', commit.rev === before.rev + 1 && typeof commit.hash === 'string', commit);

  const contentBefore = (await call('get_text_content_live')).content || '';
  await call('layout_live', { action: 'begin' });
  await call('layout_live', {
    action: 'apply',
    ops: [{ op: 'insert_text', path: 'doc/body/p[3]', text: '!' }],
  });
  const contentAfter = (await call('get_text_content_live')).content || '';
  check('insert_text targets the range, not the document end', contentAfter.includes('Second paragraph.!'), contentAfter.slice(-80));
  await call('layout_live', { action: 'rollback' });
  const contentRestored = (await call('get_text_content_live')).content || '';
  check('rollback undoes inserted text', contentRestored === contentBefore, { before: contentBefore, after: contentRestored });

  // Rollback must restore both content and formatting.
  await call('layout_live', { action: 'begin' });
  await call('layout_live', {
    action: 'apply',
    ops: [{ op: 'set', path: 'doc/body/p[1]', values: { ParaStyleName: 'Heading 1' } }],
  });
  const changed = await styleOf('doc/body/p[1]');
  check('mutation before rollback is visible', changed === 'Heading 1', changed);

  const rolled = await call('layout_live', { action: 'rollback' });
  check('rollback restores the batch', rolled.success === true, rolled);
  const restored = await styleOf('doc/body/p[1]');
  check('rollback restores formatting', restored === 'Title', restored);

  // A failing apply must not leave a half-applied document or an open group.
  await call('layout_live', { action: 'begin' });
  let failedApply = false;
  try {
    await call('layout_live', {
      action: 'apply',
      ops: [
        { op: 'set', path: 'doc/body/p[1]', values: { ParaStyleName: 'Heading 1' } },
        { op: 'set', path: 'doc/body/p[1]', values: { NoSuchProperty: 1 } },
      ],
    });
  } catch (e) {
    failedApply = true;
  }
  check('failing apply is reported', failedApply);
  const afterFailure = await call('layout_live', { action: 'status' });
  check('failing apply closes the batch', afterFailure.transaction.open === false, afterFailure);
  const styleAfterFailure = await styleOf('doc/body/p[1]');
  check('failing apply rolls back earlier ops', styleAfterFailure === 'Title', styleAfterFailure);

  // Diagnostics must catch a box pushed off the page, and rollback must undo it.
  await call('layout_live', { action: 'begin' });
  await call('layout_live', {
    action: 'apply',
    ops: [{ op: 'set', path: 'doc/body/p[3]', values: { ParaTopMargin: 40000 } }],
  });
  const offPage = await call('layout_live', {
    action: 'check', paths: ['doc/body/p[3]'], inside_page: true, no_overlap: false,
  });
  check('check detects an outside-page box', offPage.ok === false && offPage.diagnostics.some((d) => d.kind === 'outside_page'), offPage.diagnostics);
  await call('layout_live', { action: 'rollback' });
  const backOnPage = await call('layout_live', {
    action: 'check', paths: ['doc/body/p[3]'], inside_page: true, no_overlap: false,
  });
  check('rollback restores the page geometry', backOnPage.ok === true, backOnPage.diagnostics);

  // Same input -> same layout hash.
  const stable = await call('layout_live', { action: 'status' });
  await call('layout_live', { action: 'begin' });
  const noop = await call('layout_live', { action: 'commit' });
  check('no-op commit keeps the layout hash', noop.hash === stable.hash, { before: stable.hash, after: noop.hash });

  // Paths and measurement are not Writer-only.
  await call('create_document_live', { doc_type: 'calc' });
  await call('set_cells_live', { start: 'A1', values: [['Region', 'Amount'], ['North', 12], ['South', 30]] });
  const sheet = await call('layout_live', { action: 'resolve', path: 'doc/sheets[0]' });
  check('resolve sheet path', sheet.success === true && sheet.handle > 0, sheet);
  const calcBox = await call('layout_live', { action: 'measure', paths: ['doc/sheets[0]/cell:A1'] });
  check('measure calc cell', calcBox.boxes.length === 1 && Number.isFinite(calcBox.boxes[0].box.h), calcBox);
  const calcHash1 = (await call('layout_live', { action: 'status' })).hash;
  await call('set_cells_live', { start: 'B2', values: [[99]] });
  const calcHash2 = (await call('layout_live', { action: 'status' })).hash;
  check('calc content changes the hash', calcHash1 !== calcHash2, { before: calcHash1, after: calcHash2 });

  console.log(failures ? `\n${failures} check(s) failed` : '\nall layout checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`layout smoke failed: ${err.message}`);
  process.exit(1);
});
