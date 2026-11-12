#!/usr/bin/env node
/*
 * Verifies that the deterministic layout API is actually exposed as an MCP
 * tool. Spawns a fresh stdio server against the running bridge, so it does not
 * depend on the client that happens to be open in the current session.
 *
 *   node scripts/layout_mcp_test.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASE = process.env.LIBREOFFICE_URL || 'http://localhost:8765';

function check(name, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) process.exitCode = 1;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['start.mjs'],
  env: {
    ...process.env,
    LIBREOFFICE_URL: BASE,
    LIBREOFFICE_TARGET: 'node',
  },
  stderr: 'pipe',
});

const client = new Client({ name: 'layout-mcp-test', version: '1.0.0' });
try {
  await client.connect(transport);

  const listed = await client.listTools();
  const names = (listed.tools || []).map((tool) => tool.name);
  check('layout tool is registered', names.includes('layout'), names);

  const status = await client.callTool({ name: 'layout', arguments: { action: 'status' } });
  const statusText = status.content?.find((part) => part.type === 'text')?.text || '';
  const statusJson = JSON.parse(statusText);
  check('layout.status is callable over MCP', statusJson.success === true && Number.isInteger(statusJson.rev), statusJson);

  await client.callTool({ name: 'document', arguments: { action: 'create', doc_type: 'writer' } });
  const resolved = await client.callTool({
    name: 'layout',
    arguments: { action: 'resolve', path: 'doc/body/p[1]' },
  });
  const resolvedJson = JSON.parse(resolved.content?.find((part) => part.type === 'text')?.text || '{}');
  check('layout.resolve is callable over MCP', resolvedJson.success === true && resolvedJson.handle > 0, resolvedJson);
} finally {
  await client.close();
}

console.log(process.exitCode ? '\nMCP layout checks failed' : '\nall MCP layout checks passed');
