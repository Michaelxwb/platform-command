import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { listCommands, loadCommand, mergeParams } from '../src/command_store.js';
import { resolveCommandParams } from '../src/params_resolver.js';
import { buildWorkflowPlan, renderValue } from '../src/workflow.js';
import { verifyCommand } from '../src/verify.js';
import { formatHumanReadable, parseNaturalLanguage } from '../src/nl.js';
import { learnAction, learnResult } from '../src/learn.js';
import { handleMcpRequest } from '../src/mcp_server.js';
import { exportRows } from '../src/exporters.js';
import { readDataSource } from '../src/data_sources.js';
import { executeCommand, getExecutionCapability } from '../src/execute.js';
import { evaluateAcceptance } from '../src/acceptance.js';
import { signBilibiliWbi } from '../commands/bilibili/code/bilibili_wbi.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const commandsDir = path.join(process.cwd(), 'commands');


const afterBoundaryCommand = {
  name: 'demo.after_boundary',
  naturalLanguage: {
    examples: ['发布小红书内容'],
    match: { all: ['发布'], any: ['小红书'], verbs: ['发布'] },
    extract: {
      content: { type: 'after', marker: ['内容'], stop: ['，'], cleanup: 'autoPublishClause' },
      autoPublish: { type: 'booleanKeyword', true: ['自动发布'], false: ['不发布'] }
    }
  }
};
assert.deepEqual(parseNaturalLanguage('发布小红书内容 今天很好，不发布', { commands: [afterBoundaryCommand] }).params, { content: '今天很好', autoPublish: false });
assert.deepEqual(parseNaturalLanguage('发布小红书内容 今天很好，自动发布', { commands: [afterBoundaryCommand] }).params, { content: '今天很好', autoPublish: true });

const typedRenderContext = { params: { limit: 5, enabled: false, nested: { count: 2 } }, steps: {}, warnings: [] };
assert.equal(renderValue('{{limit}}', typedRenderContext), 5);
assert.equal(renderValue('{{enabled}}', typedRenderContext), false);
assert.deepEqual(renderValue({ limit: '{{limit}}', label: 'top {{limit}}', nested: '{{nested}}' }, typedRenderContext), {
  limit: 5,
  label: 'top 5',
  nested: { count: 2 }
});

const nlIssues = parseNaturalLanguage('在 GitHub 上，查看 zhaoxuya520/reverse-skill 的 issues，状态 all');
assert.equal(nlIssues.command, 'github.list_issues');
assert.deepEqual(nlIssues.params, { owner: 'zhaoxuya520', repo: 'reverse-skill', state: 'all' });
assert.ok(nlIssues.confidence >= 0.95);

const nlFixtureCommandsDir = path.join(process.cwd(), '.tmp-nl-commands');
fs.rmSync(nlFixtureCommandsDir, { recursive: true, force: true });
fs.mkdirSync(nlFixtureCommandsDir, { recursive: true });
fs.writeFileSync(path.join(nlFixtureCommandsDir, 'demo.after_marker.json'), JSON.stringify({
  name: 'demo.after_marker',
  description: 'Demo after marker extraction',
  riskLevel: 'low',
  parameters: { content: { type: 'string' } },
  naturalLanguage: {
    match: { any: ['发布'], verbs: ['发布'] },
    extract: { content: { type: 'after', marker: '内容是', stop: ['，状态'] } }
  },
  recipe: { kind: 'workflow', steps: [] }
}, null, 2));
assert.deepEqual(parseNaturalLanguage('发布动态，内容是今天完成修复，状态公开', { commandsDir: nlFixtureCommandsDir }).params, { content: '今天完成修复' });
fs.rmSync(nlFixtureCommandsDir, { recursive: true, force: true });

const nlCommits = parseNaturalLanguage('列出 GitHub 仓库 Michaelxwb/platform-command 的 commits，分支 master');
assert.equal(nlCommits.command, 'github.list_commits');
assert.deepEqual(nlCommits.params, { owner: 'Michaelxwb', repo: 'platform-command', branch: 'master' });

const nlSearch = parseNaturalLanguage('在 GitHub 搜索仓库 platform-command user:Michaelxwb，最多 3');
assert.equal(nlSearch.command, 'github.search_repositories');
assert.equal(nlSearch.params.query, 'platform-command user:Michaelxwb');
assert.equal(nlSearch.params.limit, 3);

const nlInspect = parseNaturalLanguage('巡检 GitHub 仓库 Michaelxwb/platform-command');
assert.equal(nlInspect.command, 'github.inspect_repository');
assert.deepEqual(nlInspect.params, { owner: 'Michaelxwb', repo: 'platform-command' });

const nlBilibili = parseNaturalLanguage('给 bilibili 视频 https://www.bilibili.com/video/BV1YNGn6CEcH 评论：测试评论，并自动发布');
assert.equal(nlBilibili.command, 'bilibili.post_comment');
assert.deepEqual(nlBilibili.params, { videoUrl: 'https://www.bilibili.com/video/BV1YNGn6CEcH', commentText: '测试评论', autoPublish: true });

const nlBilibiliExport = parseNaturalLanguage('获取 bilibili 视频 https://www.bilibili.com/video/BV1rPDkB7ESC/ 前50评论数据，输出到 runs/comments.xlsx');
assert.equal(nlBilibiliExport.command, 'bilibili.export_comments');
assert.deepEqual(nlBilibiliExport.params, { bvid: 'BV1rPDkB7ESC', limit: 50, outputPath: 'runs/comments.xlsx' });

const nlBilibiliExportAmbiguous = parseNaturalLanguage('帮我获取 bilibili 视频 BV1rPDkB7ESC 的评论数据');
assert.equal(nlBilibiliExportAmbiguous.command, 'bilibili.export_comments');

const nlBilibiliPostAmbiguous = parseNaturalLanguage('给 bilibili 视频 https://www.bilibili.com/video/BV1YNGn6CEcH 发布评论：测试评论');
assert.equal(nlBilibiliPostAmbiguous.command, 'bilibili.post_comment');

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
const listedBilibiliExport = listJson.commands.find((item) => item.name === 'bilibili.export_comments');
assert.ok(listedBilibiliExport);
assert.match(listedBilibiliExport.file, /commands\/bilibili\/cmd\/export_comments\.json$/);
const listedBilibiliPost = listJson.commands.find((item) => item.name === 'bilibili.post_comment');
assert.ok(listedBilibiliPost);
assert.match(listedBilibiliPost.file, /commands\/bilibili\/cmd\/post_comment\.json$/);
const listedGithubIssues = listJson.commands.find((item) => item.name === 'github.list_issues');
assert.ok(listedGithubIssues);
assert.match(listedGithubIssues.file, /commands\/github\/cmd\/list_issues\.json$/);

const githubIssuesCommandFile = path.join(process.cwd(), 'commands', 'github', 'cmd', 'list_issues.json');
const githubIssuesRawCommand = JSON.parse(fs.readFileSync(githubIssuesCommandFile, 'utf8'));
assert.equal(githubIssuesRawCommand.defaultConfig, undefined);
const githubIssuesCommand = loadCommand('github.list_issues').command;
assert.equal(githubIssuesCommand.defaultConfig?.subjectParam, 'repo');
assert.equal(githubIssuesCommand.defaultConfig?.subjects?.['platform-command']?.owner, 'Michaelxwb');
const defaultResolved = resolveCommandParams(githubIssuesCommand, { owner: '2aronS', repo: 'Duel-Agents' });
assert.equal(defaultResolved.params.state, 'all');
assert.equal(defaultResolved.params.outputPath, 'runs/github-issues.xlsx');
assert.deepEqual(defaultResolved.meta.layers, ['command.defaultConfig.global', 'provided']);
assert.equal(defaultResolved.meta.sources.state, 'command.defaultConfig.global');
assert.equal(defaultResolved.meta.sources.owner, 'provided');
const subjectResolved = resolveCommandParams(githubIssuesCommand, { repo: 'platform-command' });
assert.equal(subjectResolved.params.owner, 'Michaelxwb');
assert.equal(subjectResolved.params.state, 'open');
assert.equal(subjectResolved.params.outputPath, 'runs/platform-command-issues.xlsx');
assert.deepEqual(subjectResolved.meta.layers, ['command.defaultConfig.global', 'command.defaultConfig.subjects.platform-command', 'provided']);
const subjectOverrideResolved = resolveCommandParams(githubIssuesCommand, { repo: 'platform-command', state: 'closed' });
assert.equal(subjectOverrideResolved.params.state, 'closed');
assert.equal(subjectOverrideResolved.meta.sources.state, 'provided');

const nlDefaultIssues = parseNaturalLanguage('列出 GitHub 仓库 Michaelxwb/platform-command 的 issues');
assert.equal(nlDefaultIssues.command, 'github.list_issues');
assert.deepEqual(nlDefaultIssues.params, { owner: 'Michaelxwb', repo: 'platform-command' });

const githubDefaultDry = JSON.parse(execFileSync('node', ['src/cli.js', 'execute', '--command', 'github.list_issues', '--dry-run', 'owner=2aronS', 'repo=Duel-Agents'], { encoding: 'utf8' }));
assert.equal(githubDefaultDry.params.state, 'all');
assert.equal(githubDefaultDry.params.outputPath, 'runs/github-issues.xlsx');
assert.equal(githubDefaultDry.paramsMeta.sources.state, 'command.defaultConfig.global');
const githubSubjectDry = JSON.parse(execFileSync('node', ['src/cli.js', 'execute', '--command', 'github.list_issues', '--dry-run', 'repo=platform-command'], { encoding: 'utf8' }));
assert.equal(githubSubjectDry.params.owner, 'Michaelxwb');
assert.equal(githubSubjectDry.params.state, 'open');
assert.equal(githubSubjectDry.paramsMeta.sources.owner, 'command.defaultConfig.subjects.platform-command');

const exampleExternalDir = path.join(process.cwd(), 'examples', 'external-commands');
const externalListJson = JSON.parse(execFileSync('node', ['src/cli.js', 'list', '--json', '--commands-dir', exampleExternalDir], { encoding: 'utf8' }));
assert.ok(externalListJson.commands.some((item) => item.name === 'crm.search_customer' && item.source === 'external'));
const externalVerifyJson = JSON.parse(execFileSync('node', ['src/cli.js', 'verify', '--commands-dir', exampleExternalDir, '--command', 'crm.search_customer'], { encoding: 'utf8' }));
assert.equal(externalVerifyJson.ok, true, externalVerifyJson.errors.join('\n'));
const externalDryJson = JSON.parse(execFileSync('node', ['src/cli.js', 'execute', '--commands-dir', exampleExternalDir, '--command', 'order.refund_preview', '--dry-run', 'orderId=ORD-10001', 'reason=customer_request'], { encoding: 'utf8' }));
assert.equal(externalDryJson.status, 'dry_run');
assert.equal(externalDryJson.command, 'order.refund_preview');
assert.equal(externalDryJson.plan.kind, 'workflow');

const recipeCommandsDir = path.join(process.cwd(), '.tmp-recipe-commands');
const recipeFile = path.join(recipeCommandsDir, 'demo.light_recipe.json');
try {
  fs.rmSync(recipeCommandsDir, { recursive: true, force: true });
  fs.mkdirSync(recipeCommandsDir, { recursive: true });
  const recipeCommand = {
    name: 'demo.light_recipe',
    platform: 'demo',
    description: 'Lightweight recipe command without execution.workflow.',
    riskLevel: 'low',
    parameters: {
      keyword: { type: 'string', required: true }
    },
    steps: [
      {
        id: 'search',
        type: 'api',
        description: 'Search {{params.keyword}}',
        request: { method: 'GET', url: 'https://example.test/search?q={{params.keyword}}' },
        extract: { firstId: { example: 'item-001' } }
      },
      {
        id: 'open',
        type: 'ui',
        dependsOn: ['search'],
        ui: { actions: [{ action: 'goto', target: 'https://example.test/items/{{steps.search.firstId}}' }] }
      }
    ],
    checks: ['Search request is prepared.', 'Detail page can be opened.']
  };
  fs.writeFileSync(recipeFile, JSON.stringify(recipeCommand, null, 2));
  const recipeVerify = verifyCommand('demo.light_recipe', { commandsDir: recipeCommandsDir });
  assert.equal(recipeVerify.ok, true, recipeVerify.errors.join('\n'));
  const recipePlan = buildWorkflowPlan(recipeVerify.command, { keyword: 'alpha' });
  assert.equal(recipePlan.kind, 'recipe');
  assert.deepEqual(recipePlan.checks, recipeCommand.checks);
  assert.equal(recipePlan.steps[0].request.url, 'https://example.test/search?q=alpha');
  assert.equal(recipePlan.steps[1].ui.actions[0].target, 'https://example.test/items/item-001');

  const recipeDryJson = JSON.parse(execFileSync('node', ['src/cli.js', 'execute', '--commands-dir', recipeCommandsDir, '--command', 'demo.light_recipe', '--dry-run', 'keyword=alpha'], { encoding: 'utf8' }));
  assert.equal(recipeDryJson.plan.kind, 'recipe');
  assert.equal(recipeDryJson.plan.checks[0], 'Search request is prepared.');
} finally {
  fs.rmSync(recipeCommandsDir, { recursive: true, force: true });
}

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

const bilibiliExportVerify = verifyCommand('bilibili.export_comments');
assert.equal(bilibiliExportVerify.ok, true, bilibiliExportVerify.errors.join('\n'));
const bilibiliExportDry = JSON.parse(execFileSync('node', ['src/cli.js', 'execute', '--command', 'bilibili.export_comments', '--dry-run', 'bvid=BV1rPDkB7ESC', 'limit=50', 'outputPath=runs/comments.xlsx'], { encoding: 'utf8' }));
assert.equal(bilibiliExportDry.status, 'dry_run');
assert.equal(bilibiliExportDry.plan.steps.at(-1).id, 'export_file');
assert.equal(bilibiliExportDry.plan.output.capability, 'export_excel');
assert.deepEqual(bilibiliExportDry.plan.output.columns.map((column) => column.title), ['评论人', '评论时间', '评论内容', '点赞数量']);
assert.equal(bilibiliExportDry.plan.steps[1].request.url, 'https://api.bilibili.com/x/web-interface/view?bvid=BV1rPDkB7ESC');
assert.equal(bilibiliExportDry.plan.steps[2].request.url, 'https://api.bilibili.com/x/v2/reply/wbi/main?type=1&oid=116366820508713&mode=3&ps=20&next=0');
assert.equal(bilibiliExportDry.plan.dataSource.type, 'http_json');
assert.equal(bilibiliExportDry.plan.acceptance.criteria.length, 3);
assert.equal(bilibiliExportDry.plan.acceptance.criteria[0].type, 'manual_check');
assert.equal(bilibiliExportDry.plan.acceptanceEvidence.status, 'pending');
assert.equal(bilibiliExportDry.plan.acceptanceEvidence.criteria.criterion_1.type, 'manual_check');
assert.equal(bilibiliExportDry.plan.acceptanceEvidence.criteria.criterion_1.description, bilibiliExportDry.plan.acceptance.criteria[0].description);
assert.equal(bilibiliExportDry.plan.dataSource.steps[1].request.signer.module, './code/bilibili_wbi.js');
assert.equal(bilibiliExportDry.plan.dataSource.steps[1].collect.map[0].key, 'commenter');

const signedWbi = signBilibiliWbi({ oid: 123, type: 1, ps: 20 }, {
  imgKey: 'abcdefghijklmnopqrstuvwxyzabcdef',
  subKey: '0123456789abcdef0123456789abcdef'
}, 1780166795);
assert.equal(signedWbi.wts, 1780166795);
assert.match(signedWbi.w_rid, /^[0-9a-f]{32}$/);
const tmpXlsx = path.join(process.cwd(), '.tmp-comments.xlsx');
const tmpDocx = path.join(process.cwd(), '.tmp-comments.docx');
const tmpPptx = path.join(process.cwd(), '.tmp-comments.pptx');
try {
  const exportRowsInput = {
    columns: [
      { key: 'commenter', title: '评论人' },
      { key: 'commentTime', title: '评论时间' },
      { key: 'content', title: '评论内容' },
      { key: 'likes', title: '点赞数量' }
    ],
    rows: [{ commenter: 'alice', commentTime: '2026-05-31 02:46:35', content: 'hello', likes: 7 }],
    title: 'comments'
  };
  exportRows({ ...exportRowsInput, capability: 'export_excel', outputPath: tmpXlsx });
  exportRows({ ...exportRowsInput, capability: 'export_word', outputPath: tmpDocx });
  exportRows({ ...exportRowsInput, capability: 'export_ppt', outputPath: tmpPptx });
  const xlsx = fs.readFileSync(tmpXlsx);
  const docx = fs.readFileSync(tmpDocx);
  const pptx = fs.readFileSync(tmpPptx);
  assert.equal(xlsx.slice(0, 4).toString('hex'), '504b0304');
  assert.equal(docx.slice(0, 4).toString('hex'), '504b0304');
  assert.equal(pptx.slice(0, 4).toString('hex'), '504b0304');
  assert.ok(xlsx.includes(Buffer.from('xl/worksheets/sheet1.xml')));
  assert.ok(docx.includes(Buffer.from('word/document.xml')));
  assert.ok(pptx.includes(Buffer.from('ppt/slides/slide1.xml')));
} finally {
  if (fs.existsSync(tmpXlsx)) fs.unlinkSync(tmpXlsx);
  if (fs.existsSync(tmpDocx)) fs.unlinkSync(tmpDocx);
  if (fs.existsSync(tmpPptx)) fs.unlinkSync(tmpPptx);
}

const autoExportDir = path.join(process.cwd(), '.tmp-auto-export-commands');
const autoExportFile = path.join(autoExportDir, 'demo.auto_export.json');
const autoExportOutput = path.join(process.cwd(), '.tmp-auto-export.xlsx');
try {
  fs.rmSync(autoExportDir, { recursive: true, force: true });
  fs.mkdirSync(autoExportDir, { recursive: true });
  fs.writeFileSync(autoExportFile, JSON.stringify({
    name: 'demo.auto_export',
    platform: 'demo',
    description: 'Auto export command with a generic output capability.',
    riskLevel: 'low',
    parameters: {
      outputPath: { type: 'string', required: true }
    },
    dataSource: {
      type: 'inline',
      rows: [{ name: 'alice', count: 2 }]
    },
    output: {
      capability: 'export_excel',
      path: '{{params.outputPath}}',
      columns: [
        { key: 'name', title: 'Name' },
        { key: 'count', title: 'Count' }
      ]
    },
    steps: [
      { id: 'export_file', type: 'manual', manual: 'Auto-dispatch output.capability.' }
    ]
  }, null, 2));
  const autoExportVerify = verifyCommand('demo.auto_export', { commandsDir: autoExportDir });
  assert.equal(autoExportVerify.ok, true, autoExportVerify.errors.join('\n'));
  const autoExportRun = JSON.parse(execFileSync('node', ['src/cli.js', 'execute', '--commands-dir', autoExportDir, '--command', 'demo.auto_export', '--execute-real', '--confirm', `outputPath=${autoExportOutput}`], { encoding: 'utf8' }));
  assert.equal(autoExportRun.status, 'executed');
  assert.equal(autoExportRun.capability, 'export_excel');
  assert.equal(autoExportRun.rows, 1);
  assert.ok(fs.existsSync(autoExportOutput));
} finally {
  fs.rmSync(autoExportDir, { recursive: true, force: true });
  if (fs.existsSync(autoExportOutput)) fs.unlinkSync(autoExportOutput);
}

const workflowDry = execFileSync('node', ['src/cli.js', 'execute', '--command', 'demo.workflow_example', '--dry-run', 'keyword=abc', 'limit=5'], { encoding: 'utf8' });
const workflowParsed = JSON.parse(workflowDry);
assert.equal(workflowParsed.status, 'dry_run');
assert.equal(workflowParsed.plan.kind, 'workflow');
assert.equal(workflowParsed.plan.steps.length, 4);
assert.equal(workflowParsed.plan.steps[0].request.query.q, 'abc');
assert.equal(workflowParsed.plan.steps[0].request.query.limit, 5);
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


const autoExecutionCommand = { name: 'demo.auto_exec', dataSource: { type: 'inline', rows: [] }, output: { capability: 'return_json' } };
assert.deepEqual(getExecutionCapability(autoExecutionCommand), { executable: true, engine: 'auto_capability', mode: 'auto', reason: 'Command has dataSource plus output.capability and can be executed by the built-in capability engine.' });
const apiWorkflowCommand = { name: 'demo.api_workflow', execution: { workflow: { steps: [{ type: 'api', request: { url: 'https://example.test' } }] } } };
assert.deepEqual(getExecutionCapability(apiWorkflowCommand), { executable: false, engine: 'workflow', mode: 'api_plan', reason: 'Workflow contains API steps but no real workflow execution engine is available yet; dry-run planning is supported.' });
const uiWorkflowCommand = { name: 'demo.ui_workflow', execution: { workflow: { steps: [{ type: 'ui', action: 'click', selector: '#go' }] } } };
assert.deepEqual(getExecutionCapability(uiWorkflowCommand), { executable: false, engine: 'workflow', mode: 'ui_plan', reason: 'Workflow contains UI steps but no real workflow execution engine is available yet; dry-run planning is supported.' });
const blockedExecutionCommand = { name: 'demo.workflow_only', execution: { workflow: { steps: [{ type: 'manual', manual: 'Inspect manually' }] } } };
assert.deepEqual(getExecutionCapability(blockedExecutionCommand), { executable: false, engine: null, mode: 'none', reason: 'No real execution engine is available for this command shape; use dry-run workflow plans or add dataSource plus output.capability.' });
const blockedPlanDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-blocked-plan-'));
try {
  fs.writeFileSync(path.join(blockedPlanDir, 'demo.workflow_only.json'), JSON.stringify(blockedExecutionCommand, null, 2));
  const blockedPlanResult = await executeCommand('demo.workflow_only', {}, { commandsDir: blockedPlanDir, dryRun: true });
  assert.deepEqual(blockedPlanResult.plan.execution, getExecutionCapability(blockedExecutionCommand));
} finally {
  fs.rmSync(blockedPlanDir, { recursive: true, force: true });
}

const initResponse = await handleMcpRequest({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} });
assert.deepEqual(initResponse.result.capabilities, { tools: {}, resources: {}, prompts: {} });
assert.equal(initResponse.result.serverInfo.version, pkg.version);
const describeResponse = await handleMcpRequest({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'platform_command_describe', arguments: { command: 'demo.search_example' } } });
const describedCommand = JSON.parse(describeResponse.result.content[0].text);
assert.equal(describedCommand.execution.executable, false);
assert.equal(describedCommand.execution.engine, null);
assert.equal(describedCommand.execution.mode, 'none');

const resourcesResponse = await handleMcpRequest({ jsonrpc: '2.0', id: 11, method: 'resources/list' });
assert.ok(resourcesResponse.result.resources.some((resource) => resource.uri === 'platform-command://commands'));
const commandsResource = await handleMcpRequest({ jsonrpc: '2.0', id: 12, method: 'resources/read', params: { uri: 'platform-command://commands' } });
assert.match(commandsResource.result.contents[0].text, /demo\.search_example/);
const promptsResponse = await handleMcpRequest({ jsonrpc: '2.0', id: 13, method: 'prompts/list' });
assert.ok(promptsResponse.result.prompts.some((prompt) => prompt.name === 'platform_command_build_command'));
const promptResponse = await handleMcpRequest({ jsonrpc: '2.0', id: 14, method: 'prompts/get', params: { name: 'platform_command_execute_safely', arguments: { command: 'demo.search_example' } } });
assert.match(promptResponse.result.messages[0].content.text, /verify/);

const toolsResponse = await handleMcpRequest({ jsonrpc: '2.0', id: 16, method: 'tools/list' });
assert.ok(toolsResponse.result.tools.some((tool) => tool.name === 'platform_command_learn'));
const mcpLearnResponse = await handleMcpRequest({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'platform_command_learn', arguments: { url: 'https://example.com', platform: 'demo', action: 'mcp_manual', provider: 'manual' } } });
const mcpLearnPayload = JSON.parse(mcpLearnResponse.result.content[0].text);
assert.equal(mcpLearnPayload.status, 'learned_fallback');
assert.equal(mcpLearnPayload.provider, 'manual');
fs.rmSync(mcpLearnPayload.runDir, { recursive: true, force: true });

const manualLearn = await learnAction({ url: 'https://example.com', platform: 'demo', action: 'manual_test', provider: 'manual' });
assert.equal(manualLearn.status, 'learned_fallback');
assert.equal(manualLearn.provider, 'manual');
assert.equal(manualLearn.report.provider, 'manual');
assert.ok(manualLearn.report.fallbackInstructions.length > 0);
assert.ok(manualLearn.artifacts.reportPath.endsWith('learn_report.json'));
assert.equal(manualLearn.summary.requestCount, 0);

const playwrightContract = learnResult({
  status: 'learned',
  provider: 'playwright',
  runDir: '/tmp/platform-command-playwright-contract',
  reportPath: '/tmp/platform-command-playwright-contract/learn_report.json',
  report: {
    domSummary: { title: 'Playwright page' },
    network: { requests: [{ url: 'https://example.com' }], responses: [{ status: 200 }] },
    candidateParameters: [{ name: 'keyword' }]
  }
});
assert.equal(playwrightContract.status, 'learned');
assert.equal(playwrightContract.provider, 'playwright');
assert.equal(playwrightContract.artifacts.reportPath, '/tmp/platform-command-playwright-contract/learn_report.json');
assert.deepEqual(playwrightContract.summary, { title: 'Playwright page', requestCount: 1, responseCount: 1, candidateParameterCount: 1 });
fs.rmSync(manualLearn.runDir, { recursive: true, force: true });

const manualCliRun = spawnSync('node', ['src/cli.js', 'learn', '--url', 'https://example.com', '--platform', 'demo', '--action', 'manual_cli', '--provider', 'manual'], { encoding: 'utf8' });
assert.equal(manualCliRun.status, 0, manualCliRun.stderr);
const manualCliPayload = JSON.parse(manualCliRun.stdout);
assert.equal(manualCliPayload.provider, 'manual');
assert.equal(manualCliPayload.status, 'learned_fallback');
fs.rmSync(manualCliPayload.runDir, { recursive: true, force: true });

const badExecuteRun = spawnSync('node', ['src/cli.js', 'execute', '--command', 'demo.workflow_example', '--keyword', 'abc', '--execute-real', '--confirm'], { encoding: 'utf8' });
assert.notEqual(badExecuteRun.status, 0);
assert.match(badExecuteRun.stderr, /Not executable/);


const http = await import('node:http');
let capturedPostBody = null;
const postBodyServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    capturedPostBody = Buffer.concat(chunks).toString('utf8');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, echoed: capturedPostBody }));
  });
});
await new Promise((resolve) => postBodyServer.listen(0, '127.0.0.1', resolve));
try {
  const { port } = postBodyServer.address();
  const postData = await readDataSource({
    type: 'http_json',
    steps: [{
      id: 'submit',
      request: {
        method: 'POST',
        url: `http://127.0.0.1:${port}/submit`,
        headers: { 'content-type': 'application/json' },
        body: { limit: '{{limit}}', keyword: '{{keyword}}' }
      },
      extract: { echoed: 'echoed' }
    }]
  }, { limit: 7, keyword: 'abc' });
  assert.equal(capturedPostBody, JSON.stringify({ limit: 7, keyword: 'abc' }));
  assert.equal(postData.meta.echoed, capturedPostBody);
} finally {
  await new Promise((resolve) => postBodyServer.close(resolve));
}

// --- acceptance enforcement (S-2): machine-checkable auto-verify + agent evidence ---
{
  const accCmd = {
    acceptance: { criteria: [
      { id: 'file', type: 'file_exists', description: 'exported file' },
      { id: 'rows', type: 'data_contains', description: 'has rows', expect: { minCount: 2 } },
      { id: 'manual', type: 'manual_check', description: 'agent verifies' }
    ] }
  };
  const accFile = path.join(process.cwd(), '.tmp-acceptance.txt');
  fs.writeFileSync(accFile, 'x');
  // file ok + rows ok + manual not filled => incomplete (不静默成功)
  let rep = evaluateAcceptance(accCmd, { result: { outputPath: accFile, rows: 3 } });
  assert.equal(rep.criteria.file.status, 'passed');
  assert.equal(rep.criteria.rows.status, 'passed');
  assert.equal(rep.criteria.manual.status, 'pending');
  assert.equal(rep.status, 'incomplete');
  // agent fills manual evidence => passed
  rep = evaluateAcceptance(accCmd, { result: { outputPath: accFile, rows: 3 }, evidence: { manual: { note: 'verified' } } });
  assert.equal(rep.criteria.manual.status, 'passed');
  assert.equal(rep.status, 'passed');
  // not enough rows => failed
  rep = evaluateAcceptance(accCmd, { result: { outputPath: accFile, rows: 1 }, evidence: { manual: { note: 'v' } } });
  assert.equal(rep.criteria.rows.status, 'failed');
  assert.equal(rep.status, 'failed');
  // missing file => failed
  fs.rmSync(accFile);
  rep = evaluateAcceptance(accCmd, { result: { outputPath: accFile, rows: 3 }, evidence: { manual: { note: 'v' } } });
  assert.equal(rep.criteria.file.status, 'failed');
  assert.equal(rep.status, 'failed');
  // no criteria => not_required
  assert.equal(evaluateAcceptance({}, { result: {} }).status, 'not_required');
  // optional criterion does not block a passing required one
  const optRep = evaluateAcceptance({ acceptance: { criteria: [
    { id: 'req', type: 'data_contains', expect: { minCount: 1 } },
    { id: 'opt', type: 'manual_check', description: 'o', optional: true }
  ] } }, { result: { rows: 2 } });
  assert.equal(optRep.criteria.opt.status, 'optional');
  assert.equal(optRep.criteria.req.status, 'passed');
  assert.equal(optRep.status, 'passed');
}

// --- acceptance integration through executeCommand (real run attaches report) ---
{
  const accDir = path.join(process.cwd(), '.tmp-acc-cmd');
  fs.rmSync(accDir, { recursive: true, force: true });
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(path.join(accDir, 'demo.acc.json'), JSON.stringify({
    name: 'demo.acc', platform: 'demo', description: 'acc demo', riskLevel: 'low', parameters: {},
    dataSource: { type: 'inline', rows: [{ a: 1 }, { a: 2 }] },
    output: { capability: 'return_json', title: 't' },
    acceptance: { criteria: [{ id: 'rows', type: 'data_contains', description: 'has rows', expect: { minCount: 1 } }] }
  }));
  const res = await executeCommand('demo.acc', {}, { dryRun: false, confirm: true, commandsDir: accDir });
  assert.equal(res.status, 'executed');
  assert.equal(res.acceptance.status, 'passed');
  assert.equal(res.acceptance.criteria.rows.status, 'passed');
  fs.rmSync(accDir, { recursive: true, force: true });
}

console.log('All tests passed.');
