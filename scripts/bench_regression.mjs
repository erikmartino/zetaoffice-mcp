#!/usr/bin/env node
/*
 * Mechanical bench regression for the layout/editor changes.
 *
 * This is not a fresh-agent benchmark run. It drives a fresh MCP stdio server
 * with scripted tool calls, writes the artifacts into bench/out/<id>, and then
 * uses the same `scripts/bench.mjs check` evaluator as the benchmark.
 *
 *   node scripts/bench_regression.mjs
 *   node scripts/bench_regression.mjs A1 B1 B9
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const BASE = process.env.LIBREOFFICE_URL || 'http://localhost:8765';
const out = (id, name) => path.join(ROOT, 'bench', 'out', id, name);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['start.mjs'],
  cwd: ROOT,
  env: { ...process.env, LIBREOFFICE_URL: BASE, LIBREOFFICE_TARGET: 'node' },
  stderr: 'pipe',
});

const client = new Client({ name: 'bench-regression', version: '1.0.0' });

async function tool(name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.find((part) => part.type === 'text')?.text || '{}';
  const value = JSON.parse(text);
  if (value && value.success === false) throw new Error(`${name}: ${value.error || text}`);
  return value;
}

function prepare(id) {
  const result = spawnSync(process.execPath, ['scripts/bench.mjs', 'prepare', id], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `prepare ${id} failed`);
}

function check(id) {
  const result = spawnSync('python3', ['scripts/bench_check.py', id], { cwd: ROOT, encoding: 'utf8' });
  return { ok: result.status === 0, text: (result.stdout + result.stderr).trim() };
}

const cases = {
  async A1() {
    await tool('document', { action: 'create', doc_type: 'writer' });
    await tool('text', {
      action: 'insert',
      content: 'Notice of Inspection\nAugust 12, 2026\n\nThe inspection will take place on August 20, 2026.\nPlease ensure access to all rooms.',
    });
    await tool('text', { action: 'style', style_name: 'Title', paragraph_n: 1 });
    await tool('save', { action: 'export', file_path: out('A1', 'letter.odt'), export_format: 'odt' });
    await tool('save', { action: 'export', file_path: out('A1', 'letter.pdf'), export_format: 'pdf' });
  },

  async A2() {
    await tool('document', { action: 'create', doc_type: 'calc' });
    await tool('sheet', {
      action: 'write',
      values: [
        ['Date', 'Weight (g)'],
        ['2026-01-05', 70], ['2026-01-12', 71], ['2026-01-19', 72],
        ['2026-01-26', 73], ['2026-02-02', 74],
      ],
    });
    await tool('sheet', { action: 'format', range: 'A1:B1', bold: true });
    await tool('sheet', {
      action: 'chart', data_range: 'A1:B6', chart_type: 'line',
      title: 'Weight', x_title: 'Date', y_title: 'Weight (g)',
    });
    await tool('save', { action: 'export', file_path: out('A2', 'weights.xlsx'), export_format: 'xlsx' });
  },

  async A3() {
    await tool('document', { action: 'create', doc_type: 'writer' });
    await tool('text', { action: 'insert', content: 'Embedded report\n\nBelow is the sheet:' });
    await tool('embed', {
      service: 'calc', width_mm: 120, height_mm: 60,
      values: [['Item', 'Qty'], ['Alpha', 1], ['Beta', 2], ['Gamma', 3]],
    });
    await tool('save', { action: 'export', file_path: out('A3', 'report.odt'), export_format: 'odt' });
    await tool('save', { action: 'export', file_path: out('A3', 'report.docx'), export_format: 'docx' });
  },

  async A4() {
    await tool('document', { action: 'create', doc_type: 'writer' });
    await tool('text', { action: 'insert', content: 'Quarterly report\n\n' });
    await tool('embed', {
      service: 'calc', width_mm: 160, height_mm: 90,
      values: [
        ['Item', 'Amount'], ['North', 120], ['South', 90],
        ['East', 60], ['West', 30], ['Total', 300],
      ],
      chart: { title: 'Sales by region', x_title: 'Item', y_title: 'Amount' },
    });
    await tool('save', { action: 'export', file_path: out('A4', 'report.odt'), export_format: 'odt' });
    await tool('save', { action: 'export', file_path: out('A4', 'report.pdf'), export_format: 'pdf' });
  },

  async A5() {
    await tool('document', { action: 'create', doc_type: 'writer' });
    await tool('text', { action: 'insert', content: 'The quadratic formula:\n\n' });
    await tool('formula', { action: 'insert', formula: 'x = {-b +- sqrt{b^2 - 4ac}} over 2a' });
    await tool('save', { action: 'export', file_path: out('A5', 'formula.odt'), export_format: 'odt' });
  },

  async A6() {
    await tool('document', { action: 'create', doc_type: 'calc' });
    await tool('sheet', {
      action: 'write',
      values: [['Date', 'Weight (g)'], ['2026-01-05', 70], ['2026-01-12', 71], ['2026-01-19', 72], ['2026-01-26', 73], ['2026-02-02', 74]],
    });
    await tool('sheet', { action: 'format', range: 'A1:B1', bold: true });
    await tool('sheet', { action: 'column_width', column: 'A', width_mm: 30 });
    await tool('sheet', { action: 'freeze', rows: 1 });
    await tool('save', { action: 'export', file_path: out('A6', 'table.xlsx'), export_format: 'xlsx' });
  },

  async A10() {
    await tool('document', { action: 'create', doc_type: 'writer' });
    await tool('text', { action: 'insert', content: 'Picture\n\n' });
    await tool('picture', { action: 'insert', file_path: path.join(ROOT, 'bench', 'assets', 'sample.png'), width: 6 });
    await tool('save', { action: 'export', file_path: out('A10', 'note.odt'), export_format: 'odt' });
  },

  async B1() {
    await tool('document', { action: 'create', doc_type: 'writer' });
    await tool('text', { action: 'insert', content: 'Inventory\n\n' });
    await tool('table', {
      action: 'create', total_column: 2,
      values: [['Item', 'Qty', 'Price'], ['Alpha', 1, 10], ['Beta', 2, 20], ['Gamma', 3, 30], ['Delta', 4, 40]],
    });
    await tool('save', { action: 'export', file_path: out('B1', 'table.odt'), export_format: 'odt' });
  },

  async B2() {
    await tool('document', { action: 'create', doc_type: 'writer' });
    await tool('page', { action: 'setup', orientation: 'landscape', margins_cm: 1.5 });
    await tool('page', { action: 'header_footer', header: 'Confidential', footer: 'Page ', page_number: true });
    await tool('text', { action: 'insert', content: 'Report body\n\nThis page is landscape.' });
    await tool('save', { action: 'export', file_path: out('B2', 'report.pdf'), export_format: 'pdf' });
  },

  async B9() {
    await tool('document', {
      action: 'create', doc_type: 'presentation',
      slides: [
        { title: 'Roadmap', text: '2026 priorities' },
        { title: 'Plan', text: '• Discovery\n• Build\n• Launch' },
        { title: 'Thank you', text: 'Questions?' },
      ],
    });
    await tool('save', { action: 'export', file_path: out('B9', 'deck.pptx'), export_format: 'pptx' });
  },

  async A9() {
    await tool('bridge', { action: 'status' });
  },
};

async function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const ids = requested.length ? requested : Object.keys(cases);
  const results = [];

  await client.connect(transport);
  try {
    for (const id of ids) {
      if (!cases[id]) {
        results.push({ id, ok: false, detail: 'no such case' });
        continue;
      }
      prepare(id);
      try {
        await cases[id]();
        const result = check(id);
        results.push({ id, ok: result.ok, detail: result.text });
      } catch (err) {
        results.push({ id, ok: false, detail: err.message });
      }
    }
  } finally {
    await client.close();
  }

  console.log('\nbench regression');
  for (const row of results) {
    console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.id}`);
    if (!row.ok) console.log(row.detail.split('\n').map((line) => `      ${line}`).join('\n'));
  }
  const failed = results.filter((row) => !row.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`bench regression failed: ${err.message}`);
  process.exit(1);
});
