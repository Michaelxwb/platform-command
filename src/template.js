import { redactSensitive } from './utils.js';

export function findTemplateExpressions(value, found = []) {
  if (typeof value === 'string') {
    const re = /{{\s*([^}]+?)\s*}}/g;
    let match;
    while ((match = re.exec(value))) found.push(match[1].trim());
  } else if (Array.isArray(value)) value.forEach((item) => findTemplateExpressions(item, found));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => findTemplateExpressions(item, found));
  return found;
}

export function renderValue(value, context) {
  if (typeof value === 'string') return renderString(value, context);
  if (Array.isArray(value)) return value.map((item) => renderValue(item, context));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = renderValue(item, context);
    return result;
  }
  return value;
}

export function renderString(value, context) {
  const single = value.match(/^{{\s*([^}]+?)\s*}}$/);
  if (single) return resolvePath(single[1].trim(), context, value);
  return value.replace(/{{\s*([^}]+?)\s*}}/g, (_, expr) => {
    const resolved = resolvePath(expr.trim(), context, '');
    if (resolved === undefined || resolved === null) return '';
    if (typeof resolved === 'object') return JSON.stringify(redactSensitive(resolved));
    return String(resolved);
  });
}

export function resolvePath(path, context, fallback) {
  if (path.startsWith('params.') && Object.prototype.hasOwnProperty.call(context.params || {}, path.slice(7))) return context.params[path.slice(7)];
  if (context.params && Object.prototype.hasOwnProperty.call(context.params, path)) return context.params[path];
  const parts = path.split('.');
  let current = context;
  for (const part of parts) {
    if (current && Object.prototype.hasOwnProperty.call(current, part)) current = current[part];
    else {
      if (context.warnings) context.warnings.push({ code: 'UNRESOLVED_TEMPLATE', expression: path });
      return fallback;
    }
  }
  return current;
}
