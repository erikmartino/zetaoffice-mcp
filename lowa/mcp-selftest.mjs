import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['mcp_stdio_server.mjs'],
  cwd: new URL('..', import.meta.url).pathname,
  stderr: 'pipe',
});
const client = new Client({ name: 'selftest', version: '1.0.0' });
await client.connect(transport);
const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));
console.log('DESC[text]:', tools.tools.find(t=>t.name==='text').description.slice(0, 160).replace(/\n/g,' | '));
const res = await client.listResources();
console.log('RESOURCES:', JSON.stringify(res.resources?.map(r=>r.uri)));
const g = await client.readResource({ uri: 'libreoffice://guide' });
console.log('GUIDE chars:', g.contents[0].text.length);
const bad = await client.callTool({ name: 'structure', arguments: { action: 'paragraph' } });
console.log('BAD CALL:', bad.content[0].text.replace(/\n/g,' ').slice(0,220));
await client.close();
