#!/usr/bin/env node
// @ts-nocheck
import readline from 'node:readline';
import { ROOT, readJson } from '../shared/utils.js';
import { listCommands, loadCommand } from '../model/command_store.js';
import { executeCommand, getExecutionCapability } from '../engine/execute.js';
import { learnAction } from '../nl/learn.js';
import { verifyCommand } from '../model/verify.js';
import { buildAgentManifest, describeCommand, explainNaturalLanguage } from '../model/describe.js';
import { doctorCommand } from '../model/doctor.js';
import { buildScheduleSpec } from '../schedule/schedule.js';
import { generateCommandDocs } from '../io/docs.js';

// 用 utils.ROOT（按 package.json+commands 向上探测，与文件层级无关）读版本，
// 避免硬编码相对深度——src 分层后这种 `../../package.json` 会失效。
const pkg = readJson(`${ROOT}/package.json`);
const SERVER_INFO = { name: 'platform-command', version: pkg.version };

// 已装命令覆盖的平台前缀（listCommands() 返回命令名字符串数组，如 "mss.export_weekly"）。
export function coveredPlatforms() {
  try {
    return [...new Set((listCommands() || []).map((c) => String(typeof c === 'string' ? c : c?.name || '').split('.')[0]).filter(Boolean))];
  } catch {
    return []; // 列表失败不致命
  }
}

// tools/list 时给关键工具描述动态追加「覆盖平台」——工具描述所有 MCP 客户端都会喂给模型，
// 比可能被忽略的 initialize.instructions 更可靠地引导 agent 路由到 platform-command。
export function toolsWithContext() {
  const platforms = coveredPlatforms();
  if (!platforms.length) return MCP_TOOLS;
  const suffix = ` Covered platforms (use this instead of writing HTTP/git/browser code for them): ${platforms.join(', ')}.`;
  return MCP_TOOLS.map((t) =>
    (t.name === 'platform_command_execute' || t.name === 'platform_command_list')
      ? { ...t, description: t.description + suffix }
      : t);
}

// MCP initialize.instructions：客户端会把它喂进模型上下文，引导 agent「何时该优先用本服务」。
export function buildServerInstructions() {
  const platforms = coveredPlatforms();
  const list = platforms.length ? platforms.join('、') : '（用 platform_command_list 查看）';
  return [
    `platform-command 提供一批可复用、带登录态会话与审计的平台命令，覆盖平台：${list}。`,
    `凡涉及这些平台的操作（查询 / 导出 / 发帖 / 发邮件 / 同步 / 调度等），必须优先用本服务的 platform_command_* 工具，`,
    `不要自己写 HTTP / curl / git / 浏览器脚本去做——那会绕过登录态、审计与参数校验。`,
    `流程：先 platform_command_list 或 platform_command_explain 找命令 → platform_command_describe 看参数 → platform_command_execute 执行（默认 dry-run；真实执行传 dryRun:false 且 confirm:true）。`,
    `命令报错或不可执行时如实回报，不要绕过去自行实现。`
  ].join('\n');
}

export const MCP_TOOLS = [
  {
    name: 'platform_command_list',
    description: 'List available platform commands (by platform.action name). Call this FIRST whenever a task involves a covered platform, before writing any HTTP/git/browser code yourself. External commands override builtin commands.',
    inputSchema: {
      type: 'object',
      properties: { detailed: { type: 'boolean', description: 'Return file/source/package metadata.' } }
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
    name: 'platform_command_explain',
    description: 'Explain a natural language request and show the selected command, params, and clarification needs.',
    inputSchema: { type: 'object', required: ['input'], properties: { input: { type: 'string' } } }
  },
  {
    name: 'platform_command_agent_manifest',
    description: 'Return an agent-friendly manifest of available commands.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'platform_command_doctor',
    description: 'Run command health checks.',
    inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } }
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
    description: 'Run a platform command (preferred way to act on any covered platform — do NOT hand-write HTTP/curl/git/browser scripts for these). Defaults to dry-run; for real execution pass dryRun:false AND confirm:true. May still be blocked by policy.',
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
  },
  {
    name: 'platform_command_schedule',
    description: 'Generate an advisory host-scheduler specification for running a platform command. Does not install tasks.',
    inputSchema: {
      type: 'object',
      required: ['command', 'cron'],
      properties: { command: { type: 'string' }, cron: { type: 'string' }, timezone: { type: 'string' }, params: { type: 'object' }, dryRun: { type: 'boolean' }, confirm: { type: 'boolean' } }
    }
  },
  {
    name: 'platform_command_docs',
    description: 'Generate markdown documentation for available platform-command definitions.',
    inputSchema: { type: 'object', properties: { outputPath: { type: 'string' } } }
  },
  {
    name: 'platform_command_learn',
    description: 'Learn a new platform action from a URL using the same contract as the CLI learn command.',
    inputSchema: {
      type: 'object',
      required: ['url', 'platform', 'action'],
      properties: {
        url: { type: 'string' },
        platform: { type: 'string' },
        action: { type: 'string' },
        provider: { type: 'string', enum: ['auto', 'manual', 'playwright'], default: 'auto' },
        headless: { type: 'boolean', default: true },
        timeoutMs: { type: 'number' }
      }
    }
  }
];

export const MCP_RESOURCES = [
  {
    uri: 'platform-command://commands',
    name: 'platform-command command catalog',
    description: 'Catalog of available commands with source and package metadata.',
    mimeType: 'application/json'
  },
  {
    uri: 'platform-command://distribution',
    name: 'platform-command distribution guide',
    description: 'How to install, extend, and distribute platform-command command packages.',
    mimeType: 'text/markdown'
  }
];

export const MCP_PROMPTS = [
  {
    name: 'platform_command_build_command',
    description: 'Guide an agent to create a business-specific platform-command JSON command safely.',
    arguments: [
      { name: 'platform', description: 'Target platform or product name.', required: true },
      { name: 'action', description: 'Business action to automate.', required: true }
    ]
  },
  {
    name: 'platform_command_execute_safely',
    description: 'Guide an agent to verify and dry-run before executing a platform command.',
    arguments: [{ name: 'command', description: 'Command name such as github.list_issues.', required: true }]
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
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: SERVER_INFO,
        instructions: buildServerInstructions()
      }
    };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: toolsWithContext() } };
  if (method === 'tools/call') return { jsonrpc: '2.0', id, result: await callTool(params.name, params.arguments || {}) };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: MCP_RESOURCES } };
  if (method === 'resources/read') return { jsonrpc: '2.0', id, result: readResource(params.uri) };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: MCP_PROMPTS } };
  if (method === 'prompts/get') return { jsonrpc: '2.0', id, result: getPrompt(params.name, params.arguments || {}) };
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function callTool(name, args) {
  if (name === 'platform_command_list') return toolResult({ commands: listCommands({ detailed: !!args.detailed }) });
  if (name === 'platform_command_describe') {
    const { file, source, command } = loadCommand(args.command);
    return toolResult({ file, source, command, execution: getExecutionCapability(command) });
  }
  if (name === 'platform_command_verify') return toolResult(verifyCommand(args.command));
  if (name === 'platform_command_execute') {
    const dryRun = args.dryRun !== false;
    const result = await executeCommand(args.command, args.params || {}, { dryRun, confirm: !!args.confirm });
    return toolResult(result);
  }
  if (name === 'platform_command_explain') return toolResult(explainNaturalLanguage(args.input || ''));
  if (name === 'platform_command_agent_manifest') return toolResult(buildAgentManifest());
  if (name === 'platform_command_doctor') return toolResult(doctorCommand(args.command));
  if (name === 'platform_command_schedule') return toolResult(buildScheduleSpec({ command: args.command, cron: args.cron, timezone: args.timezone, params: args.params || {}, dryRun: args.dryRun !== false, confirm: !!args.confirm }));
  if (name === 'platform_command_docs') return toolResult(generateCommandDocs({ outputPath: args.outputPath }));
  if (name === 'platform_command_learn') {
    const result = await learnAction({
      url: args.url,
      platform: args.platform,
      action: args.action,
      provider: args.provider || 'auto',
      headless: args.headless !== false,
      timeoutMs: args.timeoutMs
    });
    return toolResult(result);
  }
  return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
}

function readResource(uri) {
  if (uri === 'platform-command://commands') {
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ commands: listCommands({ detailed: true }) }, null, 2) }] };
  }
  if (uri === 'platform-command://distribution') {
    return { contents: [{ uri, mimeType: 'text/markdown', text: distributionGuide() }] };
  }
  return { contents: [{ uri, mimeType: 'text/plain', text: `Unknown resource: ${uri}` }] };
}

function getPrompt(name, args) {
  if (name === 'platform_command_build_command') {
    const platform = args.platform || '<platform>';
    const action = args.action || '<action>';
    return { messages: [{ role: 'user', content: { type: 'text', text: `Create a platform-command JSON command for ${platform}.${action}. First define parameters and riskLevel, then prefer API workflow steps, add UI/manual fallback, run platform-command verify, and dry-run before real execution.` } }] };
  }
  if (name === 'platform_command_execute_safely') {
    const command = args.command || '<command>';
    return { messages: [{ role: 'user', content: { type: 'text', text: `Use platform-command safely for ${command}: describe it, verify it, run execute with dryRun=true, inspect the plan and riskLevel, then only run with confirm=true if policy and user approval allow it.` } }] };
  }
  return { messages: [{ role: 'user', content: { type: 'text', text: `Unknown prompt: ${name}` } }] };
}

function distributionGuide() {
  return `# platform-command distribution\n\n- Install the framework with npm or from git.\n- Builtin public commands live in commands/*.json.\n- Business teams add their own JSON commands in a local commands/ directory or set PLATFORM_COMMANDS_DIR.\n- External commands override builtin commands with the same name.\n- MCP clients can discover tools, resources, and prompts; CLI remains the fallback entrypoint.\n`;
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
