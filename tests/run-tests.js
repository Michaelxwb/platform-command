import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { listCommands, loadCommand, mergeParams } from '../src/command_store.js';
import { buildWorkflowPlan } from '../src/workflow.js';
import { verifyCommand } from '../src/verify.js';
import { formatHumanReadable, parseNaturalLanguage } from '../src/nl.js';
import { learnAction } from '../src/learn.js';
import { handleMcpRequest } from '../src/mcp_server.js';

const commandsDir = path.join(process.cwd(), 'commands');

const nlIssues = parseNaturalLanguage('在 GitHub 上，查看 zhaoxuya520/reverse-skill 的 issues，状态 all');
assert.equal(nlIssues.command, 'github.list_issues');
assert.deepEqual(nlIssues.params, { owner: 'zhaoxuya520', repo: 'reverse-skill', state: 'all' });
assert.ok(nlIssues.confidence >= 0.95);

const nlCommits = parseNaturalLanguage('列出 GitHub 仓库 Michaelxwb/platform-command 的 commits，分支 master');
assert.equal(nlCommits.command, 'github.list_commits');
assert.deepEqual(nlCommits.params, { owner: 'Michaelxwb', repo: 'platform-command', branch: 'master' });

const nlSearch = parseNaturalLanguage('在 GitHub 搜索仓库 platform-command user:Michaelxwb，最多 3');
assert.equal(nlSearch.command, 'github.search_repositories');
assert.equal(nlSearch.params.query, 'platform-command user:Michaelxwb');
assert.equal(nlSearch.params.limit, 3);

const nlInspect = parseNaturalLanguage('巡检 GitHub 仓库 Michaelxwb/platform-command');
assert.equal(nlInspect.command, 'github.inspect_repository');
assert.deepEqual(nlInspect.params, { owner: 'Michaelxwb', repo: 'platform-command', branch: 'master' });

const nlBilibili = parseNaturalLanguage('给 bilibili 视频 https://www.bilibili.com/video/BV1YNGn6CEcH 评论：测试评论，并自动发布');
assert.equal(nlBilibili.command, 'bilibili.post_comment');
assert.deepEqual(nlBilibili.params, { videoUrl: 'https://www.bilibili.com/video/BV1YNGn6CEcH', commentText: '测试评论', autoPublish: true });

const readable = formatHumanReadable({
  parsed: nlIssues,
  result: {
    status: 'dry_run',
    riskLevel: 'low',
    params: nlIssues.params,
    plan: { kind: 'workflow', steps: [{ id: 'issues_api', type: 'api' }, { id: 'issues_page', type: 'ui' }] }
  }
});
assert.ok(readable.includes('已识别并调用封装 Workflow'));
assert.ok(readable.includes('github.list_issues'));
assert.ok(readable.includes('issues_api(api) -> issues_page(ui)'));


const demo = verifyCommand('demo.search_example');
assert.equal(demo.ok, true, demo.errors.join('\n'));

const merged = mergeParams(demo.command, { keyword: 'abc', page: '2' });
assert.equal(merged.keyword, 'abc');
assert.equal(merged.page, 2);
assert.equal(typeof merged.page, 'number');
assert.throws(() => mergeParams(demo.command, { keyword: 'abc', page: 'NaN-ish' }), /must be a number/);

const help = execFileSync('node', ['src/cli.js', '--help'], { encoding: 'utf8' });
assert.match(help, /--execute-real --confirm/);

const dry = execFileSync('node', ['src/cli.js', 'execute', '--command', 'demo.search_example', '--dry-run', 'keyword=abc'], { encoding: 'utf8' });
const parsed = JSON.parse(dry);
assert.equal(parsed.status, 'dry_run');
assert.equal(parsed.params.keyword, 'abc');
assert.equal(parsed.params.page, 1);

const conflict = spawnSync('node', ['src/cli.js', 'execute', '--command', 'demo.search_example', '--dry-run', '--execute-real', 'keyword=abc'], { encoding: 'utf8' });
assert.notEqual(conflict.status, 0);
assert.match(conflict.stderr, /cannot be used together/);

const realWithoutConfirm = spawnSync('node', ['src/cli.js', 'execute', '--command', 'demo.search_example', '--execute-real', 'keyword=abc'], { encoding: 'utf8' });
assert.notEqual(realWithoutConfirm.status, 0);
assert.match(realWithoutConfirm.stderr, /requires --confirm/);



const externalCommandsDir = path.join(process.cwd(), '.tmp-external-commands');
const externalDemoFile = path.join(externalCommandsDir, 'demo.search_example.json');
try {
  fs.rmSync(externalCommandsDir, { recursive: true, force: true });
  fs.mkdirSync(externalCommandsDir, { recursive: true });
  const externalCommand = structuredClone(demo.command);
  externalCommand.description = 'External override command for tests';
  externalCommand.parameters.page.default = 9;
  fs.writeFileSync(externalDemoFile, JSON.stringify(externalCommand, null, 2));

  const oldEnv = process.env.PLATFORM_COMMANDS_DIR;
  process.env.PLATFORM_COMMANDS_DIR = externalCommandsDir;
  try {
    const detailedList = listCommands({ detailed: true });
    const listedExternal = detailedList.find((item) => item.name === 'demo.search_example');
    assert.ok(listedExternal, 'external command should be listed');
    assert.equal(listedExternal.source, 'external');
    assert.equal(loadCommand('demo.search_example').source, 'external');
    assert.equal(loadCommand('demo.search_example').command.parameters.page.default, 9);
  } finally {
    if (oldEnv === undefined) delete process.env.PLATFORM_COMMANDS_DIR;
    else process.env.PLATFORM_COMMANDS_DIR = oldEnv;
  }
} finally {
  fs.rmSync(externalCommandsDir, { recursive: true, force: true });
}

const listJson = JSON.parse(execFileSync('node', ['src/cli.js', 'list', '--json'], { encoding: 'utf8' }));
const listedBuiltin = listJson.commands.find((item) => item.name === 'demo.search_example' && item.source === 'builtin');
assert.ok(listedBuiltin);
assert.equal(listedBuiltin.package.type, 'builtin');
assert.equal(listedBuiltin.package.name, JSON.parse(fs.readFileSync('package.json', 'utf8')).name);

const exampleExternalDir = path.join(process.cwd(), 'examples', 'external-commands');
const externalListJson = JSON.parse(execFileSync('node', ['src/cli.js', 'list', '--json', '--commands-dir', exampleExternalDir], { encoding: 'utf8' }));
assert.ok(externalListJson.commands.some((item) => item.name === 'crm.search_customer' && item.source === 'external'));
const externalVerifyJson = JSON.parse(execFileSync('node', ['src/cli.js', 'verify', '--commands-dir', exampleExternalDir, '--command', 'crm.search_customer'], { encoding: 'utf8' }));
assert.equal(externalVerifyJson.ok, true, externalVerifyJson.errors.join('\n'));
const externalDryJson = JSON.parse(execFileSync('node', ['src/cli.js', 'execute', '--commands-dir', exampleExternalDir, '--command', 'order.refund_preview', '--dry-run', 'orderId=ORD-10001', 'reason=customer_request'], { encoding: 'utf8' }));
assert.equal(externalDryJson.status, 'dry_run');
assert.equal(externalDryJson.command, 'order.refund_preview');
assert.equal(externalDryJson.plan.kind, 'workflow');

const mcpInput = [
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'platform_command_execute', arguments: { command: 'demo.search_example', params: { keyword: 'abc' }, dryRun: true } } })
].join('\n') + '\n';
const mcpRun = spawnSync('node', ['src/mcp_server.js'], { input: mcpInput, encoding: 'utf8' });
assert.equal(mcpRun.status, 0, mcpRun.stderr);
const mcpLines = mcpRun.stdout.trim().split(/\n+/).map((line) => JSON.parse(line));
assert.equal(mcpLines[0].result.serverInfo.name, 'platform-command');
assert.ok(mcpLines[1].result.tools.some((tool) => tool.name === 'platform_command_list'));
const mcpExecutePayload = JSON.parse(mcpLines[2].result.content[0].text);
assert.equal(mcpExecutePayload.status, 'dry_run');
assert.equal(mcpExecutePayload.params.keyword, 'abc');

const workflowVerify = verifyCommand('demo.workflow_example');
assert.equal(workflowVerify.ok, true, workflowVerify.errors.join('\n'));

const workflowDry = execFileSync('node', ['src/cli.js', 'execute', '--command', 'demo.workflow_example', '--dry-run', 'keyword=abc', 'limit=5'], { encoding: 'utf8' });
const workflowParsed = JSON.parse(workflowDry);
assert.equal(workflowParsed.status, 'dry_run');
assert.equal(workflowParsed.plan.kind, 'workflow');
assert.equal(workflowParsed.plan.steps.length, 4);
assert.equal(workflowParsed.plan.steps[0].request.query.q, 'abc');
assert.equal(workflowParsed.plan.steps[0].request.query.limit, '5');
assert.equal(workflowParsed.plan.steps[1].request.url, 'https://example.com/api/items/demo-item-001');
const uiStep = workflowParsed.plan.steps.find((step) => step.id === 'open_detail_page');
assert.ok(uiStep, 'UI step should exist');
assert.deepEqual(uiStep.ui.actions.map((item) => item.action), ['goto', 'waitFor', 'assert', 'screenshot']);
assert.equal(workflowParsed.session.containsSecretMaterial, false);
const serialized = JSON.stringify(workflowParsed);
assert.doesNotMatch(serialized, /Bearer\s+/i);
assert.doesNotMatch(serialized, /Authorization\"\s*:\s*\"(?!\[REDACTED\])/i);
assert.doesNotMatch(serialized, /Cookie\"\s*:\s*\"(?!\[REDACTED\])/i);
assert.doesNotMatch(serialized, /password\"\s*:\s*\"[^\[]+/i);
assert.doesNotMatch(serialized, /secret\"\s*:\s*\"[^\[]+/i);

const unresolvedCommand = structuredClone(workflowVerify.command);
unresolvedCommand.execution.workflow.steps[0].request.query.missing = '{{notDeclared}}';
const unresolvedPlan = buildWorkflowPlan(unresolvedCommand, { keyword: 'abc', page: 1, limit: 5 });
assert.ok(unresolvedPlan.warnings.some((item) => item.code === 'UNRESOLVED_TEMPLATE' && item.expression === 'notDeclared'));
assert.throws(() => buildWorkflowPlan(unresolvedCommand, { keyword: 'abc', page: 1, limit: 5 }, { failOnUnresolvedTemplates: true }), /Unresolved template reference/);

const invalidName = '__invalid.workflow_validation';
const invalidFile = path.join(commandsDir, `${invalidName}.json`);
try {
  const invalid = structuredClone(workflowVerify.command);
  invalid.name = invalidName;
  invalid.naturalLanguage = { extract: { missing: { type: 'regex', pattern: '[' } } };
  invalid.execution.workflow.steps = [
    { id: 'search', type: 'api', request: { method: 'GET' } },
    { id: 'open', type: 'ui', dependsOn: ['missing'], ui: { actions: [{ action: 'fill', selector: '#q' }] } },
    { id: 'cycle_a', type: 'manual', dependsOn: ['cycle_b'], manual: 'a' },
    { id: 'cycle_b', type: 'manual', dependsOn: ['cycle_a'], manual: 'b' }
  ];
  fs.writeFileSync(invalidFile, JSON.stringify(invalid, null, 2));
  const invalidVerify = verifyCommand(invalidName);
  assert.equal(invalidVerify.ok, false);
  assert.ok(invalidVerify.errors.some((error) => error.includes('request.url is required')));
  assert.ok(invalidVerify.errors.some((error) => error.includes('dependsOn references unknown step')));
  assert.ok(invalidVerify.errors.some((error) => error.includes('selector and .value are required for fill')));
  assert.ok(invalidVerify.errors.some((error) => error.includes('circular dependency')));
  assert.ok(invalidVerify.errors.some((error) => error.includes('naturalLanguage.extract.missing references unknown parameter')));
  assert.ok(invalidVerify.errors.some((error) => error.includes('naturalLanguage.extract.missing.pattern must be a valid RegExp')));
} finally {
  if (fs.existsSync(invalidFile)) fs.unlinkSync(invalidFile);
}


const initResponse = await handleMcpRequest({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} });
assert.deepEqual(initResponse.result.capabilities, { tools: {}, resources: {}, prompts: {} });
const resourcesResponse = await handleMcpRequest({ jsonrpc: '2.0', id: 11, method: 'resources/list' });
assert.ok(resourcesResponse.result.resources.some((resource) => resource.uri === 'platform-command://commands'));
const commandsResource = await handleMcpRequest({ jsonrpc: '2.0', id: 12, method: 'resources/read', params: { uri: 'platform-command://commands' } });
assert.match(commandsResource.result.contents[0].text, /demo\.search_example/);
const promptsResponse = await handleMcpRequest({ jsonrpc: '2.0', id: 13, method: 'prompts/list' });
assert.ok(promptsResponse.result.prompts.some((prompt) => prompt.name === 'platform_command_build_command'));
const promptResponse = await handleMcpRequest({ jsonrpc: '2.0', id: 14, method: 'prompts/get', params: { name: 'platform_command_execute_safely', arguments: { command: 'demo.search_example' } } });
assert.match(promptResponse.result.messages[0].content.text, /verify/);

const manualLearn = await learnAction({ url: 'https://example.com', platform: 'demo', action: 'manual_test', provider: 'manual' });
assert.equal(manualLearn.status, 'learned_fallback');
assert.equal(manualLearn.provider, 'manual');
assert.equal(manualLearn.report.provider, 'manual');
assert.ok(manualLearn.report.fallbackInstructions.length > 0);
fs.rmSync(manualLearn.runDir, { recursive: true, force: true });

console.log('All tests passed.');
