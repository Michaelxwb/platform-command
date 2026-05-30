#!/usr/bin/env node
import readline from 'node:readline';
import { listCommands, loadCommand } from './command_store.js';
import { executeCommand } from './execute.js';
import { verifyCommand } from './verify.js';

const SERVER_INFO = { name: 'platform-command', version: '0.3.0' };

export const MCP_TOOLS = [
  {
    name: 'platform_command_list',
    description: 'List available platform-command command definitions. External commands override builtin commands.',
    inputSchema: {
      type: 'object',
      properties: { detailed: { type: 'boolean', description: 'Return file/source metadata.' } }
    }
  },
  {
    name: 'platform_command_describe',
    description: 'Describe one command definition including parameters and risk level.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: { command: { type: 'string' } }
    }
  },
  {
    name: 'platform_command_verify',
    description: 'Validate a command definition and workflow structure.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: { command: { type: 'string' } }
    }
  },
  {
    name: 'platform_command_execute',
    description: 'Execute or dry-run a platform command. Defaults to dry-run; real execution requires confirm and may still be blocked by policy.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string' },
        params: { type: 'object', additionalProperties: true },
        dryRun: { type: 'boolean', default: true },
        confirm: { type: 'boolean', default: false }
      }
    }
  }
];

export async function handleMcpRequest(message) {
  if (!message || typeof message !== 'object') throw new Error('Invalid JSON-RPC message');
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      }
    };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }
  if (method === 'tools/call') {
    const result = await callTool(params.name, params.arguments || {});
    return { jsonrpc: '2.0', id, result };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function callTool(name, args) {
  if (name === 'platform_command_list') return toolResult({ commands: listCommands({ detailed: !!args.detailed }) });
  if (name === 'platform_command_describe') {
    const { file, source, command } = loadCommand(args.command);
    return toolResult({ file, source, command });
  }
  if (name === 'platform_command_verify') return toolResult(verifyCommand(args.command));
  if (name === 'platform_command_execute') {
    const dryRun = args.dryRun !== false;
    const result = await executeCommand(args.command, args.params || {}, { dryRun, confirm: !!args.confirm });
    return toolResult(result);
  }
  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${name}` }]
  };
}

function toolResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export async function runMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let response;
    try {
      response = await handleMcpRequest(JSON.parse(line));
    } catch (error) {
      response = { jsonrpc: '2.0', id: null, error: { code: -32000, message: error.message } };
    }
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  runMcpServer().catch((error) => {
    console.error(`[platform-command mcp] ${error.stack || error.message}`);
    process.exit(1);
  });
}
