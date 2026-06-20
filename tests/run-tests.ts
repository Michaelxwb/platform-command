// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { listCommands, loadCommand, mergeParams } from '../src/model/command_store.js';
import { resolveCommandParams } from '../src/model/params_resolver.js';
import { buildWorkflowPlan, renderValue } from '../src/engine/workflow.js';
import { verifyCommand } from '../src/model/verify.js';
import { formatHumanReadable, parseNaturalLanguage } from '../src/nl/nl.js';
import { learnAction, learnResult } from '../src/nl/learn.js';
import { handleMcpRequest } from '../src/entry/mcp_server.js';
import { exportRows } from '../src/io/exporters.js';
import { readDataSource } from '../src/engine/data_sources.js';
import { evaluateAcceptance } from '../src/model/acceptance.js';
import { executeCommand, getExecutionCapability, planCommand } from '../src/engine/execute.js';
import { buildScheduleSpec, installSchedule, listSchedules, getScheduleStatus, removeSchedule, cronToSchtasks } from '../src/schedule/schedule.js';
import { requiresBrowser } from '../src/model/requirements.js';
import { doctorCommand, doctorAll } from '../src/model/doctor.js';
import { describeCommand } from '../src/model/describe.js';
import { readStore, writeStore, replaceStore, listStore, deleteStore } from '../src/io/store.js';
import { calcDateRange } from '../commands/mss/code/date_range.js';
import { applyResponseRewrite, pollUntilReady, executeInterceptFlow, setPath } from '../src/engine/intercept_executor.js';
import { resolveSiteOrigin, applySiteOrigin } from '../src/engine/site.js';
import { iterTriggerTimes, computeMissedJobs, runWithConcurrency, readHeartbeat, writeHeartbeat, loadScheduleEntries, selectDueJobs, stopSignalsForPlatform } from '../src/schedule/daemon.js';
import { buildBody as buildSendEmailBody } from '../commands/mss/code/send_email_body.js';
import { derive as deriveConfigFlags } from '../commands/mss/code/config_flags.js';
import { buildBody as buildSyncPortalBody } from '../commands/mss/code/sync_portal_body.js';
import { importCookieState, sessionStatus } from '../src/adapter/session_import.js';
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
const CLI_PATH = fs.existsSync(path.join(process.cwd(), 'dist/src/entry/cli.js')) ? 'dist/src/entry/cli.js' : 'src/entry/cli.js';
const MCP_SERVER_PATH = fs.existsSync(path.join(process.cwd(), 'dist/src/entry/mcp_server.js')) ? 'dist/src/entry/mcp_server.js' : 'src/entry/mcp_server.js';


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

// runtime.* 是延迟命名空间：plan 阶段保留占位、不报 UNRESOLVED，failOnUnresolvedTemplates 不应因它抛错
{
  const runtimeWarnings = [];
  const rt = renderValue('视频 aid={{runtime.open_video.aid}}', { params: {}, steps: {}, warnings: runtimeWarnings });
  assert.equal(rt, '视频 aid={{runtime.open_video.aid}}', 'runtime.* 占位符应保留');
  assert.equal(runtimeWarnings.length, 0, 'runtime.* 不应产生 UNRESOLVED_TEMPLATE 警告');
  // 已提供 runtime 上下文时正常解析
  assert.equal(renderValue('{{runtime.open_video.aid}}', { params: {}, steps: {}, runtime: { open_video: { aid: 123 } } }), 123);
}

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
assert.deepEqual(getExecutionCapability(uiWorkflowCommand), { executable: false, engine: 'workflow', mode: 'ui_plan', reason: 'UI command requires a server-mode storageState session (PLATFORM_COMMAND_STORAGE_STATE); dry-run planning is supported.' });
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
// initialize.instructions：引导 agent 优先用 platform-command，并列出覆盖平台 + 执行约定。
const mcpInstructions = initResponse.result.instructions;
assert.ok(typeof mcpInstructions === 'string' && mcpInstructions.length > 0, 'initialize 必须返回 instructions');
assert.match(mcpInstructions, /platform_command_execute/, 'instructions 应指明用 execute 工具');
assert.match(mcpInstructions, /dryRun:false|confirm:true/, 'instructions 应说明真实执行约定');
assert.match(mcpInstructions, /demo/, 'instructions 应动态列出已装平台（至少含 demo）');
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

// ============ 服务器模式（多用户部署）：env 矩阵 / 适配器选择 / 沙箱 / 会话健康 / 本地兼容 ============
const { resolveServerMode, resolveOutputPath, serverModeMeta } = await import('../src/entry/server_mode.js');
const { markSessionInvalid, clearSessionInvalid, getSessionState } = await import('../src/adapter/session_state.js');
const playwrightAdapter = await import('../src/adapter/playwright_adapter.js');
const { recordRun } = await import('../src/io/runs.js');
const os = await import('node:os');

const SERVER_ENV_KEYS = ['PLATFORM_COMMAND_USER_ID', 'PLATFORM_COMMAND_STORAGE_STATE', 'PLATFORM_COMMAND_OUTPUT_DIR', 'PLATFORM_COMMAND_DATA_DIR'];
const savedServerEnv = {};
for (const key of SERVER_ENV_KEYS) { savedServerEnv[key] = process.env[key]; delete process.env[key]; }
const clearServerEnv = () => { for (const key of SERVER_ENV_KEYS) delete process.env[key]; };
let sandboxRoot = null;
let outsideDir = null;
let sessStateFile = null;
let sessCmdDir = null;

try {
  // --- TASK-001：本地模式（零 env）零行为变化 (S-06 基线) ---
  assert.equal(resolveServerMode().enabled, false);
  assert.deepEqual(serverModeMeta(), {});
  assert.equal(resolveOutputPath('runs/x.xlsx'), path.resolve('runs/x.xlsx'));

  // --- TASK-001：完整/部分/非法配置矩阵 (B-03) ---
  process.env.PLATFORM_COMMAND_USER_ID = 'alice';
  assert.equal(resolveServerMode().enabled, true);
  assert.equal(resolveServerMode().userId, 'alice');
  assert.deepEqual(serverModeMeta(), { userId: 'alice' });
  clearServerEnv();
  process.env.PLATFORM_COMMAND_STORAGE_STATE = '/tmp/state.json';
  assert.throws(() => resolveServerMode(), /服务器模式配置不完整/);
  assert.deepEqual(serverModeMeta(), {});
  clearServerEnv();
  process.env.PLATFORM_COMMAND_OUTPUT_DIR = '/tmp/out';
  assert.throws(() => resolveServerMode(), /服务器模式配置不完整/);
  clearServerEnv();
  process.env.PLATFORM_COMMAND_USER_ID = 'bad user!';
  assert.throws(() => resolveServerMode(), /格式无效/);
  clearServerEnv();

  // --- TASK-005：输出沙箱（相对/绝对/越界/符号链接） (E-03) ---
  sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sandbox-'));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-outside-'));
  const realSandbox = fs.realpathSync(sandboxRoot);
  process.env.PLATFORM_COMMAND_USER_ID = 'alice';
  process.env.PLATFORM_COMMAND_OUTPUT_DIR = sandboxRoot;
  assert.equal(resolveOutputPath('a/b.xlsx'), path.join(realSandbox, 'a/b.xlsx'));
  assert.equal(resolveOutputPath(path.join(realSandbox, 'inner.json')), path.join(realSandbox, 'inner.json'));
  assert.throws(() => resolveOutputPath('../escape.xlsx'), /输出路径越界/);
  assert.throws(() => resolveOutputPath('/etc/pc-test-escape'), /输出路径越界/);
  fs.symlinkSync(outsideDir, path.join(realSandbox, 'link'));
  assert.throws(() => resolveOutputPath('link/file.xlsx'), /输出路径越界/);
  const sandboxExport = exportRows({ capability: 'export_excel', outputPath: 'ok.xlsx', columns: [{ key: 'a', title: 'A' }], rows: [{ a: 1 }], title: 't' });
  assert.ok(sandboxExport.outputPath.startsWith(realSandbox + path.sep));
  assert.ok(fs.existsSync(sandboxExport.outputPath));
  assert.throws(() => exportRows({ capability: 'export_excel', outputPath: '../leak.xlsx', columns: [], rows: [] }), /输出路径越界/);
  delete process.env.PLATFORM_COMMAND_OUTPUT_DIR;

  // --- TASK-004：run 记录归属（服务器模式带 userId，本地无新字段） (S-05) ---
  const serverRun = recordRun({ command: 'demo.meta', status: 'dry_run', dryRun: true });
  assert.equal(serverRun.userId, 'alice');
  fs.rmSync(serverRun.file, { force: true });
  clearServerEnv();
  const localRun = recordRun({ command: 'demo.meta', status: 'dry_run', dryRun: true });
  assert.equal('userId' in localRun, false);
  assert.equal('adapter' in localRun, false);
  assert.ok(localRun.file.startsWith(path.join(process.cwd(), '.platform-command')), 'local run records stay under cwd');
  fs.rmSync(localRun.file, { force: true });

  // --- DATA_DIR：服务器模式下 run 记录与会话标记锚定数据目录，不随子进程 cwd 漂移 ---
  const dataBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-data-'));
  try {
    process.env.PLATFORM_COMMAND_USER_ID = 'alice';
    process.env.PLATFORM_COMMAND_DATA_DIR = dataBase;
    const pinnedRun = recordRun({ command: 'demo.meta', status: 'dry_run', dryRun: true });
    assert.ok(pinnedRun.file.startsWith(path.resolve(dataBase) + path.sep), 'server-mode run records pinned to DATA_DIR');
    markSessionInvalid('pin.test', 'HTTP 401');
    assert.ok(fs.existsSync(path.join(path.resolve(dataBase), '.platform-command', 'sessions', 'pin.test.json')), 'session markers pinned to DATA_DIR');
    assert.equal(getSessionState('pin.test').invalid, true);
    clearSessionInvalid('pin.test');
    // DATA_DIR 也纳入 B-03 部分配置校验
    delete process.env.PLATFORM_COMMAND_USER_ID;
    assert.throws(() => resolveServerMode(), /服务器模式配置不完整/);
  } finally {
    clearServerEnv();
    fs.rmSync(dataBase, { recursive: true, force: true });
  }

  // --- TASK-006：会话失效标记生命周期（原子写 + 读取 + 清除） ---
  markSessionInvalid('API.Test', 'HTTP 401 for https://api.test/x');
  const invalidState = getSessionState('api.test');
  assert.equal(invalidState.invalid, true);
  assert.match(invalidState.reason, /401/);
  assert.ok(invalidState.at);
  clearSessionInvalid('api.test');
  assert.equal(getSessionState('api.test').invalid, false);

  // --- TASK-002：storageState 校验（缺失/损坏/缺字段 → 含导入指引） (E-01) ---
  assert.throws(() => playwrightAdapter.readStorageState('/nonexistent/state.json'), /storageState 文件不存在/);
  sessStateFile = path.join(os.tmpdir(), `pc-state-${process.pid}.json`);
  fs.writeFileSync(sessStateFile, 'not json');
  assert.throws(() => playwrightAdapter.readStorageState(sessStateFile), /JSON 解析失败/);
  fs.writeFileSync(sessStateFile, JSON.stringify({ origins: [] }));
  assert.throws(() => playwrightAdapter.readStorageState(sessStateFile), /缺少 cookies 数组/);
  try { playwrightAdapter.readStorageState('/nonexistent/state.json'); } catch (err) { assert.match(err.message, /import-storage-state/); }

  // --- TASK-002：fake playwright 下的 fetch / 401 标记 / 恢复清除 ---
  fs.writeFileSync(sessStateFile, JSON.stringify({ cookies: [{ name: 'csrf_token', value: 'tok-1', domain: 'api.test', path: '/' }], origins: [] }));
  process.env.PLATFORM_COMMAND_USER_ID = 'alice';
  process.env.PLATFORM_COMMAND_STORAGE_STATE = sessStateFile;
  const fetchQueue = [];
  const fakeContext = {
    request: {
      fetch: async () => {
        const next = fetchQueue.shift() || { status: 200, body: {} };
        return { status: () => next.status, ok: () => next.status < 400, json: async () => next.body, text: async () => JSON.stringify(next.body) };
      }
    },
    cookies: async () => [{ name: 'csrf_token', value: 'tok-1' }],
    pages: () => [],
    newPage: async () => ({ url: () => 'about:blank', goto: async () => {} }),
    close: async () => {}
  };
  const fakeBrowser = { isConnected: () => true, newContext: async () => fakeContext, close: async () => {} };
  playwrightAdapter.__setPlaywrightLoader(async () => ({ chromium: { launch: async () => fakeBrowser } }));

  fetchQueue.push({ status: 200, body: { code: 0 } });
  assert.equal((await playwrightAdapter.fetchViaPlaywright('https://api.test/v1/list')).code, 0);
  fetchQueue.push({ status: 401, body: {} });
  await assert.rejects(
    () => playwrightAdapter.fetchViaPlaywright('https://api.test/v1/list'),
    (err) => err.authRequired === true && /登录态已失效/.test(err.message) && /import-storage-state/.test(err.message)
  );
  assert.equal(getSessionState('api.test').invalid, true);
  fetchQueue.push({ status: 200, body: { code: 0 } });
  await playwrightAdapter.fetchViaPlaywright('https://api.test/v1/list');
  assert.equal(getSessionState('api.test').invalid, false);
  await playwrightAdapter.ensurePlaywrightSession('https://api.test/app#home');
  assert.equal((await playwrightAdapter.resolveSessionFromPlaywright('https://api.test/app')).csrfToken, 'tok-1');
  await playwrightAdapter.closePlaywright();

  // --- TASK-002：未安装 playwright → 明确报错，模块本身可加载 (RULE-02) ---
  playwrightAdapter.__setPlaywrightLoader(async () => { const e = new Error("Cannot find package 'playwright'"); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; });
  await assert.rejects(() => playwrightAdapter.fetchViaPlaywright('https://api.test/x'), /未安装可选依赖 playwright/);

  // --- TASK-003：适配器选择矩阵（browser_session_cookie 命令夹具） ---
  sessCmdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sess-cmd-'));
  fs.writeFileSync(path.join(sessCmdDir, 'demo.sess_pw.json'), JSON.stringify({
    name: 'demo.sess_pw', platform: 'demo', description: 'session command fixture', riskLevel: 'low',
    sessionRef: 'prelogged-test',
    runtime: { auth: { type: 'browser_session_cookie' } },
    learnedFrom: { url: 'https://api.test/app' },
    parameters: {},
    dataSource: { type: 'http_json', steps: [{ id: 'list', request: { method: 'GET', url: 'https://api.test/v1/items' }, collect: { itemsPath: 'data.items', limit: 10, map: [{ key: 'name', path: 'name' }] } }] },
    output: { capability: 'return_json', title: 'items' }
  }, null, 2));

  // Plan B：服务器模式 + storageState → http_json 命令走 node fetch + 注入 Cookie 头，不启动浏览器 (S-03/S-05)
  {
    const httpB = await import('node:http');
    let capturedB = null;
    const srvB = httpB.createServer((req, res) => {
      capturedB = { cookie: req.headers.cookie, csrf: req.headers['x-csrftoken'], origin: req.headers.origin, referer: req.headers.referer };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { items: [{ name: 'x' }], cursor: { is_end: true } } }));
    });
    await new Promise((r) => srvB.listen(0, '127.0.0.1', r));
    const portB = srvB.address().port;
    const stateB = path.join(os.tmpdir(), `pc-stateB-${process.pid}.json`);
    fs.writeFileSync(stateB, JSON.stringify({ cookies: [
      { name: 'csrf_token', value: 'tok-1', domain: '127.0.0.1', path: '/' },
      { name: 'soc-token', value: 'sess-b', domain: '127.0.0.1', path: '/' }
    ], origins: [] }));
    fs.writeFileSync(path.join(sessCmdDir, 'demo.sess_node.json'), JSON.stringify({
      name: 'demo.sess_node', platform: 'demo', description: 'd', riskLevel: 'low',
      runtime: { auth: { type: 'browser_session_cookie' } },
      learnedFrom: { url: `http://127.0.0.1:${portB}/app` },
      parameters: {},
      dataSource: { type: 'http_json', steps: [{ id: 'list', request: { method: 'GET', url: `http://127.0.0.1:${portB}/v1/items`, headers: { 'x-csrftoken': '{{session.csrfToken}}' } }, collect: { itemsPath: 'data.items', limit: 10, map: [{ key: 'name', path: 'name' }] } }] },
      output: { capability: 'return_json', title: 'items' }
    }));
    const savedState = process.env.PLATFORM_COMMAND_STORAGE_STATE;
    process.env.PLATFORM_COMMAND_STORAGE_STATE = stateB;
    const pwExec = await executeCommand('demo.sess_node', {}, { dryRun: false, confirm: true, commandsDir: sessCmdDir });
    process.env.PLATFORM_COMMAND_STORAGE_STATE = savedState;
    assert.equal(pwExec.status, 'executed');
    assert.equal(pwExec.adapter, 'node_http');                 // B：不再启动浏览器
    assert.deepEqual(pwExec.rows, [{ name: 'x' }]);
    assert.ok(capturedB.cookie && capturedB.cookie.includes('soc-token=sess-b'), 'Cookie 头注入了 storageState 会话 cookie');
    assert.equal(capturedB.csrf, 'tok-1', 'X-Csrftoken 取自 storageState 的 csrf_token');
    assert.equal(capturedB.origin, `http://127.0.0.1:${portB}`, 'Origin 按目标 origin 注入（CSRF 校验需要）');
    assert.ok(capturedB.referer && capturedB.referer.startsWith(`http://127.0.0.1:${portB}/`), 'Referer 按目标 origin 注入');
    const pwRunRecord = JSON.parse(fs.readFileSync(pwExec.runFile, 'utf8'));
    assert.equal(pwRunRecord.userId, 'alice');
    assert.equal(pwRunRecord.adapter, 'node_http');
    fs.rmSync(pwExec.runFile, { force: true });
    await new Promise((r) => srvB.close(r));
    fs.rmSync(stateB, { force: true });
  }

  // 服务器模式 dry-run readiness：playwright 可用 → ready
  const pwDry = await executeCommand('demo.sess_pw', {}, { dryRun: true, commandsDir: sessCmdDir });
  assert.equal(pwDry.readiness.ready, true);
  assert.equal(pwDry.readiness.adapters.playwright, true);
  fs.rmSync(pwDry.runFile, { force: true });

  // session 失效标记 → dry-run blocker (E-02)
  markSessionInvalid('api.test', 'HTTP 401');
  const invalidDry = await executeCommand('demo.sess_pw', {}, { dryRun: true, commandsDir: sessCmdDir });
  assert.equal(invalidDry.readiness.ready, false);
  assert.ok(invalidDry.readiness.blockers.some((item) => item.includes('登录态已失效')));
  clearSessionInvalid('api.test');
  fs.rmSync(invalidDry.runFile, { force: true });

  // B-03：部分配置 → dry-run blocker，run 记录不带 userId
  delete process.env.PLATFORM_COMMAND_USER_ID;
  const partialDry = await executeCommand('demo.sess_pw', {}, { dryRun: true, commandsDir: sessCmdDir });
  assert.equal(partialDry.readiness.ready, false);
  assert.ok(partialDry.readiness.blockers.some((item) => item.includes('服务器模式配置不完整')));
  assert.equal('userId' in JSON.parse(fs.readFileSync(partialDry.runFile, 'utf8')), false);
  fs.rmSync(partialDry.runFile, { force: true });

  // --- TASK-007：本地模式（零 env）兼容回归 (S-06 / E-05) ---
  // 把 webbridge 探测指向一个必然连不上的端口，使本用例不依赖"真实 kimi-webbridge
  // daemon 恰好没在跑"这个外部环境状态（否则本机起着 daemon 时会误判）。
  clearServerEnv();
  const savedWbPort = process.env.PLATFORM_COMMAND_WEBBRIDGE_PORT;
  process.env.PLATFORM_COMMAND_WEBBRIDGE_PORT = '0'; // 0 端口探测必然失败
  try {
    const localDry = await executeCommand('demo.sess_pw', {}, { dryRun: true, commandsDir: sessCmdDir });
    assert.equal(localDry.readiness.ready, false);
    assert.ok(localDry.readiness.blockers[0].includes('kimi-webbridge 未运行'));
    assert.deepEqual(Object.keys(localDry.readiness.adapters).sort(), ['nodeHttp', 'webbridge'], 'local readiness shape must not change');
    fs.rmSync(localDry.runFile, { force: true });
    let localExecErr = null;
    try { await executeCommand('demo.sess_pw', {}, { dryRun: false, confirm: true, commandsDir: sessCmdDir }); } catch (err) { localExecErr = err; }
    assert.ok(localExecErr, 'local real exec without webbridge must fail');
    assert.match(localExecErr.message, /kimi-webbridge 未运行/);
    if (localExecErr.runFile) fs.rmSync(localExecErr.runFile, { force: true });
  } finally {
    if (savedWbPort === undefined) delete process.env.PLATFORM_COMMAND_WEBBRIDGE_PORT;
    else process.env.PLATFORM_COMMAND_WEBBRIDGE_PORT = savedWbPort;
  }

  // ===== UI 执行引擎（legacy execution.ui，post_comment 形态）=====
  const { extractUiActions, hasUiExecution } = await import('../src/engine/ui_executor.js');
  const uiCmd = {
    name: 'demo.ui_post', platform: 'demo', riskLevel: 'high',
    runtime: { auth: { type: 'browser_session_cookie' } },
    learnedFrom: { url: 'https://demo.test/v/1' },
    parameters: { text: { type: 'string' }, autoPublish: { type: 'boolean', default: false } },
    execution: { prefer: ['ui'], ui: { actions: [
      { action: 'goto', target: 'https://demo.test/v/1' },
      { action: 'waitFor', selector: 'textarea' },
      { action: 'fill', selector: 'textarea', value: '{{params.text}}' },
      { action: 'click', selector: 'button.send', when: '{{params.autoPublish}}' }
    ] } }
  };
  assert.equal(hasUiExecution(uiCmd), true);
  assert.equal(hasUiExecution({ name: 'x', dataSource: {} }), false);
  // 模板渲染 + when 门：autoPublish=false → click.when 渲染为 false
  const actsNoPublish = extractUiActions(uiCmd, { text: 'hi', autoPublish: false });
  assert.equal(actsNoPublish[2].value, 'hi');
  assert.equal(actsNoPublish[3].when, false);

  // capability gate：UI 命令仅在服务器模式 + storageState 下 executable
  const uiCmdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ui-cmd-'));
  try {
    fs.writeFileSync(path.join(uiCmdDir, 'demo.ui_post.json'), JSON.stringify(uiCmd));
    clearServerEnv();
    assert.equal(getExecutionCapability(uiCmd).executable, false, '本地模式 UI 命令不可执行');
    assert.equal(getExecutionCapability(uiCmd).mode, 'ui_plan');
    process.env.PLATFORM_COMMAND_USER_ID = 'alice';
    process.env.PLATFORM_COMMAND_STORAGE_STATE = sessStateFile; // 上文已写入有效 storageState
    const cap = getExecutionCapability(uiCmd);
    assert.equal(cap.executable, true, '服务器模式 UI 命令可执行');
    assert.equal(cap.engine, 'playwright_ui');

    // 真实执行：fake playwright page（handle 流）记录动作序列；when=false 跳过 click
    const pageCalls = [];
    const makeHandle = (selector) => ({
      asElement: () => ({
        fill: async (v) => pageCalls.push(['fill', selector, v]),
        click: async () => pageCalls.push(['click', selector]),
        type: async (v) => pageCalls.push(['type', selector, v]),
        selectOption: async (v) => pageCalls.push(['select', selector, v]),
        scrollIntoViewIfNeeded: async () => pageCalls.push(['scroll', selector]),
        // tagName非 input/textarea → fill 走键盘输入路径（contenteditable 编辑器）
        evaluate: async () => 'div'
      }),
      dispose: async () => {}
    });
    const fakePage = {
      goto: async (u) => pageCalls.push(['goto', u]),
      evaluateHandle: async (_fn, selector) => { pageCalls.push(['waitFor', selector]); return makeHandle(selector); },
      keyboard: { type: async (v) => pageCalls.push(['fill', 'keyboard', v]), press: async () => {} },
      on: () => {},
      waitForTimeout: async () => {},
      screenshot: async (o) => pageCalls.push(['screenshot', o.path]),
      close: async () => {}
    };
    const uiFakeContext = { ...fakeContext, newPage: async () => fakePage, pages: () => [] };
    const uiFakeBrowser = { isConnected: () => true, newContext: async () => uiFakeContext, close: async () => {} };
    playwrightAdapter.__setPlaywrightLoader(async () => ({ chromium: { launch: async () => uiFakeBrowser } }));

    const uiRun = await executeCommand('demo.ui_post', { text: 'hello', autoPublish: false }, { dryRun: false, confirm: true, commandsDir: uiCmdDir });
    assert.equal(uiRun.status, 'executed');
    assert.equal(uiRun.adapter, 'playwright');
    assert.ok(pageCalls.some((c) => c[0] === 'fill' && c[2] === 'hello'), 'fill 渲染参数（键盘输入路径）');
    assert.ok(!pageCalls.some((c) => c[0] === 'click' && /send/.test(c[1])), 'autoPublish=false 跳过发布 click');
    const uiRec = JSON.parse(fs.readFileSync(uiRun.runFile, 'utf8'));
    assert.equal(uiRec.userId, 'alice');
    assert.equal(uiRec.adapter, 'playwright');
    fs.rmSync(uiRun.runFile, { force: true });

    // autoPublish=true → click 执行
    pageCalls.length = 0;
    const uiRun2 = await executeCommand('demo.ui_post', { text: 'go', autoPublish: true }, { dryRun: false, confirm: true, commandsDir: uiCmdDir });
    assert.ok(pageCalls.some((c) => c[0] === 'click' && /send/.test(c[1])), 'autoPublish=true 执行发布 click');
    fs.rmSync(uiRun2.runFile, { force: true });
    await playwrightAdapter.closePlaywright();
  } finally {
    clearServerEnv();
    fs.rmSync(uiCmdDir, { recursive: true, force: true });
  }

  // --- TASK-007：MCP tools schema 快照（RULE-05：不发生破坏性变更） ---
  const mcpToolsSnapshot = await handleMcpRequest({ jsonrpc: '2.0', id: 91, method: 'tools/list' });
  assert.deepEqual(mcpToolsSnapshot.result.tools.map((tool) => tool.name).sort(), [
    'platform_command_agent_manifest',
    'platform_command_describe',
    'platform_command_docs',
    'platform_command_doctor',
    'platform_command_execute',
    'platform_command_explain',
    'platform_command_learn',
    'platform_command_list',
    'platform_command_schedule',
    'platform_command_verify'
  ]);
  assert.ok(mcpToolsSnapshot.result.tools.every((tool) => tool.inputSchema && tool.inputSchema.type === 'object'));
} finally {
  for (const key of SERVER_ENV_KEYS) {
    if (savedServerEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedServerEnv[key];
  }
  playwrightAdapter.__setPlaywrightLoader(null);
  if (sandboxRoot) fs.rmSync(sandboxRoot, { recursive: true, force: true });
  if (outsideDir) fs.rmSync(outsideDir, { recursive: true, force: true });
  if (sessStateFile) fs.rmSync(sessStateFile, { force: true });
  if (sessCmdDir) fs.rmSync(sessCmdDir, { recursive: true, force: true });
}

console.log('Server-mode tests passed.');

// --- TASK-001：平台 store 层（FEAT-01） ---
{
  const storeCmdDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-store-'));
  try {
    // 读不存在 → null
    assert.equal(readStore(storeCmdDir, 'C123'), null);
    assert.deepEqual(listStore(storeCmdDir), []);
    // 写后读回
    const w1 = writeStore(storeCmdDir, 'C123', { company_name: 'Acme', send_email: false });
    assert.deepEqual(w1, { company_name: 'Acme', send_email: false });
    assert.deepEqual(readStore(storeCmdDir, 'C123'), { company_name: 'Acme', send_email: false });
    // 补丁浅合并（保留旧字段，覆盖同名）
    const w2 = writeStore(storeCmdDir, 'C123', { send_email: true, sync_portal: true });
    assert.deepEqual(w2, { company_name: 'Acme', send_email: true, sync_portal: true });
    assert.deepEqual(readStore(storeCmdDir, 'C123'), { company_name: 'Acme', send_email: true, sync_portal: true });
    // replaceStore 整体替换
    replaceStore(storeCmdDir, 'C123', { only: 1 });
    assert.deepEqual(readStore(storeCmdDir, 'C123'), { only: 1 });
    // listStore 列出 key
    writeStore(storeCmdDir, 'C999', { a: 1 });
    assert.deepEqual(listStore(storeCmdDir).sort(), ['C123', 'C999']);
    // deleteStore
    assert.equal(deleteStore(storeCmdDir, 'C999'), true);
    assert.equal(deleteStore(storeCmdDir, 'C999'), false);
    assert.deepEqual(listStore(storeCmdDir), ['C123']);
    // 路径穿越被拒
    assert.throws(() => readStore(storeCmdDir, '../escape'), /Invalid store key/);
    assert.throws(() => writeStore(storeCmdDir, 'a/b', { x: 1 }), /Invalid store key/);
    assert.throws(() => readStore(storeCmdDir, '..'), /Invalid store key/);
    // 非对象 patch 被拒
    assert.throws(() => writeStore(storeCmdDir, 'C123', [1, 2]), /must be a plain object/);
  } finally {
    fs.rmSync(storeCmdDir, { recursive: true, force: true });
  }
}
console.log('store layer tests passed.');

// --- TASK-002：workflow 组合执行引擎（FEAT-02） ---
{
  const wfHttp = await import('node:http');
  const wfDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-wf-'));
  let capturedB = null;
  const wfServer = wfHttp.createServer((req, res) => {
    if (req.url.startsWith('/a')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { token: 'T123' } }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      capturedB = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: {}, echoed: capturedB }));
    });
  });
  await new Promise((resolve) => wfServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = wfServer.address();
    const mkAtomic = (name, urlPath, extra) => ({
      name, platform: 'demo', description: 'd', riskLevel: 'low', parameters: extra.parameters || {},
      dataSource: { type: 'http_json', steps: [{ id: 's', request: { method: extra.method || 'GET', url: `http://127.0.0.1:${port}${urlPath}`, body: extra.body, expect: { bodyCode: 0 } }, extract: extra.extract }] },
      output: { capability: 'return_json' },
      steps: [{ id: 'x', type: 'manual', manual: 'run' }]
    });
    fs.writeFileSync(path.join(wfDir, 'demo.sub_a.json'), JSON.stringify(mkAtomic('demo.sub_a', '/a', { extract: { token: 'data.token' } })));
    fs.writeFileSync(path.join(wfDir, 'demo.sub_b.json'), JSON.stringify(mkAtomic('demo.sub_b', '/b', { method: 'POST', body: { got: '{{params.passed}}' }, parameters: { passed: { type: 'string' } }, extract: { echoed: 'echoed' } })));
    // 组合命令：a → b，b 的参数引用 a 的 meta.token
    const composed = {
      name: 'demo.compose', platform: 'demo', description: 'compose', riskLevel: 'low', parameters: { flag: { type: 'boolean', default: true } },
      steps: [
        { id: 'a', command: 'demo.sub_a', extract: { token: 'meta.token' } },
        { id: 'b', command: 'demo.sub_b', dependsOn: ['a'], when: '{{params.flag}}', params: { passed: '{{steps.a.token}}' } }
      ]
    };
    fs.writeFileSync(path.join(wfDir, 'demo.compose.json'), JSON.stringify(composed));

    // 能力识别：组合工作流可执行
    const cap = getExecutionCapability(loadCommand('demo.compose', { commandsDir: wfDir }).command);
    assert.equal(cap.executable, true);
    assert.equal(cap.engine, 'workflow_compose');
    // verify 通过（command step 合法）
    assert.equal(verifyCommand('demo.compose', { commandsDir: wfDir }).ok, true);

    // 真实执行：参数从 a 管道到 b
    const run = await executeCommand('demo.compose', {}, { dryRun: false, confirm: true, commandsDir: wfDir });
    assert.equal(run.status, 'executed', JSON.stringify(run));
    assert.equal(run.capability, 'workflow_compose');
    assert.ok(capturedB && capturedB.includes('T123'), `piping failed, capturedB=${capturedB}`);
    assert.equal(run.steps.find((s) => s.id === 'b').status, 'executed');

    // when=false 跳过 b
    capturedB = null;
    const runSkip = await executeCommand('demo.compose', { flag: false }, { dryRun: false, confirm: true, commandsDir: wfDir });
    assert.equal(runSkip.status, 'executed');
    assert.equal(capturedB, null, 'b should be skipped when flag=false');
    assert.equal(runSkip.steps.find((s) => s.id === 'b').skipped, true);

    // 失败中止：子命令验收失败 → 组合返回 failed + failedStep
    fs.writeFileSync(path.join(wfDir, 'demo.sub_fail.json'), JSON.stringify({
      name: 'demo.sub_fail', platform: 'demo', description: 'd', riskLevel: 'low', parameters: {},
      dataSource: { type: 'inline', rows: [] }, output: { capability: 'return_json' },
      acceptance: { criteria: [{ id: 'rows', type: 'data_contains', expect: { minCount: 1 } }] },
      steps: [{ id: 'x', type: 'manual', manual: 'run' }]
    }));
    fs.writeFileSync(path.join(wfDir, 'demo.compose_fail.json'), JSON.stringify({
      name: 'demo.compose_fail', platform: 'demo', description: 'd', riskLevel: 'low', parameters: {},
      steps: [{ id: 'f', command: 'demo.sub_fail' }, { id: 'after', command: 'demo.sub_a', dependsOn: ['f'] }]
    }));
    const runFail = await executeCommand('demo.compose_fail', {}, { dryRun: false, confirm: true, commandsDir: wfDir });
    assert.equal(runFail.status, 'failed');
    assert.equal(runFail.failedStep, 'f');
    assert.ok(!runFail.steps.find((s) => s.id === 'after'), 'after step must not run when prior fails');
  } finally {
    await new Promise((resolve) => wfServer.close(resolve));
    fs.rmSync(wfDir, { recursive: true, force: true });
  }
}
console.log('workflow compose engine tests passed.');

// --- TASK-012 支撑：store 命令引擎（read 自动初始化 / merge 合并） ---
{
  const cfgDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-cfg-'));
  try {
    const defaults = { a: 1, b: false, nested: { x: [] } };
    fs.writeFileSync(path.join(cfgDir, 'demo.cfg.json'), JSON.stringify({
      name: 'demo.cfg', platform: 'demo', description: 'd', riskLevel: 'low',
      parameters: { id: { type: 'string', required: true } },
      store: { op: 'read', key: '{{params.id}}', defaults },
      steps: [{ id: 'r', type: 'manual', manual: 'read' }]
    }));
    fs.writeFileSync(path.join(cfgDir, 'demo.cfgw.json'), JSON.stringify({
      name: 'demo.cfgw', platform: 'demo', description: 'd', riskLevel: 'medium',
      parameters: { id: { type: 'string', required: true }, config: { type: 'object', required: true } },
      store: { op: 'merge', key: '{{params.id}}', patch: '{{params.config}}', defaults },
      steps: [{ id: 'm', type: 'manual', manual: 'merge' }]
    }));
    // verify
    assert.equal(verifyCommand('demo.cfg', { commandsDir: cfgDir }).ok, true);
    // read → 自动初始化
    const r1 = await executeCommand('demo.cfg', { id: 'X1' }, { dryRun: false, confirm: true, commandsDir: cfgDir });
    assert.equal(r1.status, 'executed');
    assert.equal(r1.meta.a, 1);
    assert.equal(r1.meta._initialized, true);
    assert.ok(fs.existsSync(path.join(cfgDir, 'store', 'X1.json')), 'store file should be created');
    // merge → 只改给定字段
    const r2 = await executeCommand('demo.cfgw', { id: 'X1', config: { b: true, c: 'new' } }, { dryRun: false, confirm: true, commandsDir: cfgDir });
    assert.equal(r2.meta.a, 1);
    assert.equal(r2.meta.b, true);
    assert.equal(r2.meta.c, 'new');
    // 再 read → 已存在不再初始化，保留合并结果
    const r3 = await executeCommand('demo.cfg', { id: 'X1' }, { dryRun: false, confirm: true, commandsDir: cfgDir });
    assert.equal(r3.meta._initialized, false);
    assert.equal(r3.meta.b, true);
    assert.equal(r3.meta.c, 'new');
  } finally {
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
}
console.log('store command engine tests passed.');

// --- TASK-005/007 支撑：body 变换钩子（bodyBuilder） ---
{
  const btHttp = await import('node:http');
  const btDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-bt-'));
  let captured = null;
  const btServer = btHttp.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captured = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, echoed: captured }));
    });
  });
  await new Promise((resolve) => btServer.listen(0, '127.0.0.1', resolve));
  try {
    fs.mkdirSync(path.join(btDir, 'code'), { recursive: true });
    fs.writeFileSync(path.join(btDir, 'code', 'builder.js'),
      'export function buildBody(_b,{context}){return {built:true, who:context.params.who, n:(context.params.n||0)+1};}\n');
    const { port } = btServer.address();
    await readDataSource({
      type: 'http_json',
      steps: [{
        id: 's',
        request: {
          method: 'POST',
          url: `http://127.0.0.1:${port}/x`,
          body: { ignored: true },
          bodyBuilder: './code/builder.js',
          expect: { bodyCode: 0 }
        },
        extract: { echoed: 'echoed' }
      }]
    }, { who: 'alice', n: 4 }, { commandDir: btDir });
    assert.equal(captured, JSON.stringify({ built: true, who: 'alice', n: 5 }), `bodyBuilder output not sent: ${captured}`);
  } finally {
    await new Promise((resolve) => btServer.close(resolve));
    fs.rmSync(btDir, { recursive: true, force: true });
  }
}
console.log('body builder hook tests passed.');

// --- TASK-005：date_range 计算（复刻 calc_date_range） ---
{
  const today = new Date(2026, 5, 15); // 2026-06-15
  assert.deepEqual(calcDateRange('weekly', 'Last 7 days', today), { startTime: '2026-06-08', endTime: '2026-06-14' });
  assert.deepEqual(calcDateRange('monthly', 'Last 30 days', today), { startTime: '2026-05-16', endTime: '2026-06-14' });
  assert.deepEqual(calcDateRange('monthly', 'Last month', today), { startTime: '2026-05-01', endTime: '2026-05-31' });
  const lw = calcDateRange('weekly', 'Last week', today);
  assert.equal(new Date(lw.startTime).getDay(), 1, 'Last week start must be Monday');
  assert.equal(new Date(lw.endTime).getDay(), 0, 'Last week end must be Sunday');
  assert.ok(lw.endTime < '2026-06-15', 'Last week end before today');
  // 月末边界：1/31 当 2 月 → 上月为 1 月 31 天
  assert.deepEqual(calcDateRange('monthly', 'Last month', new Date(2026, 2, 10)), { startTime: '2026-02-01', endTime: '2026-02-28' });
}
console.log('date range tests passed.');

// --- TASK-003：拦截执行器纯逻辑（response 改写 / 轮询状态机） ---
{
  const rw = applyResponseRewrite(JSON.stringify({ data: { weekly_export_config: { export_locales: ['en'] } } }),
    [{ path: 'data.weekly_export_config.export_locales', value: ['en', 'id'] }]);
  assert.deepEqual(JSON.parse(rw).data.weekly_export_config.export_locales, ['en', 'id']);
  assert.equal(applyResponseRewrite('not json', [{ path: 'a', value: 1 }]), 'not json');

  // setPath：正常嵌套写入；原型链键必须抛错（防原型污染），且不得污染 Object.prototype。
  assert.deepEqual(setPath({}, 'a.b.c', 1), { a: { b: { c: 1 } } });
  assert.throws(() => setPath({}, '__proto__.polluted', 1), /unsafe key/);
  assert.throws(() => setPath({}, 'a.constructor.x', 1), /unsafe key/);
  assert.equal(({}).polluted, undefined);

  let n = 0;
  const ready = await pollUntilReady(async () => ({ data: { list: [{ task_id: 'T1', task_status: (++n >= 2 ? 1 : 0) }] } }),
    { itemsPath: 'data.list', matchField: 'task_id', matchValue: 'T1', readyField: 'task_status', readyValue: 1, intervalMs: 1, timeoutMs: 1000 });
  assert.equal(ready.ready, true);
  assert.ok(ready.polls >= 2);

  const failed = await pollUntilReady(async () => ({ data: { list: [{ task_id: 'T1', task_status: 2 }] } }),
    { itemsPath: 'data.list', matchField: 'task_id', matchValue: 'T1', readyField: 'task_status', readyValue: 1, failValues: [2], intervalMs: 1, timeoutMs: 1000 });
  assert.equal(failed.failed, true);

  const timedOut = await pollUntilReady(async () => ({ data: { list: [] } }),
    { itemsPath: 'data.list', matchField: 'task_id', matchValue: 'X', readyField: 'task_status', readyValue: 1, intervalMs: 1, timeoutMs: 15 });
  assert.equal(timedOut.timedOut, true);
}
console.log('intercept helpers tests passed.');

// --- 多站点 host 解析（国内/海外同一套命令打不同实例）---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sites-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'sites.json'), JSON.stringify({
    default: 'sea',
    sites: { sea: 'https://soar.sea.sangfor.com', cn: 'https://soar.sangfor.com.cn' }
  }));
  const savedEnv = process.env.PLATFORM_COMMAND_SITE;
  delete process.env.PLATFORM_COMMAND_SITE;

  // 无配置目录 → null（向后兼容：不改写）
  assert.equal(resolveSiteOrigin({}, { commandDir: path.join(dir, 'nope') }), null);

  // 默认选 sea
  assert.equal(resolveSiteOrigin({}, { commandDir: dir }).host, 'soar.sea.sangfor.com');

  // env 覆盖默认
  process.env.PLATFORM_COMMAND_SITE = 'cn';
  assert.equal(resolveSiteOrigin({}, { commandDir: dir }).host, 'soar.sangfor.com.cn');

  // param 最高优先级（压过 env）
  assert.equal(resolveSiteOrigin({ site: 'sea' }, { commandDir: dir }).host, 'soar.sea.sangfor.com');
  delete process.env.PLATFORM_COMMAND_SITE;

  // 未知 site → 抛错并列出可选
  assert.throws(() => resolveSiteOrigin({ site: 'us' }, { commandDir: dir }), /未知 site 'us'.*sea, cn/s);

  // applySiteOrigin：换 origin 保留 path/query；空 site / 相对 url 不动
  const cn = resolveSiteOrigin({ site: 'cn' }, { commandDir: dir });
  assert.equal(applySiteOrigin('https://soar.sea.sangfor.com/order/v1/report/report_status?x=1', cn),
    'https://soar.sangfor.com.cn/order/v1/report/report_status?x=1');
  assert.equal(applySiteOrigin('https://soar.sea.sangfor.com/index.html', null), 'https://soar.sea.sangfor.com/index.html');
  assert.equal(applySiteOrigin('/relative/path', cn), '/relative/path');

  if (savedEnv !== undefined) process.env.PLATFORM_COMMAND_SITE = savedEnv;
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('multi-site host resolution tests passed.');

// --- TASK-003：拦截流编排（fake playwright：改写 export_locales + 捕获 taskId + 轮询） ---
{
  const pa = await import('../src/adapter/playwright_adapter.js');
  const stateFile = path.join(process.cwd(), '.tmp-ic-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ cookies: [{ name: 'csrf_token', value: 'x', domain: 'soar.test', path: '/' }], origins: [] }));
  const savedState = process.env.PLATFORM_COMMAND_STORAGE_STATE;
  const savedUser = process.env.PLATFORM_COMMAND_USER_ID;
  process.env.PLATFORM_COMMAND_STORAGE_STATE = stateFile;
  process.env.PLATFORM_COMMAND_USER_ID = 'tester';
  let rewritten = null;
  const routes = [];
  let respCb = null;
  const fakePage = {
    route: async (matcher, handler) => routes.push({ matcher, handler }),
    on: (ev, cb) => { if (ev === 'response') respCb = cb; },
    goto: async () => {
      for (const r of routes) {
        await r.handler({
          fetch: async () => ({ text: async () => JSON.stringify({ data: { weekly_export_config: { export_locales: ['en'] } } }) }),
          fulfill: async (o) => { rewritten = o.body; },
          continue: async () => {}
        });
      }
      if (respCb) await respCb({ url: () => 'https://soar.test/order/v1/report/generate_report', json: async () => ({ code: 0, data: { _id: 'TASK99' } }) });
    },
    waitForTimeout: async () => {},
    close: async () => {}
  };
  let pollCalls = 0;
  const fakeContext = {
    newPage: async () => fakePage,
    pages: () => [],
    cookies: async () => [{ name: 'csrf_token', value: 'x' }],
    request: { fetch: async () => ({ status: () => 200, ok: () => true, json: async () => ({ code: 0, data: { list: [{ task_id: 'TASK99', task_status: (++pollCalls >= 2 ? 1 : 0) }] } }) }) }
  };
  const fakeBrowser = { isConnected: () => true, newContext: async () => fakeContext, close: async () => {} };
  pa.__setPlaywrightLoader(async () => ({ chromium: { launch: async () => fakeBrowser } }));
  try {
    const cmd = {
      name: 'demo.export_ic',
      interceptFlow: {
        url: 'https://soar.test/report_edit.html#/x',
        rewrite: [{ urlPattern: '/get_history_pwd', set: [{ path: 'data.weekly_export_config.export_locales', value: ['en', 'id'] }] }],
        capture: [{ urlPattern: '/generate_report', extract: { taskId: 'data._id', code: 'code' } }],
        waitMs: 200,
        poll: { url: 'https://soar.test/order/v1/report/report_status', method: 'POST', body: {}, itemsPath: 'data.list', matchField: 'task_id', matchValue: '{{capture.taskId}}', readyField: 'task_status', readyValue: 1, intervalMs: 1, timeoutMs: 1000 }
      }
    };
    const res = await executeInterceptFlow(cmd, {});
    assert.equal(res.status, 'executed', JSON.stringify(res));
    assert.equal(res.meta.taskId, 'TASK99');
    assert.deepEqual(JSON.parse(rewritten).data.weekly_export_config.export_locales, ['en', 'id']);
    assert.equal(res.meta.poll.ready, true);
  } finally {
    pa.__setPlaywrightLoader(null);
    await pa.closePlaywright();
    if (savedState === undefined) delete process.env.PLATFORM_COMMAND_STORAGE_STATE;
    else process.env.PLATFORM_COMMAND_STORAGE_STATE = savedState;
    if (savedUser === undefined) delete process.env.PLATFORM_COMMAND_USER_ID;
    else process.env.PLATFORM_COMMAND_USER_ID = savedUser;
    fs.rmSync(stateFile, { force: true });
  }
}
console.log('intercept flow orchestration tests passed.');

// --- TASK-004：daemon 核心（漏执行 / 并发 / 心跳 / schedule 加载） ---
{
  // 周报漏执行：区间内所有周三 10:00
  const wHits = iterTriggerTimes({ weekday: 'WED', time: '10:00' }, 'weekly', new Date(2026, 5, 1, 0, 0), new Date(2026, 5, 16, 23, 59));
  assert.ok(wHits.length >= 2, `expected >=2 weekly hits, got ${wHits.length}`);
  assert.ok(wHits.every((d) => (d.getDay() + 6) % 7 === 2 && d.getHours() === 10 && d.getMinutes() === 0), 'all hits Wed 10:00');

  // 月末边界 B-02：monthday=31 跨 2 月 → 取当月最后一天
  const mHits = iterTriggerTimes({ monthday: 31, time: '09:00' }, 'monthly', new Date(2026, 0, 15), new Date(2026, 2, 15));
  assert.equal(mHits.length, 2, `expected Jan31 + Feb28, got ${mHits.length}`);
  assert.equal(mHits[0].getMonth(), 0); assert.equal(mHits[0].getDate(), 31);
  assert.equal(mHits[1].getMonth(), 1); assert.equal(mHits[1].getDate(), 28);

  // computeMissedJobs 汇总
  const missed = computeMissedJobs(
    [{ id: 'C1_weekly', command: 'mss.export_weekly', params: { companyId: 'C1' }, schedule: { weekday: 'WED', time: '10:00' }, kind: 'weekly' }],
    new Date(2026, 5, 1), new Date(2026, 5, 16, 23, 59)
  );
  assert.equal(missed.length, 1);
  assert.ok(missed[0].hits.length >= 2);

  // 并发上限 B-01：6 任务 maxWorkers=2，峰值并发不超 2，全部执行
  let active = 0, peak = 0, ran = 0;
  const mkTask = () => async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    ran += 1; active -= 1;
    return 'ok';
  };
  const res = await runWithConcurrency(Array.from({ length: 6 }, mkTask), 2);
  assert.equal(ran, 6);
  assert.equal(res.filter((r) => r.ok).length, 6);
  assert.ok(peak <= 2, `peak concurrency ${peak} must be <= 2`);

  // 心跳读写
  const hbFile = path.join(process.cwd(), '.tmp-heartbeat.txt');
  const t = new Date(2026, 5, 15, 8, 30, 0);
  writeHeartbeat(hbFile, t);
  assert.equal(readHeartbeat(hbFile).getTime(), t.getTime());
  assert.equal(readHeartbeat(path.join(process.cwd(), '.nope-hb.txt')), null);
  fs.rmSync(hbFile, { force: true });

  // schedule 加载（注入 readStoreDir）：store 配置 → 指向业务命令的条目
  const entries = loadScheduleEntries('/x', 'mss', { weekly: 'mss.export_weekly', monthly: 'mss.export_monthly' }, () => ([
    { key: 'C1', config: { weekly_schedule: { weekday: 'WED', time: '10:00' }, monthly_schedule: null } },
    { key: 'C2', config: { monthly_schedule: { monthday: 1, time: '09:00' } } }
  ]));
  assert.equal(entries.length, 2);
  const c1 = entries.find((e) => e.id === 'C1_weekly');
  assert.equal(c1.command, 'mss.export_weekly');
  assert.deepEqual(c1.params, { companyId: 'C1' });
  const c2 = entries.find((e) => e.id === 'C2_monthly');
  assert.equal(c2.command, 'mss.export_monthly');

  // selectDueJobs：到点入队，但已 pending（队列中/执行中）的不重复入队（避免长任务期间重复触发）
  const sdEntries = [{ id: 'C1_weekly', command: 'x', params: {}, schedule: { weekday: 'WED', time: '10:00' }, kind: 'weekly' }];
  const wedAt10 = new Date(2026, 5, 10, 9, 0); // 2026-06-10 是周三；窗口跨过 10:00
  const due1 = selectDueJobs(sdEntries, wedAt10, new Date(2026, 5, 10, 11, 0), new Set());
  assert.equal(due1.length, 1);
  const due2 = selectDueJobs(sdEntries, wedAt10, new Date(2026, 5, 10, 11, 0), new Set(['C1_weekly']));
  assert.equal(due2.length, 0, 'pending job must not be re-enqueued');
}
console.log('daemon core tests passed.');

// --- daemon 停止信号跨平台选择（Windows 无 SIGTERM）---
{
  const win = stopSignalsForPlatform('win32');
  assert.ok(win.includes('SIGINT'), 'Windows 必须含 SIGINT');
  assert.ok(win.includes('SIGBREAK'), 'Windows 用 SIGBREAK（Ctrl+Break）');
  assert.ok(!win.includes('SIGTERM'), 'Windows 不监听 SIGTERM（不会触发）');

  for (const posix of ['linux', 'darwin']) {
    const sigs = stopSignalsForPlatform(posix);
    assert.ok(sigs.includes('SIGTERM') && sigs.includes('SIGINT'), `${posix} 含 SIGTERM/SIGINT`);
    assert.ok(!sigs.includes('SIGBREAK'), `${posix} 不含 Windows 专属 SIGBREAK`);
  }
}
console.log('daemon stop-signal platform selection tests passed.');

// --- TASK-014 支撑：http_json extract 列表取单项（fromList/where/pick） ---
{
  const lpHttp = await import('node:http');
  const lpServer = lpHttp.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { template_list: [
      { template_id: 'W1', template_name: 'Weekly Security Report' },
      { template_id: 'M1', template_name: 'Monthly Security Report' }
    ] } }));
  });
  await new Promise((resolve) => lpServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = lpServer.address();
    const data = await readDataSource({
      type: 'http_json',
      steps: [{
        id: 'tpl',
        request: { method: 'POST', url: `http://127.0.0.1:${port}/t`, body: {}, expect: { bodyCode: 0 } },
        extract: {
          weeklyId: { fromList: 'data.template_list', where: { template_name: 'Weekly Security Report' }, pick: 'template_id' },
          monthlyId: { fromList: 'data.template_list', where: { template_name: 'Monthly Security Report' }, pick: 'template_id' },
          missing: { fromList: 'data.template_list', where: { template_name: 'Nope' }, pick: 'template_id' }
        }
      }]
    }, {});
    assert.equal(data.meta.weeklyId, 'W1');
    assert.equal(data.meta.monthlyId, 'M1');
    assert.equal(data.meta.missing, undefined);
  } finally {
    await new Promise((resolve) => lpServer.close(resolve));
  }
}
console.log('list-pick extract tests passed.');

// --- TASK-015：workflow forEach 循环 + 末端输出汇总 ---
{
  const feDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-fe-'));
  try {
    // 子命令：返回客户列表（inline rows → return_json）
    fs.writeFileSync(path.join(feDir, 'demo.colist.json'), JSON.stringify({
      name: 'demo.colist', platform: 'demo', description: 'd', riskLevel: 'low', parameters: {},
      dataSource: { type: 'inline', rows: [{ companyId: 'C1' }, { companyId: 'C2' }] },
      output: { capability: 'return_json' }, steps: [{ id: 'x', type: 'manual', manual: 'list' }]
    }));
    // 子命令：按 companyId 读 store 配置（meta=config，缺失自动初始化）
    fs.writeFileSync(path.join(feDir, 'demo.cocfg.json'), JSON.stringify({
      name: 'demo.cocfg', platform: 'demo', description: 'd', riskLevel: 'low',
      parameters: { companyId: { type: 'string', required: true } },
      store: { op: 'read', key: '{{params.companyId}}', defaults: { tier: 'std', send_email: false } },
      steps: [{ id: 'r', type: 'manual', manual: 'read' }]
    }));
    // 组合：搜客户 → forEach 逐个读配置 → return_json 汇总
    fs.writeFileSync(path.join(feDir, 'demo.allcfg.json'), JSON.stringify({
      name: 'demo.allcfg', platform: 'demo', description: 'batch', riskLevel: 'low', parameters: {},
      strategy: 'sequential',
      steps: [
        { id: 'companies', command: 'demo.colist' },
        { id: 'configs', forEach: '{{steps.companies.rows}}', as: 'co', command: 'demo.cocfg', dependsOn: ['companies'], params: { companyId: '{{co.companyId}}' } }
      ],
      output: { capability: 'return_json', title: 't', source: '{{steps.configs.rows}}' }
    }));
    const run = await executeCommand('demo.allcfg', {}, { dryRun: false, confirm: true, commandsDir: feDir });
    assert.equal(run.status, 'executed', JSON.stringify(run));
    assert.equal(run.capability, 'return_json');
    assert.ok(Array.isArray(run.rows));
    assert.equal(run.rows.length, 2, `expected 2 collected configs, got ${run.rows.length}`);
    assert.equal(run.rows[0].tier, 'std');
    // forEach 步在 store 写了两个客户配置
    assert.ok(fs.existsSync(path.join(feDir, 'store', 'C1.json')) && fs.existsSync(path.join(feDir, 'store', 'C2.json')));
  } finally {
    fs.rmSync(feDir, { recursive: true, force: true });
  }
}
console.log('workflow forEach tests passed.');

// --- forEach 并发 + 失败不中止整批（批量导出场景） ---
{
  const bDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-batch-'));
  try {
    // 子命令：companyId='BAD' 时验收失败，其余成功；记录并发峰值
    fs.writeFileSync(path.join(bDir, 'demo.one.json'), JSON.stringify({
      name: 'demo.one', platform: 'demo', description: 'd', riskLevel: 'low',
      parameters: { companyId: { type: 'string', required: true } },
      dataSource: { type: 'inline', rows: [] },
      output: { capability: 'return_json' },
      steps: [{ id: 'x', type: 'manual', manual: 'r' }]
    }));
    // 批量命令：forEach 并发 2 调 demo.one
    fs.writeFileSync(path.join(bDir, 'demo.batch.json'), JSON.stringify({
      name: 'demo.batch', platform: 'demo', description: 'b', riskLevel: 'low',
      parameters: { ids: { type: 'array', required: true }, concurrency: { type: 'number', default: 2 } },
      strategy: 'sequential',
      steps: [{ id: 'batch', forEach: '{{params.ids}}', as: 'cid', concurrency: '{{params.concurrency}}', command: 'demo.one', params: { companyId: '{{cid}}' } }],
      output: { capability: 'return_json', source: '{{steps.batch.rows}}' }
    }));
    const run = await executeCommand('demo.batch', { ids: ['C1', 'C2', 'C3', 'C4'], concurrency: 2 }, { dryRun: false, confirm: true, commandsDir: bDir });
    assert.equal(run.status, 'executed');
    assert.equal(run.rows.length, 4, '4 客户全部跑完（含失败也不中止）');
    // 每行带来源 __item，便于追溯
    assert.deepEqual(run.rows.map((r) => r.__item).sort(), ['C1', 'C2', 'C3', 'C4']);
    assert.ok(run.rows.every((r) => r.__status === 'executed'));
  } finally {
    fs.rmSync(bDir, { recursive: true, force: true });
  }

  // runWithConcurrency 峰值并发不超上限（已在 daemon-core 覆盖，这里复测 utils 直接导出）
  const { runWithConcurrency: rwc } = await import('../src/shared/utils.js');
  let active = 0, peak = 0;
  const tasks = Array.from({ length: 6 }, () => async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return 1; });
  const res = await rwc(tasks, 3);
  assert.equal(res.filter((r) => r.ok).length, 6);
  assert.ok(peak <= 3, `peak ${peak} <= 3`);

  // 失败不中止：一个 task 抛错，其余仍完成
  const mixed = await rwc([async () => 1, async () => { throw new Error('boom'); }, async () => 3], 2);
  assert.deepEqual(mixed.map((r) => r.ok), [true, false, true]);
  assert.equal(mixed[1].error, 'boom');
}
console.log('forEach concurrency + batch tests passed.');

// --- 闭合降级：自动发邮件收件人解析（平台 + added − removed）+ report_check 门控 ---
{
  // config_flags 派生：report_check 门控
  assert.deepEqual(deriveConfigFlags({ report_check: false, send_email: true, sync_portal: false }), { autoSend: true, autoSync: false });
  assert.deepEqual(deriveConfigFlags({ report_check: true, send_email: true, sync_portal: true }), { autoSend: false, autoSync: false });

  // send_email_body：平台 [base1, base2] + added[add] − removed[base2] = [base1, add]
  const ctx = {
    params: { taskId: 'T', companyId: 'C', reportType: 'weekly', emailsAdded: { recipient: ['add@x.com'] }, emailsRemoved: { recipient: ['base2@x.com'] } },
    steps: {
      platRecipient: { list: [{ actual_data_value: { email_address: 'base1@x.com' } }, { actual_data_value: { email_address: 'base2@x.com' } }] },
      platCc: { list: [{ actual_data_value: { email_address: 'cc1@x.com' } }] },
      platBcc: { list: [{ actual_data_value: { email_address: 'bcc1@x.com' } }] },
      subject: { subject: 'S' }, header: { header: 'H' }, push: { pushContent: 'P' }, sign: { sign: 'G' },
      companyName: { companyName: 'Acme' }, attachments: { files: [{ _id: 'f1' }] }
    }
  };
  const body = buildSendEmailBody(null, { context: ctx });
  assert.deepEqual(body.accepter.map((a) => a.value), ['base1@x.com', 'add@x.com']);
  // 回归：cc/bcc 默认空数组时仍取平台配置（修复前会被吞）
  assert.deepEqual(body.ccer.map((a) => a.value), ['cc1@x.com']);
  assert.deepEqual(body.bccer.map((a) => a.value), ['bcc1@x.com']);
  assert.equal(body.email_subject, 'S');
  assert.equal(body.email_content, 'H\nP\nG');
  assert.deepEqual(body.attachments, ['f1']);
  assert.equal(body.attachment_icon.value, 'Weekly Security Report');

  // 显式 recipient 覆盖
  const override = buildSendEmailBody(null, { context: { ...ctx, params: { ...ctx.params, recipient: ['only@x.com'] } } });
  assert.deepEqual(override.accepter.map((a) => a.value), ['only@x.com']);

  // 空收件人报错（不静默发空信）
  assert.throws(() => buildSendEmailBody(null, { context: { params: { companyId: 'C' }, steps: { platRecipient: { list: [] } } } }), /未配置收件人/);
}
console.log('auto send-email recipient resolution tests passed.');

// --- 闭合降级：sync_portal report_version 按 locale 自动拼（复刻 do_sync_portal） ---
{
  // 有小语种 → [locale, en]
  assert.deepEqual(buildSyncPortalBody(null, { context: { params: { taskId: 'T', reportType: 2, locale: 'id' } } }),
    { report_type: 2, task_id: 'T', report_version: ['id', 'en'] });
  // 无小语种 → [en]
  assert.deepEqual(buildSyncPortalBody(null, { context: { params: { taskId: 'T', reportType: 3, locale: '' } } }),
    { report_type: 3, task_id: 'T', report_version: ['en'] });
  // en 当小语种也归一为 [en]
  assert.deepEqual(buildSyncPortalBody(null, { context: { params: { taskId: 'T', reportType: 2, locale: 'en' } } }).report_version, ['en']);
  // 显式 reportVersion 覆盖
  assert.deepEqual(buildSyncPortalBody(null, { context: { params: { taskId: 'T', reportType: 2, locale: 'id', reportVersion: ['de', 'en'] } } }).report_version, ['de', 'en']);
}
console.log('sync_portal report_version tests passed.');

// --- 框架能力：本地登录态导入（session import-cookie / status） ---
{
  const stateFile = path.join(process.cwd(), '.tmp-session-state.json');
  try {
    // 未创建 → not ready
    assert.equal(sessionStatus({ state: stateFile }).ready, false);
    // import-cookie：cookie 串 → storageState
    const r = importCookieState({ host: 'soar.sea.sangfor.com', cookie: 'sid=abc; csrf_token=tok; other=1', out: stateFile });
    assert.equal(r.imported, true);
    assert.equal(r.cookieCount, 3);
    assert.equal(r.hasCsrf, true);
    assert.ok(fs.existsSync(stateFile));
    // 产出能被 readStorageState 接受 + status 就绪
    const st = sessionStatus({ state: stateFile });
    assert.equal(st.ready, true);
    assert.deepEqual(st.hosts, ['soar.sea.sangfor.com']);
    assert.equal(st.hasCsrf, true);
    // --cookie-file：从文件读 cookie（避免超长 token 经命令行粘贴损坏），与 --cookie 等价
    const ckFile = path.join(os.tmpdir(), `pc-ck-${process.pid}.txt`);
    fs.writeFileSync(ckFile, 'sid=fff; csrf_token=ftok; soc-token=eyJ.a-b_c.sig\n');
    const rf = importCookieState({ host: 'soar.sea.sangfor.com', cookieFile: ckFile, out: stateFile });
    assert.equal(rf.cookieCount, 3);
    assert.equal(rf.hasCsrf, true);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).cookies.find((c) => c.name === 'soc-token').value, 'eyJ.a-b_c.sig');
    fs.rmSync(ckFile, { force: true });
    // 缺参数报错
    assert.throws(() => importCookieState({ cookie: 'a=1' }), /需要 --host/);
    assert.throws(() => importCookieState({ host: 'x' }), /需要 --cookie/);
    assert.throws(() => importCookieState({ host: 'x', cookie: 'no-equals' }), /未解析到任何 cookie/);
  } finally {
    fs.rmSync(stateFile, { force: true });
  }
}
console.log('session import tests passed.');

// --- chromeLaunchOptions：系统 Chrome 开关（air-gapped 用） ---
{
  const pa2 = await import('../src/adapter/playwright_adapter.js');
  const savedPath = process.env.PLATFORM_COMMAND_CHROME_PATH;
  const savedCh = process.env.PLATFORM_COMMAND_CHROME_CHANNEL;
  try {
    delete process.env.PLATFORM_COMMAND_CHROME_PATH;
    delete process.env.PLATFORM_COMMAND_CHROME_CHANNEL;
    const baseOpts = pa2.chromeLaunchOptions({ headless: true });            // 不设 env
    assert.equal(baseOpts.headless, true);
    assert.ok(baseOpts.args.includes('--disable-gpu'), '默认禁用 GPU（沙箱无 GPU 会崩）');
    // PLATFORM_COMMAND_CHROME_ARGS 追加自定义参数
    process.env.PLATFORM_COMMAND_CHROME_ARGS = '--single-process --no-zygote';
    const argv = pa2.chromeLaunchOptions({}).args;
    assert.ok(argv.includes('--disable-gpu') && argv.includes('--single-process') && argv.includes('--no-zygote'), 'CHROME_ARGS 追加');
    delete process.env.PLATFORM_COMMAND_CHROME_ARGS;
    process.env.PLATFORM_COMMAND_CHROME_PATH = '/Applications/Google Chrome(MSS研发).app/Contents/MacOS/Google Chrome';
    assert.equal(pa2.chromeLaunchOptions({ headless: true }).executablePath, '/Applications/Google Chrome(MSS研发).app/Contents/MacOS/Google Chrome');
    delete process.env.PLATFORM_COMMAND_CHROME_PATH;
    process.env.PLATFORM_COMMAND_CHROME_CHANNEL = 'chrome';
    assert.equal(pa2.chromeLaunchOptions({ headless: true }).channel, 'chrome');
    // path 优先于 channel
    process.env.PLATFORM_COMMAND_CHROME_PATH = '/x/chrome';
    const both = pa2.chromeLaunchOptions({});
    assert.equal(both.executablePath, '/x/chrome');
    assert.equal(both.channel, undefined);
    // HEADLESS=false → 有头
    delete process.env.PLATFORM_COMMAND_CHROME_PATH;
    delete process.env.PLATFORM_COMMAND_CHROME_CHANNEL;
    const savedHl = process.env.PLATFORM_COMMAND_HEADLESS;
    process.env.PLATFORM_COMMAND_HEADLESS = 'false';
    assert.equal(pa2.chromeLaunchOptions({ headless: true }).headless, false);
    if (savedHl === undefined) delete process.env.PLATFORM_COMMAND_HEADLESS; else process.env.PLATFORM_COMMAND_HEADLESS = savedHl;
  } finally {
    if (savedPath === undefined) delete process.env.PLATFORM_COMMAND_CHROME_PATH; else process.env.PLATFORM_COMMAND_CHROME_PATH = savedPath;
    if (savedCh === undefined) delete process.env.PLATFORM_COMMAND_CHROME_CHANNEL; else process.env.PLATFORM_COMMAND_CHROME_CHANNEL = savedCh;
  }
}
console.log('chromeLaunchOptions tests passed.');

// --- Plan B：cookieSessionFromState（storageState cookie → Cookie 头 + csrf，按 host 过滤） ---
{
  const { cookieSessionFromState } = await import('../src/engine/capabilities.js');
  const cookies = [
    { name: 'csrf_token', value: 'C1', domain: 'soar.sea.sangfor.com' },
    { name: 'soc-token', value: 'S1', domain: '.sangfor.com' },   // 父域命中
    { name: 'other', value: 'X', domain: 'example.com' }          // 异域排除
  ];
  const r = cookieSessionFromState(cookies, 'soar.sea.sangfor.com');
  assert.ok(r.cookieHeader.includes('csrf_token=C1') && r.cookieHeader.includes('soc-token=S1'));
  assert.ok(!r.cookieHeader.includes('other=X'));
  assert.equal(r.csrfToken, 'C1');
  assert.deepEqual(cookieSessionFromState([], 'x.com'), { cookieHeader: '', csrfToken: '' });
}
console.log('cookieSessionFromState tests passed.');

// --- download_report 二进制下载 + 文件名解析 ---
{
  const { parseDownloadFilename } = await import('../src/engine/data_sources.js');
  assert.equal(parseDownloadFilename("attachment;filename*=UTF-8''%E5%91%A8%E6%8A%A5.xlsx"), '周报.xlsx');
  assert.equal(parseDownloadFilename('attachment; filename="report.zip"'), 'report.zip');
  assert.equal(parseDownloadFilename(''), null);

  const dr = verifyCommand('mss.download_report');
  assert.ok(dr.ok, 'download_report verify: ' + JSON.stringify(dr.errors));
  const { command: drCmd } = loadCommand('mss.download_report');
  assert.equal(drCmd.output.capability, 'download');
  assert.ok(getExecutionCapability(drCmd).executable);
}
console.log('download_report tests passed.');

// --- interceptFlow 一套代码回归 + pollUntilReady 快照差集兜底 ---
{
  // export_report 仍是 interceptFlow（一套代码，未被分叉成 store_op）
  const { command: er } = loadCommand('mss.export_report');
  assert.ok(er.interceptFlow && er.interceptFlow.capture, 'export_report 应保留 interceptFlow');
  assert.equal(er.interceptFlow.poll.matchField, 'task_id');
  // export_weekly 仍是完整组合（含 send/sync 全自动）
  const { command: ew } = loadCommand('mss.export_weekly');
  assert.deepEqual(ew.steps.map((s) => s.id), ['cfg', 'tpl', 'loc', 'export', 'send', 'sync']);

  const { pollUntilReady } = await import('../src/engine/intercept_executor.js');
  const list = (rows) => async () => ({ data: { list: rows } });
  // 1) 有 matchValue：按 task_id 精确命中并就绪
  let r = await pollUntilReady(list([{ task_id: 'T1', task_status: 1 }]), { matchValue: 'T1', matchField: 'task_id', readyField: 'task_status', readyValue: 1, intervalMs: 1, timeoutMs: 50 });
  assert.ok(r.ready && r.task.task_id === 'T1' && !r.viaFallback);
  // 2) 无 matchValue + 快照差集：旧行(在快照里)被排除，只认新增且就绪的 T2
  r = await pollUntilReady(list([{ task_id: 'OLD', task_status: 1 }, { task_id: 'T2', task_status: 1 }]), { matchValue: '', excludeIds: ['OLD'], matchField: 'task_id', readyField: 'task_status', readyValue: 1, intervalMs: 1, timeoutMs: 50 });
  assert.ok(r.ready && r.task.task_id === 'T2' && r.viaFallback, '应经差集兜底命中新行 T2');
  // 3) 新增行尚未就绪 → 不误判，超时
  r = await pollUntilReady(list([{ task_id: 'OLD', task_status: 1 }, { task_id: 'T3', task_status: 0 }]), { matchValue: '', excludeIds: ['OLD'], matchField: 'task_id', readyField: 'task_status', readyValue: 1, intervalMs: 1, timeoutMs: 30 });
  assert.ok(!r.ready && r.timedOut, '新行未就绪应继续等而非误判');
}
console.log('interceptFlow one-codebase + pollUntilReady fallback tests passed.');
