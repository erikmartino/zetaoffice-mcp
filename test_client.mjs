#!/usr/bin/env node
/**
 * Smoke test for a running ZetaOffice MCP bridge.
 *
 *   node test_client.mjs
 *
 * Uses only Node's built-in fetch. It replaces the active document in the
 * bridge, so point it at a development instance (default http://localhost:8765).
 */
const BASE = process.env.LIBREOFFICE_URL || 'http://localhost:8765';

async function call(tool, params = {}) {
  const res = await fetch(`${BASE}/tools/${tool}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(`${tool}: ${json.error || `HTTP ${res.status}`}`);
  }
  return json;
}

try {
  const healthRes = await fetch(`${BASE}/health`);
  if (!healthRes.ok) throw new Error(`health: HTTP ${healthRes.status}`);
  const health = await healthRes.json();
  console.log(`health: ${health.status} | mode: ${health.mode}`);

  console.log('document:', (await call('create_document_live', { doc_type: 'writer' })).message);
  console.log('text    :', (await call('insert_text_live', { text: 'ZetaOffice MCP smoke test' })).message);
  console.log('formula :', (await call('insert_formula_live', {
    formula: 'e^{i %pi} + 1 = 0',
    display: true,
    align: 'center',
  })).message);

  const list = await call('list_formulas_live');
  console.log(`formulas: ${list.count}`, list.formulas.map((f) => f.formula));
  if (list.count < 1) throw new Error('formula was not created');

  console.log('\nOK');
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  console.error(`Is the bridge running at ${BASE}? Start it with: node server.mjs --node`);
  process.exit(1);
}
