#!/usr/bin/env node
/*
 * Benchmark helper for docs/benchmark.md.
 *
 *   node scripts/bench.mjs list [cookbook|novel]
 *   node scripts/bench.mjs prepare <id>          # clean the output directory
 *   node scripts/bench.mjs start <id>            # start the timer
 *   node scripts/bench.mjs stop <id> [--calls N] [--pass 1] [--guided 1]
 *        [--cookbook 1] [--describe 0] [--failed 0] [--notes "text"]
 *   node scripts/bench.mjs check <id>           # mechanical artifact checks
 *   node scripts/bench.mjs summary
 *
 * Timers live in bench/.timer/, results in bench/results.csv.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const DB = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'prompts.json'), 'utf8'));
const TIMERS = path.join(ROOT, 'bench', '.timer');
const RESULTS = path.join(ROOT, 'bench', 'results.csv');
const HEADER = 'id,group,guided,wall_seconds,tool_calls,failed_calls,read_cookbook,used_describe,pass,notes';

const [cmd, id, ...rest] = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = rest.indexOf('--' + name);
  return i === -1 ? fallback : (rest[i + 1] ?? fallback);
};

function promptById(pid) {
  const p = DB.prompts.find((x) => x.id.toLowerCase() === String(pid).toLowerCase());
  if (!p) {
    console.error(`Unknown prompt '${pid}'. Try: node scripts/bench.mjs list`);
    process.exit(1);
  }
  return p;
}

const BASE = process.env.LIBREOFFICE_URL || 'http://localhost:8765';

function newestMtime(files) {
  return Math.max(...files.map((f) => fs.statSync(f).mtimeMs));
}

// Seconds the OLDEST running MCP stdio server has been alive. Returns null when
// none is running (the client will spawn a fresh one).
function oldestMcpElapsedSeconds() {
  let out;
  try { out = execSync('ps -eo etimes=,args=', { encoding: 'utf8' }); } catch (e) { return null; }
  let oldest = -1;
  for (const line of out.split('\n')) {
    if (!line.includes('zetaoffice-mcp/start.mjs')) continue;
    const m = /^\s*(\d+)\s+/.exec(line);
    if (m) oldest = Math.max(oldest, Number(m[1]));
  }
  return oldest < 0 ? null : oldest;
}

function assertFreshMcp(force) {
  if (force) return;
  const files = [path.join(ROOT, 'mcp_stdio_server.mjs'), path.join(ROOT, 'start.mjs')]
    .filter((f) => fs.existsSync(f));
  const fileAge = (Date.now() - newestMtime(files)) / 1000;
  const mcpAge = oldestMcpElapsedSeconds();
  if (mcpAge === null) return; // no server yet; the client spawns the current code
  if (mcpAge > fileAge) {
    console.error('\nSTALE MCP SERVER - refusing to benchmark.');
    console.error(`  oldest running start.mjs: ${Math.round(mcpAge)}s old`);
    console.error(`  MCP code last changed:    ${Math.round(fileAge)}s ago`);
    console.error('  Restart OpenCode so fresh agents get the current tools,');
    console.error('  or run with --force to override.\n');
    process.exit(1);
  }
}

async function waitHealth(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function printPrompt(p) {
  console.log(`\nPROMPT ${p.id} [${p.group}]`);
  console.log(p.prompt);
  console.log(`\nchecks (evaluator only): ${p.checks.join('; ')}`);
  console.log(`\nStart the timer: node scripts/bench.mjs start ${p.id}`);
}

if (cmd === 'list' || !cmd) {
  const group = id;
  for (const p of DB.prompts) {
    if (group && p.group !== group) continue;
    console.log(`${p.id}  [${p.group}]  ${p.prompt}`);
    console.log(`     checks: ${p.checks.join('; ')}`);
  }
} else if (cmd === 'prepare') {
  const p = promptById(id);
  const dir = path.isAbsolute(p.output_dir) ? p.output_dir : path.join(ROOT, p.output_dir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  console.log(`prepared ${dir}`);
} else if (cmd === 'reset') {
  const p = promptById(id);
  assertFreshMcp(rest.includes('--force'));
  const dir = path.isAbsolute(p.output_dir) ? p.output_dir : path.join(ROOT, p.output_dir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    await fetch(BASE + '/restart', { method: 'POST' });
  } catch (e) { /* bridge not running; nothing to restart */ }
  await new Promise((r) => setTimeout(r, 1200));
  const healthy = await waitHealth();
  let commit = null;
  try {
    const res = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1000) });
    commit = (await res.json()).commit || null;
  } catch (e) { /* ignore */ }
  console.log(`reset ${p.id}: cleaned ${dir}; bridge ${healthy ? 'healthy' : 'NOT healthy'}${commit ? ` (commit ${commit})` : ''}`);
  if (!healthy) process.exit(1);
  printPrompt(p);
} else if (cmd === 'prompt') {
  printPrompt(promptById(id));
} else if (cmd === 'check') {
  const p = promptById(id);
  const res = spawnSync('python3', [path.join(ROOT, 'scripts', 'bench_check.py'), p.id], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
} else if (cmd === 'start') {
  promptById(id);
  fs.mkdirSync(TIMERS, { recursive: true });
  fs.writeFileSync(path.join(TIMERS, `${id}.json`), JSON.stringify({ start: Date.now() }));
  console.log(`timer started for ${id}`);
} else if (cmd === 'stop') {
  const p = promptById(id);
  const timerFile = path.join(TIMERS, `${id}.json`);
  if (!fs.existsSync(timerFile)) {
    console.error(`No running timer for ${id}. Run: node scripts/bench.mjs start ${id}`);
    process.exit(1);
  }
  const { start } = JSON.parse(fs.readFileSync(timerFile, 'utf8'));
  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  fs.rmSync(timerFile);
  if (!fs.existsSync(RESULTS)) fs.writeFileSync(RESULTS, HEADER + '\n');
  const row = [
    p.id, p.group, flag('guided', '1'), seconds, flag('calls', ''), flag('failed', ''),
    flag('cookbook', ''), flag('describe', ''), flag('pass', '1'), flag('notes', '')
  ].map((v) => String(v).replace(/,/g, ';')).join(',');
  fs.appendFileSync(RESULTS, row + '\n');
  const target = DB.targets[p.group];
  const ok = Number(seconds) <= target.seconds;
  console.log(`${p.id}: ${seconds}s (target ${target.seconds}s) ${ok ? 'OK' : 'OVER'} -> ${RESULTS}`);
} else if (cmd === 'summary') {
  if (!fs.existsSync(RESULTS)) {
    console.log('No results yet.');
    process.exit(0);
  }
  const rows = fs.readFileSync(RESULTS, 'utf8').trim().split('\n').slice(1)
    .map((l) => l.split(','));
  const byId = new Map();
  for (const r of rows) {
    const rec = byId.get(r[0]) || { n: 0, sum: 0, pass: 0, calls: [] };
    rec.n += 1;
    rec.sum += Number(r[3]) || 0;
    if (r[8] === '1') rec.pass += 1;
    if (r[4]) rec.calls.push(Number(r[4]));
    byId.set(r[0], rec);
  }
  console.log('id\tgroup\truns\tavg_s\tpass\tavg_calls');
  for (const p of DB.prompts) {
    const rec = byId.get(p.id);
    if (!rec) continue;
    const avg = (rec.sum / rec.n).toFixed(1);
    const calls = rec.calls.length ? (rec.calls.reduce((a, b) => a + b, 0) / rec.calls.length).toFixed(1) : '-';
    console.log(`${p.id}\t${p.group}\t${rec.n}\t${avg}\t${rec.pass}/${rec.n}\t${calls}`);
  }
} else {
  console.error('Commands: list, prompt, prepare, reset, start, stop, check, summary');
  process.exit(1);
}
