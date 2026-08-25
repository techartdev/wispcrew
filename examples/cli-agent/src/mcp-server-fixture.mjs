// Tiny MCP stdio server used by the integration test.
// Implements initialize, notifications/initialized, tools/list, tools/call.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
let initialized = false;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params = {} } = msg;

  if (method === 'initialize') {
    initialized = true;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'wispcrew-fixture-server', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return; // no response
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'add',
            description: 'Add two numbers together.',
            inputSchema: {
              type: 'object',
              properties: {
                a: { type: 'number', description: 'first addend' },
                b: { type: 'number', description: 'second addend' },
              },
              required: ['a', 'b'],
            },
          },
          {
            name: 'echo',
            description: 'Echo back the text argument.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      },
    });
    return;
  }
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;
    if (name === 'add') {
      const sum = Number(args.a) + Number(args.b);
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `sum = ${sum}` }], isError: false },
      });
      return;
    }
    if (name === 'echo') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: String(args.text ?? '') }], isError: false },
      });
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
});
