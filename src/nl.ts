// @ts-nocheck
import { listCommands, loadCommand } from './command_store.js';
import { executeCommand } from './execute.js';


export function parseNaturalLanguage(input, options = {}) {
  const text = String(input || '').trim();
  if (!text) throw new Error('自然语言指令不能为空');

  const candidates = [];
  const commandItems = options.commands || listCommands({ commandsDir: options.commandsDir });
  for (const item of commandItems) {
    const commandName = typeof item === 'string' ? item : item.name;
    const command = typeof item === 'string'
      ? loadCommand(commandName, { commandsDir: options.commandsDir }).command
      : item;
    if (!command.naturalLanguage) continue;
    const matched = matchCommand(text, command);
    if (!matched.ok) continue;
    const params = extractParams(text, command);
    const routeScore = routeBonus(command, text);
    const confidence = Math.max(0.01, Math.min(0.99, Number((matched.confidence + routeScore / 100).toFixed(2))));
    candidates.push({
      command: command.name,
      params,
      intent: command.naturalLanguage.intent || command.description,
      confidence,
      matchedBy: 'command.naturalLanguage'
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  if (candidates[0]) return candidates[0];
  throw new Error('无法识别自然语言指令，请改用 execute --command，或在 command JSON 中补充 naturalLanguage 配置');
}

export async function runNaturalLanguage(input, options = {}) {
  const parsed = parseNaturalLanguage(input, options);
  const result = await executeCommand(parsed.command, parsed.params, {
    dryRun: options.dryRun !== false,
    confirm: options.confirm,
    commandsDir: options.commandsDir
  });
  return { parsed, result };
}

export function formatHumanReadable(nlResult) {
  const { parsed, result } = nlResult;
  const params = parsed.params || {};
  const lines = [];
  lines.push(`# platform-command 自然语言解析结果`);
  lines.push('');
  lines.push(`- 识别意图: ${parsed.intent}`);
  lines.push(`- 匹配 command: ${parsed.command}`);
  lines.push(`- 置信度: ${parsed.confidence}`);
  lines.push('');
  lines.push('## 参数');
  for (const [key, value] of Object.entries(params)) lines.push(`- ${key}: ${value}`);
  lines.push('');
  lines.push('## 结果说明');
  if (result.status === 'dry_run') {
    lines.push('已识别并调用封装 Workflow；已生成 dry-run 计划，用于确认会调用哪个封装 workflow、带入哪些参数、按什么步骤执行；未执行真实写操作。');
    const steps = result.plan?.steps || [];
    if (steps.length) lines.push(`- Workflow 步骤: ${steps.map((step) => `${step.id}(${step.type})`).join(' -> ')}`);
  } else {
    lines.push('已执行真实流程。');
  }
  lines.push('');
  lines.push('## 下一步');
  lines.push('- 如需真实读取 API 或打开页面验证，可在安全确认后执行对应 workflow。');
  return lines.join('\n');
}

function matchCommand(text, command) {
  const nl = command.naturalLanguage || {};
  const match = nl.match || {};
  let score = 0;
  const maxScore = 6;
  if (containsAll(text, match.all || [])) score += 2;
  else if ((match.all || []).length) return { ok: false, confidence: 0 };
  if (containsAny(text, match.any || [])) score += 2;
  else if ((match.any || []).length) return { ok: false, confidence: 0 };
  if (containsAny(text, match.verbs || [])) score += 1.5;
  else if ((match.verbs || []).length) return { ok: false, confidence: 0 };
  if (Array.isArray(nl.aliases) && containsAny(text, nl.aliases)) score += 0.5;
  if (!score) return { ok: false, confidence: 0 };
  return { ok: true, confidence: Math.min(0.99, Number((0.55 + (score / maxScore) * 0.44).toFixed(2))) };
}

function extractParams(text, command) {
  const params = {};
  const specs = command.naturalLanguage?.extract || {};
  for (const [name, rule] of Object.entries(specs)) {
    const value = extractValue(text, rule);
    if (value !== undefined && value !== '') params[name] = value;
  }
  return params;
}

function extractValue(text, rule = {}) {
  if (rule.type === 'enum') {
    const raw = regexGroup(text, rule.pattern, rule.group || 1);
    if (!raw) return undefined;
    return rule.map?.[raw] || rule.map?.[raw.toLowerCase()] || raw;
  }
  if (rule.type === 'regex') {
    return regexGroup(text, rule.pattern, rule.group || 1)
      || regexGroup(text, rule.fallbackPattern, 1)
      || undefined;
  }
  if (rule.type === 'number') {
    const raw = regexGroup(text, rule.pattern, rule.group || 1);
    return raw ? Number(raw) : undefined;
  }
  if (rule.type === 'url') {
    const raw = regexGroup(text, rule.pattern, 0);
    return raw || undefined;
  }
  if (rule.type === 'after') {
    const quoted = text.match(/[“\"]([^”\"]+)[”\"]/);
    let raw = quoted?.[1]?.trim() || regexGroup(text, rule.pattern, rule.group || 1);
    if (!raw) {
      const marker = rule.marker || rule.after;
      const markers = Array.isArray(marker) ? marker : [marker];
      const found = markers
        .filter(Boolean)
        .map((item) => ({ item, index: text.indexOf(item) }))
        .filter((item) => item.index >= 0)
        .sort((a, b) => a.index - b.index)[0];
      if (found) {
        raw = text.slice(found.index + found.item.length);
        raw = applyAfterStop(raw, rule.stop);
      }
    }
    raw = cleanupText(raw || '', rule.cleanup);
    return raw || undefined;
  }
  if (rule.type === 'booleanKeyword') {
    if (containsAny(text, rule.false || [])) return false;
    if (containsAny(text, rule.true || [])) return true;
    return undefined;
  }
  return undefined;
}


function applyAfterStop(value, stop) {
  let raw = String(value || '');
  const stops = Array.isArray(stop) ? stop : [stop];
  const stopIndex = stops
    .filter(Boolean)
    .map((item) => {
      if (item instanceof RegExp) return raw.search(item);
      const text = String(item);
      if (text.startsWith('/') && text.lastIndexOf('/') > 0) {
        const last = text.lastIndexOf('/');
        try { return raw.search(new RegExp(text.slice(1, last), text.slice(last + 1) || 'i')); } catch { return -1; }
      }
      return raw.indexOf(text);
    })
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];
  if (stopIndex !== undefined) raw = raw.slice(0, stopIndex);
  return raw;
}

function regexGroup(text, pattern, group = 1) {
  if (!pattern) return '';
  const re = new RegExp(pattern, 'i');
  const m = text.match(re);
  return m ? String(m[group] || '').trim() : '';
}

function cleanupText(value, cleanup) {
  let result = String(value || '').trim();
  if (cleanup === 'limitClause') result = result.replace(/，?\s*(?:最多|limit|限制)\s*[:：=]?\s*\d+.*$/i, '').trim();
  if (cleanup === 'autoPublishClause') result = result.replace(/[，,。；;]?\s*(?:并)?(?:自动发布|直接发布|发出去|点击发布|不要发布|不发布|只填草稿|草稿|autoPublish\s*=\s*(?:true|false)).*$/i, '').trim();
  if (cleanup === 'trailingClauses') result = result.replace(/[，,。；;]\s*(?:最多|limit|限制|并|然后|同时).*/i, '').trim();
  if (cleanup === 'sangforProjectName') {
    result = result
      .replace(/^(?:包含|是|为|=|:|：)\s*/i, '')
      .replace(/[，,。；;]?\s*(?:前|最多|limit|数量|输出|保存|导出到|output)\s*.*$/i, '')
      .replace(/^(?:列表|查询|导出|获取|过滤|搜索)\s*/i, '')
      .trim();
  }
  return result;
}


function routeBonus(command, text) {
  const name = String(command.name || '');
  const t = String(text || '');
  const wantsExportComments = /(导出|获取|抓取|保存|输出|下载).{0,12}(评论|评论数据)|评论.{0,12}(导出|数据|excel|xlsx|保存|输出)/i.test(t);
  const wantsPostComment = /(发布|发表|发送|评论一下|留言|回复).{0,8}(评论|弹幕|留言)?/i.test(t);
  if (name.includes('export_comments')) return wantsExportComments ? 80 : (wantsPostComment ? -60 : 0);
  if (name.includes('post_comment')) return wantsPostComment ? 80 : (wantsExportComments ? -60 : 0);
  return 0;
}

function containsAll(text, needles) {

  return needles.every((needle) => contains(text, needle));
}

function containsAny(text, needles) {
  return needles.some((needle) => contains(text, needle));
}

function contains(text, needle) {
  return String(text).toLowerCase().includes(String(needle).toLowerCase());
}
