// @ts-nocheck
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
import { evaluateAcceptance } from '../src/acceptance.js';
import { executeCommand, getExecutionCapability, planCommand } from '../src/execute.js';
import { buildScheduleSpec, installSchedule, listSchedules, getScheduleStatus, removeSchedule, cronToSchtasks } from '../src/schedule.js';
import { requiresBrowser } from '../src/requirements.js';
import { doctorCommand, doctorAll } from '../src/doctor.js';
import { describeCommand } from '../src/describe.js';
import { signBilibiliWbi } from '../commands/bilibili/code/bilibili_wbi.js';

const require = createRequire(import.meta.url);
const pkg = (() => {
  try {
    return require('../package.json');
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    return require('../../package.json');
  }
})();

const commandsDir = path.join(process.cwd(), 'commands');
const CLI_PATH = fs.existsSync(path.join(process.cwd(), 'dist/src/cli.js')) ? 'dist/src/cli.js' : 'src/cli.js';
const MCP_SERVER_PATH = fs.existsSync(path.join(process.cwd(), 'dist/src/mcp_server.js')) ? 'dist/src/mcp_server.js' : 'src/mcp_server.js';


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

const help = execFileSync('node', [CLI_PATH, '--help'], { encoding: 'utf8' });
assert.match(help, /--execute-real --confirm/);

const dry = execFileSync('node', [CLI_PATH, 'execute', '--command', 'demo.search_example', '--dry-run', 'keyword=abc'], { encoding: 'utf8' });
const parsed = JSON.parse(dry);
assert.equal(parsed.status, 'dry_run');
assert.equal(parsed.params.keyword, 'abc');
assert.equal(parsed.params.page, 1);
assert.ok(parsed.runId, 'dry-run execution should record a run id');

const runsJson = JSON.parse(execFileSync('node', [CLI_PATH, 'runs', '--json'], { encoding: 'utf8' }));
assert.equal(typeof runsJson.total, 'number');
assert.ok(Array.isArray(runsJson.runs));
assert.ok(runsJson.runs.some((run) => run.id === parsed.runId), 'runs should include dry-run execution record');

const conflict = spawnSync('node', [CLI_PATH, 'execute', '--command', 'demo.search_example', '--dry-run', '--execute-real', 'keyword=abc'], { encoding: 'utf8' });
assert.notEqual(conflict.status, 0);
assert.match(conflict.stderr, /cannot be used together/);

const realWithoutConfirm = spawnSync('node', [CLI_PATH, 'execute', '--command', 'demo.search_example', '--execute-real', 'keyword=abc'], { encoding: 'utf8' });
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

const listJson = JSON.parse(execFileSync('node', [CLI_PATH, 'list', '--json'], { encoding: 'utf8' }));
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

const githubDefaultDry = JSON.parse(execFileSync('node', [CLI_PATH, 'execute', '--command', 'github.list_issues', '--dry-run', 'owner=2aronS', 'repo=Duel-Agents'], { encoding: 'utf8' }));
assert.equal(githubDefaultDry.params.state, 'all');
assert.equal(githubDefaultDry.params.outputPath, 'runs/github-issues.xlsx');
assert.equal(githubDefaultDry.paramsMeta.sources.state, 'command.defaultConfig.global');
const githubSubjectDry = JSON.parse(execFileSync('node', [CLI_PATH, 'execute', '--command', 'github.list_issues', '--dry-run', 'repo=platform-command'], { encoding: 'utf8' }));
assert.equal(githubSubjectDry.params.owner, 'Michaelxwb');
assert.equal(githubSubjectDry.params.state, 'open');
assert.equal(githubSubjectDry.paramsMeta.sources.owner, 'command.defaultConfig.subjects.platform-command');

const exampleExternalDir = path.join(process.cwd(), 'examples', 'external-commands');
const externalListJson = JSON.parse(execFileSync('node', [CLI_PATH, 'list', '--json', '--commands-dir', exampleExternalDir], { encoding: 'utf8' }));
assert.ok(externalListJson.commands.some((item) => item.name === 'crm.search_customer' && item.source === 'external'));
const externalVerifyJson = JSON.parse(execFileSync('node', [CLI_PATH, 'verify', '--commands-dir', exampleExternalDir, '--command', 'crm.search_customer'], { encoding: 'utf8' }));
assert.equal(externalVerifyJson.ok, true, externalVerifyJson.errors.join('\n'));
const externalDryJson = JSON.parse(execFileSync('node', [CLI_PATH, 'execute', '--commands-dir', exampleExternalDir, '--command', 'order.refund_preview', '--dry-run', 'orderId=ORD-10001', 'reason=customer_request'], { encoding: 'utf8' }));
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

  const recipeDryJson = JSON.parse(execFileSync('node', [CLI_PATH, 'execute', '--commands-dir', recipeCommandsDir, '--command', 'demo.light_recipe', '--dry-run', 'keyword=alpha'], { encoding: 'utf8' }));
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
const mcpRun = spawnSync('node', [MCP_SERVER_PATH], { input: mcpInput, encoding: 'utf8' });
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
const bilibiliExportDry = JSON.parse(execFileSync('node', [CLI_PATH, 'execute', '--command', 'bilibili.export_comments', '--dry-run', 'bvid=BV1rPDkB7ESC', 'limit=50', 'outputPath=runs/comments.xlsx'], { encoding: 'utf8' }));
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
  const autoExportRun = JSON.parse(execFileSync('node', [CLI_PATH, 'execute', '--commands-dir', autoExportDir, '--command', 'demo.auto_export', '--execute-real', '--confirm', `outputPath=${autoExportOutput}`], { encoding: 'utf8' }));
  assert.equal(autoExportRun.status, 'executed');
  assert.equal(autoExportRun.capability, 'export_excel');
  assert.equal(autoExportRun.rows, 1);
  assert.ok(fs.existsSync(autoExportOutput));
} finally {
  fs.rmSync(autoExportDir, { recursive: true, force: true });
  if (fs.existsSync(autoExportOutput)) fs.unlinkSync(autoExportOutput);
}

const workflowDry = execFileSync('node', [CLI_PATH, 'execute', '--command', 'demo.workflow_example', '--dry-run', 'keyword=abc', 'limit=5'], { encoding: 'utf8' });
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


const autoExecutionCommand = {
  name: 'demo.auto_exec',
  platform: 'demo',
  description: 'Auto executable demo command',
  riskLevel: 'low',
  parameters: {},
  execution: { prefer: ['api'] },
  auth: null,
  naturalLanguage: { examples: ['auto exec demo'], match: { any: ['auto'] } },
  dataSource: { type: 'inline', rows: [] },
  output: { capability: 'return_json' }
};
assert.deepEqual(getExecutionCapability(autoExecutionCommand), { executable: true, engine: 'auto_capability', mode: 'auto', reason: 'Command has dataSource plus output.capability and can be executed by the built-in capability engine.' });
const autoDoctorDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-auto-doctor-'));
try {
  fs.writeFileSync(path.join(autoDoctorDir, 'demo.auto_exec.json'), JSON.stringify(autoExecutionCommand, null, 2));
  const autoDoctor = doctorCommand('demo.auto_exec', { commandsDir: autoDoctorDir });
  assert.equal(autoDoctor.ok, true);
  assert.equal(autoDoctor.checks.find((check) => check.name === 'execution.capability')?.ok, true);
} finally {
  fs.rmSync(autoDoctorDir, { recursive: true, force: true });
}
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

const manualCliRun = spawnSync('node', [CLI_PATH, 'learn', '--url', 'https://example.com', '--platform', 'demo', '--action', 'manual_cli', '--provider', 'manual'], { encoding: 'utf8' });
assert.equal(manualCliRun.status, 0, manualCliRun.stderr);
const manualCliPayload = JSON.parse(manualCliRun.stdout);
assert.equal(manualCliPayload.provider, 'manual');
assert.equal(manualCliPayload.status, 'learned_fallback');
fs.rmSync(manualCliPayload.runDir, { recursive: true, force: true });

const badExecuteRun = spawnSync('node', [CLI_PATH, 'execute', '--command', 'demo.workflow_example', '--keyword', 'abc', '--execute-real', '--confirm'], { encoding: 'utf8' });
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

// --- PR e4faba7 回归：describe/doctor 不再因 required 参数崩溃、dryRunPlan 不再恒 null、只读无副作用 ---
{
  // 带 required 参数的 command 不传参 → 不抛，dryRunPlan 给出 unavailable 而非 null/崩溃
  const d = describeCommand('demo.search_example', {});
  assert.equal(d.name, 'demo.search_example');
  assert.ok(d.dryRunPlan, 'dryRunPlan should not be null');
  assert.equal(d.dryRunPlan.status, 'unavailable');
  // 传参 → dryRunPlan 正常构建
  const d2 = describeCommand('demo.search_example', { params: { keyword: 'abc' } });
  assert.equal(d2.dryRunPlan.status, 'dry_run');
  assert.ok(d2.dryRunPlan.plan);
  // doctorAll 遍历全部 command 不崩
  const doc = doctorAll({});
  assert.equal(typeof doc.ok, 'boolean');
  assert.ok(doc.total > 0);
  // planCommand 只读：不写运行记录
  const runDir = path.join(process.cwd(), '.platform-command', 'runs');
  const before = fs.existsSync(runDir) ? fs.readdirSync(runDir).length : 0;
  planCommand('demo.search_example', { keyword: 'abc' });
  const after = fs.existsSync(runDir) ? fs.readdirSync(runDir).length : 0;
  assert.equal(after, before, 'planCommand must not write run records');
}

// --- PR e4faba7 回归：run 记录 status 反映 acceptance；recordRun 返回 file ---
{
  const accDir = path.join(process.cwd(), '.tmp-acc-status');
  fs.rmSync(accDir, { recursive: true, force: true });
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(path.join(accDir, 'demo.accfail.json'), JSON.stringify({
    name: 'demo.accfail', platform: 'demo', description: 'd', riskLevel: 'low', parameters: {},
    dataSource: { type: 'inline', rows: [] },
    output: { capability: 'return_json', title: 't' },
    acceptance: { criteria: [{ id: 'rows', type: 'data_contains', expect: { minCount: 1 } }] }
  }));
  const res = await executeCommand('demo.accfail', {}, { dryRun: false, confirm: true, commandsDir: accDir });
  assert.equal(res.acceptance.status, 'failed');
  assert.ok(res.runFile, 'runFile should be returned');
  const recorded = JSON.parse(fs.readFileSync(res.runFile, 'utf8'));
  assert.equal(recorded.status, 'failed', 'run record status must reflect acceptance failure');
  fs.rmSync(accDir, { recursive: true, force: true });
}

// --- schedule 跨平台：cron→schtasks 子集转换 ---
assert.deepEqual(cronToSchtasks('* * * * *').flags, ['/SC', 'MINUTE', '/MO', '1']);
assert.deepEqual(cronToSchtasks('*/5 * * * *').flags, ['/SC', 'MINUTE', '/MO', '5']);
assert.deepEqual(cronToSchtasks('0 9 * * *').flags, ['/SC', 'DAILY', '/ST', '09:00']);
assert.deepEqual(cronToSchtasks('30 14 * * 1').flags, ['/SC', 'WEEKLY', '/D', 'MON', '/ST', '14:30']);
assert.equal(cronToSchtasks('15 * * * *').flags[1], 'HOURLY');
assert.equal(cronToSchtasks('*/5 9-18 * * 1-5'), null);
assert.equal(cronToSchtasks('bad'), null);
assert.equal(cronToSchtasks('90 99 * * *'), null);
assert.equal(cronToSchtasks('60 * * * *'), null);
assert.equal(cronToSchtasks('0 24 * * *'), null);
assert.equal(cronToSchtasks('0 9 * * 8'), null);
assert.equal(cronToSchtasks('*/0 * * * *'), null);

// --- schedule 跨平台：schtasks backend（注入 runSchtasks，跨平台可测）---
{
  let captured = null;
  const st = installSchedule({ command: 'demo.search_example', cron: '0 9 * * *', backend: 'schtasks', runSchtasks: (a) => { captured = a; return ''; }, confirm: true, operationDryRun: false });
  assert.equal(st.backend, 'schtasks');
  assert.equal(st.installed, true);
  assert.ok(captured.includes('/Create'));
  assert.ok(st.schtasksArgs.join(' ').includes('/SC DAILY /ST 09:00'));
  assert.equal(st.risk.commandExecutionMode, 'real');
  assert.equal(st.risk.schedulerWrite, true);
  // 不可映射的 cron → 不装，降级手动
  const bad = installSchedule({ command: 'demo.search_example', cron: '*/5 9-18 * * 1-5', backend: 'schtasks', runSchtasks: () => '', confirm: true, operationDryRun: false });
  assert.equal(bad.installed, false);
  assert.ok(/cannot be mapped/.test(bad.reason));
  // schtasks list / remove
  const listOut = '"\\platform-command\\demo-x-abc123","9:00:00 AM","Ready"\r\n';
  const sl = listSchedules({ backend: 'schtasks', runSchtasks: () => listOut });
  assert.equal(sl.backend, 'schtasks');
  assert.equal(sl.schedules.length, 1);
  assert.equal(sl.schedules[0].id, 'demo-x-abc123');
  const sr = removeSchedule({ id: 'demo-x-abc123', backend: 'schtasks', confirm: true, runSchtasks: () => '' });
  assert.equal(sr.removed, true);
}

// --- schedule 跨平台：无可用 backend 不崩，降级手动 spec ---
{
  const none = installSchedule({ command: 'demo.search_example', cron: '0 9 * * *', backend: 'none', operationDryRun: true });
  assert.equal(none.backend, 'none');
  assert.equal(none.installed, false);
  assert.ok(none.spec.systemAdapters.windowsTask);
  assert.equal(listSchedules({ backend: 'none' }).schedules.length, 0);
}

// --- schedule 能力分级警告 + requiresBrowser 推断 ---
assert.equal(requiresBrowser({ sessionRef: 'prelogged-atrust', dataSource: { type: 'http_json' } }), true);
assert.equal(requiresBrowser({ steps: [{ id: 'a', type: 'ui' }] }), true);
assert.equal(requiresBrowser({ requires: { ui: true } }), true);
assert.equal(requiresBrowser({ dataSource: { type: 'http_json' }, sessionRef: 'public-api' }), false);
{
  const schedDir = path.join(process.cwd(), '.tmp-sched-cmd');
  fs.rmSync(schedDir, { recursive: true, force: true });
  fs.mkdirSync(schedDir, { recursive: true });
  fs.writeFileSync(path.join(schedDir, 'demo.pub.json'), JSON.stringify({ name: 'demo.pub', platform: 'demo', description: 'd', riskLevel: 'low', parameters: {}, dataSource: { type: 'http_json', steps: [{ id: 's', request: { method: 'GET', url: 'https://x.test' } }] }, output: { capability: 'return_json' } }));
  fs.writeFileSync(path.join(schedDir, 'demo.sess.json'), JSON.stringify({ name: 'demo.sess', platform: 'demo', description: 'd', riskLevel: 'low', sessionRef: 'prelogged-browser', parameters: {}, dataSource: { type: 'http_json', steps: [{ id: 's', request: { method: 'POST', url: 'https://x.test', headers: { 'x-csrf-token': '{{session.csrf}}' } } }] }, output: { capability: 'return_json' } }));
  const cronOpts = { backend: 'crontab', readCrontab: () => '', writeCrontab: () => ({ written: true }), confirm: true, operationDryRun: false, dryRunCommand: false, commandsDir: schedDir };
  const warned = installSchedule({ command: 'demo.sess', cron: '0 9 * * *', ...cronOpts });
  assert.ok(warned.warnings.some((w) => w.code === 'REQUIRES_INTERACTIVE_SESSION'), 'session command real schedule should warn');
  const clean = installSchedule({ command: 'demo.pub', cron: '0 9 * * *', ...cronOpts });
  assert.equal(clean.warnings.length, 0, 'public command should not warn');
  const dryWarn = installSchedule({ command: 'demo.sess', cron: '0 9 * * *', ...cronOpts, dryRunCommand: true });
  assert.equal(dryWarn.warnings.length, 0, 'scheduled dry-run needs no live session');
  fs.rmSync(schedDir, { recursive: true, force: true });
}

console.log('All tests passed.');


// Regression: verify supports positional command names for CLI usability.
const verifyPositional = spawnSync(process.execPath, [CLI_PATH, 'verify', 'github.list_issues'], { cwd: process.cwd(), encoding: 'utf8' });
assert.equal(verifyPositional.status, 0, verifyPositional.stderr || verifyPositional.stdout);
assert.equal(JSON.parse(verifyPositional.stdout).ok, true);

// Regression: data_contains can enforce required mapped columns, not only row count.
const columnAcceptance = evaluateAcceptance({
  acceptance: { criteria: [{ id: 'columns', type: 'data_contains', expect: { minCount: 1, requiredColumns: ['projectName', 'pmName'] } }] }
}, { result: { rows: [{ projectName: '人民日报项目', pmName: '张三' }] } });
assert.equal(columnAcceptance.status, 'passed');
assert.deepEqual(columnAcceptance.criteria.columns.evidence.missingColumns, []);
const missingColumnAcceptance = evaluateAcceptance({
  acceptance: { criteria: [{ id: 'columns', type: 'data_contains', expect: { minCount: 1, requiredColumns: ['projectName', 'pmName'] } }] }
}, { result: { rows: [{ projectName: '人民日报项目' }] } });
assert.equal(missingColumnAcceptance.status, 'failed');
assert.deepEqual(missingColumnAcceptance.criteria.columns.evidence.missingColumns, ['pmName']);

// Regression: Sangfor NL extraction must not treat generic “项目列表” or output clauses as projectName.
const sangforNoKeyword = parseNaturalLanguage('导出深信服 sdsp 项目列表 前15 条，输出 runs/projects.xlsx');
assert.equal(sangforNoKeyword.command, 'sangfor.project_list');
assert.equal(sangforNoKeyword.params.projectName ?? '', '');
assert.equal(sangforNoKeyword.params.limit, 15);
assert.equal(sangforNoKeyword.params.outputPath, 'runs/projects.xlsx');
const sangforKeyword = parseNaturalLanguage('查询 sangfor 项目列表，关键词 攻防演练，输出 runs/projects.xlsx');
assert.equal(sangforKeyword.command, 'sangfor.project_list');
assert.equal(sangforKeyword.params.projectName, '攻防演练');
assert.equal(sangforKeyword.params.outputPath, 'runs/projects.xlsx');


const scheduleJson = JSON.parse(execFileSync('node', [CLI_PATH, 'schedule', '--command', 'demo.search_example', '--cron', '0 9 * * *', '--json', 'keyword=abc'], { encoding: 'utf8' }));
assert.equal(scheduleJson.kind, 'platform_command_schedule');
assert.equal(scheduleJson.command, 'demo.search_example');
assert.equal(scheduleJson.dryRun, true);
assert.ok(scheduleJson.shellCommand.includes('demo.search_example'));
assert.ok(scheduleJson.shellCommand.startsWith('platform-command execute '));
assert.ok(!scheduleJson.shellCommand.includes('src/cli.js'));
assert.ok(scheduleJson.systemAdapters.cron.includes('0 9 * * *'));
assert.ok(scheduleJson.systemAdapters.cron.includes('platform-command execute'));
assert.equal(scheduleJson.systemAdapters.windowsTask.program, 'platform-command');

const schedulePlanJson = JSON.parse(execFileSync('node', [CLI_PATH, 'schedule', 'plan', '--command', 'demo.search_example', '--cron', '0 9 * * *', '--json', 'keyword=plan'], { encoding: 'utf8' }));
assert.equal(schedulePlanJson.kind, 'platform_command_schedule');
assert.equal(schedulePlanJson.dryRun, true);
assert.equal(schedulePlanJson.risk.commandExecutionMode, 'dry-run');
assert.ok(schedulePlanJson.shellCommand.includes('--dry-run'));

const scheduleDryRunCommandInstallJson = JSON.parse(execFileSync('node', [CLI_PATH, 'schedule', 'install', '--command', 'demo.search_example', '--cron', '0 9 * * *', '--dry-run', '--dry-run-command', '--json', 'keyword=hello world'], { encoding: 'utf8' }));
assert.equal(scheduleDryRunCommandInstallJson.spec.dryRun, true);
assert.ok(scheduleDryRunCommandInstallJson.spec.shellCommand.includes('--dry-run'));
assert.equal(scheduleDryRunCommandInstallJson.spec.risk.commandExecutionMode, 'dry-run');
assert.ok(scheduleDryRunCommandInstallJson.spec.systemAdapters.windowsTask.arguments.includes('keyword=hello world'));

const scheduleDryInstallJson = JSON.parse(execFileSync('node', [CLI_PATH, 'schedule', 'install', '--command', 'demo.search_example', '--cron', '0 9 * * *', '--dry-run', '--json', 'keyword=install'], { encoding: 'utf8' }));
assert.equal(scheduleDryInstallJson.action, 'install');
assert.equal(scheduleDryInstallJson.dryRun, true);
assert.ok(scheduleDryInstallJson.nextCrontab.includes('platform-command schedule begin'));
assert.ok(scheduleDryInstallJson.nextCrontab.includes('--execute-real'));
assert.ok(scheduleDryInstallJson.nextCrontab.includes('platform-command execute'));
assert.ok(!scheduleDryInstallJson.nextCrontab.includes('src/cli.js'));

let mockCrontab = '# user cron\n15 1 * * * echo keep\n# unrelated platform-command schedule begin broken\n0 1 * * * echo broken\n';
const mockOptions = {
  readCrontab: () => mockCrontab,
  writeCrontab: (next) => {
    mockCrontab = next;
    return { written: true };
  }
};
const installedSchedule = installSchedule({ command: 'demo.search_example', cron: '0 9 * * *', params: { keyword: 'mock' }, dryRun: false, dryRunCommand: false, confirm: true, ...mockOptions });
assert.equal(installedSchedule.action, 'install');
assert.equal(installedSchedule.dryRun, false);
assert.equal(installedSchedule.written, true);
assert.ok(mockCrontab.includes('echo keep'));
assert.ok(mockCrontab.includes('platform-command schedule begin'));
assert.equal(listSchedules(mockOptions).schedules.length, 1);
assert.equal(getScheduleStatus({ id: installedSchedule.id, ...mockOptions }).found, true);
assert.equal(getScheduleStatus({ id: 'missing', ...mockOptions }).found, false);
const removedSchedule = removeSchedule({ id: installedSchedule.id, dryRun: false, confirm: true, ...mockOptions });
assert.equal(removedSchedule.removed, true);
assert.equal(listSchedules(mockOptions).schedules.length, 0);
assert.ok(mockCrontab.includes('echo keep'));

const docsJson = JSON.parse(execFileSync('node', [CLI_PATH, 'docs', '--json'], { encoding: 'utf8' }));
assert.ok(docsJson.commands > 0);
assert.ok(docsJson.markdown.includes('demo.search_example'));
