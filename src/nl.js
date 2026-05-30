import { executeCommand } from './execute.js';

const REPO_RE = /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/;
const STATE_RE = /(?:状态|state)\s*(?:是|为|=|:|：)?\s*(open|closed|all|打开|开启|关闭|全部)/i;
const BRANCH_RE = /(?:分支|branch)\s*(?:是|为|=|:|：)?\s*([A-Za-z0-9_.\/-]+)/i;
const LIMIT_RE = /(?:limit|限制|最多|前)\s*(?:=|:|：)?\s*(\d+)/i;

const STATE_MAP = new Map([
  ['open', 'open'], ['opened', 'open'], ['打开', 'open'], ['开启', 'open'],
  ['closed', 'closed'], ['关闭', 'closed'],
  ['all', 'all'], ['全部', 'all']
]);

export function parseNaturalLanguage(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('自然语言指令不能为空');
  const lower = text.toLowerCase();
  const repo = extractRepo(text);

  if (/(issue|issues|工单|问题)/i.test(text) && /(查看|列出|读取|查询|看)/.test(text)) {
    const state = normalizeState(matchGroup(text, STATE_RE) || (lower.includes('open') ? 'open' : lower.includes('closed') ? 'closed' : 'all'));
    return withConfidence({ command: 'github.list_issues', params: { ...repo, state }, intent: '查看 GitHub Issues' }, repo ? 0.96 : 0.78);
  }

  if (/(commit|commits|提交|提交记录|提交历史)/i.test(text) && /(查看|列出|读取|查询|看|最近)/.test(text)) {
    const branch = matchGroup(text, BRANCH_RE) || inferBranch(text) || 'master';
    return withConfidence({ command: 'github.list_commits', params: { ...repo, branch }, intent: '查看 GitHub 提交记录' }, repo ? 0.95 : 0.76);
  }

  if (/(搜索|查找|search)/i.test(text) && /(github|仓库|repository|repositories|repo)/i.test(text)) {
    const query = extractSearchQuery(text);
    const limit = Number(matchGroup(text, LIMIT_RE) || 5);
    return withConfidence({ command: 'github.search_repositories', params: { query, limit }, intent: '搜索 GitHub 仓库' }, query ? 0.92 : 0.7);
  }

  if (/(巡检|查看|读取|检查|仓库信息|基本信息)/.test(text) && /(github|仓库|repo|repository)/i.test(text)) {
    const branch = matchGroup(text, BRANCH_RE) || inferBranch(text) || 'master';
    return withConfidence({ command: 'github.inspect_repository', params: { ...repo, branch }, intent: '巡检 GitHub 仓库' }, repo ? 0.94 : 0.72);
  }

  throw new Error(`无法精准识别自然语言指令：${text}`);
}

export async function runNaturalLanguage(input, options = {}) {
  const parsed = parseNaturalLanguage(input);
  if (parsed.confidence < 0.85) {
    throw new Error(`识别置信度不足(${parsed.confidence})，请补充 owner/repo 或明确动作`);
  }
  const result = await executeCommand(parsed.command, parsed.params, { dryRun: options.dryRun !== false, confirm: !!options.confirm });
  return { parsed, result };
}

export function formatHumanReadable({ parsed, result }) {
  const params = result.params || parsed.params;
  const lines = [];
  lines.push(`# 已识别并调用封装 Workflow`);
  lines.push('');
  lines.push(`- 识别意图：${parsed.intent}`);
  lines.push(`- 内部指令：${parsed.command}`);
  lines.push(`- 识别置信度：${Math.round(parsed.confidence * 100)}%`);
  lines.push(`- 执行状态：${result.status}`);
  lines.push(`- 风险等级：${result.riskLevel}`);
  lines.push(`- Workflow 类型：${result.plan?.kind || 'unknown'}`);
  lines.push(`- Workflow 步骤：${(result.plan?.steps || []).map((s) => `${s.id}(${s.type})`).join(' -> ') || '无'}`);
  lines.push('');
  lines.push('## 参数');
  for (const [key, value] of Object.entries(params)) lines.push(`- ${key}: ${value}`);
  lines.push('');
  lines.push('## 结果说明');
  lines.push(result.status === 'dry_run'
    ? '已生成 dry-run 计划，用于确认会调用哪个封装 workflow、带入哪些参数、按什么步骤执行；未执行真实写操作。'
    : '已执行真实流程。');
  lines.push('');
  lines.push('## 下一步');
  lines.push('- 如需真实读取 API 或打开页面验证，可在安全确认后执行对应 workflow。');
  return lines.join('\n');
}

function extractRepo(text) {
  const match = text.match(REPO_RE);
  return match ? { owner: match[1], repo: match[2] } : {};
}

function matchGroup(text, re) {
  const m = text.match(re);
  return m ? m[1] : '';
}

function normalizeState(value) {
  return STATE_MAP.get(String(value || '').toLowerCase()) || STATE_MAP.get(value) || 'all';
}

function inferBranch(text) {
  const m = text.match(/\b(master|main|dev|develop|release|test)\b/i);
  return m ? m[1] : '';
}

function extractSearchQuery(text) {
  const quoted = text.match(/[“\"]([^”\"]+)[”\"]/);
  if (quoted) return quoted[1].trim();
  const after = text.match(/(?:搜索|查找|search)\s*(?:GitHub|github)?\s*(?:仓库|repository|repositories|repo)?\s*(?:关键词|query)?\s*(?:是|为|=|:|：)?\s*(.+)$/i);
  if (!after) return '';
  return after[1].replace(/，?\s*(?:最多|limit|限制)\s*[:：=]?\s*\d+.*$/i, '').trim();
}

function withConfidence(obj, confidence) {
  return { ...obj, confidence };
}
