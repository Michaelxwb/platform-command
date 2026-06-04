// @ts-nocheck
import fs from 'node:fs';

const LEGACY_TEXT_TYPE = 'manual_check';

export const ACCEPTANCE_TYPES = new Set(['api_response', 'data_contains', 'file_exists', 'ui_visible', 'manual_check']);

export function normalizeAcceptanceCriteria(command = {}) {
  const raw = command.acceptance?.criteria ?? command.successCriteria ?? command.checks ?? [];
  const criteria = Array.isArray(raw) ? raw : [raw];
  return criteria.filter((item) => item !== undefined && item !== null && item !== '').map((item, index) => normalizeCriterion(item, index));
}

export function normalizeCriterion(item, index = 0) {
  if (typeof item === 'string') {
    return { id: `criterion_${index + 1}`, type: LEGACY_TEXT_TYPE, description: item, evidenceRequired: true };
  }
  if (!item || typeof item !== 'object') throw new Error(`acceptance.criteria[${index}] must be a string or object`);
  const type = item.type || LEGACY_TEXT_TYPE;
  return {
    id: item.id || `criterion_${index + 1}`,
    type,
    description: item.description || item.expectation || item.check || '',
    evidenceRequired: item.evidenceRequired !== false,
    source: item.source || null,
    expect: item.expect ?? item.expected ?? null,
    evidence: item.evidence || null,
    optional: Boolean(item.optional)
  };
}

export function buildAcceptanceContract(command = {}) {
  const criteria = normalizeAcceptanceCriteria(command);
  return {
    version: command.acceptance?.version || '1.0',
    evidenceRequired: command.acceptance?.evidenceRequired !== false,
    criteria,
    safety: command.acceptance?.safety || command.safety || null,
    failureCases: command.acceptance?.failureCases || command.failureCases || []
  };
}

export function validateAcceptance(command = {}, errors = [], prefix = 'acceptance') {
  if (command.acceptance !== undefined && (!command.acceptance || typeof command.acceptance !== 'object' || Array.isArray(command.acceptance))) {
    errors.push('acceptance must be an object');
    return errors;
  }
  const raw = command.acceptance?.criteria ?? command.successCriteria;
  if (raw === undefined) return errors;
  if (!Array.isArray(raw)) {
    errors.push(`${command.acceptance?.criteria ? prefix + '.criteria' : 'successCriteria'} must be an array`);
    return errors;
  }
  raw.forEach((item, index) => {
    if (typeof item === 'string') return;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${command.acceptance?.criteria ? prefix + '.criteria' : 'successCriteria'}[${index}] must be a string or object`);
      return;
    }
    if (item.type !== undefined && !ACCEPTANCE_TYPES.has(item.type)) errors.push(`${prefix}.criteria[${index}].type must be one of ${Array.from(ACCEPTANCE_TYPES).join(', ')}`);
    if (item.evidence !== undefined && typeof item.evidence !== 'object') errors.push(`${prefix}.criteria[${index}].evidence must be an object`);
  });
  return errors;
}


export function initializeAcceptanceEvidence(command = {}, initialEvidence = {}) {
  const contract = buildAcceptanceContract(command);
  const byCriterion = {};
  for (const criterion of contract.criteria) {
    byCriterion[criterion.id] = {
      status: criterion.optional ? 'optional' : 'pending',
      type: criterion.type,
      evidenceRequired: criterion.evidenceRequired !== false,
      evidence: initialEvidence[criterion.id] || criterion.evidence || null,
      description: criterion.description || ''
    };
  }
  return {
    status: contract.criteria.length ? 'pending' : 'not_required',
    required: contract.evidenceRequired !== false,
    criteria: byCriterion
  };
}

// Enforce the acceptance contract after a real execution: machine-checkable
// criteria are auto-verified from the execution result; the rest must be
// backed by agent-supplied evidence. A required criterion without a pass leaves
// the overall status at failed/incomplete instead of silently succeeding.
export function evaluateAcceptance(command = {}, { evidence = {}, result = {} } = {}) {
  const contract = buildAcceptanceContract(command);
  const state = initializeAcceptanceEvidence(command, evidence);
  for (const criterion of contract.criteria) {
    const slot = state.criteria[criterion.id];
    const auto = autoEvaluate(criterion, result);
    if (auto) {
      slot.status = auto.passed ? 'passed' : 'failed';
      slot.evidence = { ...(slot.evidence || {}), ...auto.evidence, auto: true };
    } else if (slot.evidence) {
      slot.status = 'passed';
    } else if (criterion.optional) {
      slot.status = 'optional';
    } else {
      slot.status = slot.evidenceRequired ? 'pending' : 'passed';
    }
  }
  const required = contract.criteria.filter((criterion) => !criterion.optional);
  const statuses = required.map((criterion) => state.criteria[criterion.id].status);
  if (!required.length) state.status = 'not_required';
  else if (statuses.includes('failed')) state.status = 'failed';
  else if (statuses.includes('pending')) state.status = 'incomplete';
  else state.status = 'passed';
  state.required = contract.evidenceRequired !== false;
  return state;
}

function autoEvaluate(criterion, result) {
  if (criterion.type === 'file_exists') {
    const target = criterion.expect?.path || result.outputPath;
    if (!target) return null;
    const exists = fs.existsSync(target);
    return { passed: exists, evidence: { path: target, exists } };
  }
  if (criterion.type === 'data_contains') {
    const rows = result.rows;
    if (rows === undefined || rows === null) return null;
    const count = Array.isArray(rows) ? rows.length : Number(rows) || 0;
    const minCount = Number(criterion.expect?.minCount ?? 1);
    const requiredColumns = Array.isArray(criterion.expect?.requiredColumns) ? criterion.expect.requiredColumns : [];
    const presentColumns = Array.isArray(rows)
      ? Array.from(new Set(rows.flatMap((row) => row && typeof row === 'object' ? Object.keys(row) : []))).sort()
      : [];
    const missingColumns = requiredColumns.filter((column) => !presentColumns.includes(column));
    return {
      passed: count >= minCount && missingColumns.length === 0,
      evidence: { count, minCount, ...(requiredColumns.length ? { requiredColumns, presentColumns, missingColumns } : {}) }
    };
  }
  // api_response / ui_visible / manual_check require agent-supplied evidence.
  return null;
}
