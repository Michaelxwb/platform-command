// @ts-nocheck
import { mergeParams } from './command_store.js';

export function resolveCommandParams(command, providedParams = {}) {
  const provided = normalizeObject(providedParams);
  const subjectParam = command.defaultConfig?.subjectParam || command.defaults?.subjectParam || 'subject';
  const subject = provided[subjectParam] ?? command.defaultConfig?.defaultSubject ?? command.defaults?.defaultSubject;

  const layers = [];
  addLayer(layers, 'command.defaults', command.defaults?.params || command.defaults);
  addLayer(layers, 'command.defaultConfig.global', command.defaultConfig?.global);

  if (subject !== undefined && subject !== null && subject !== '') {
    const subjectKey = String(subject);
    const subjectConfig = command.defaultConfig?.subjects?.[subjectKey];
    if (subjectConfig) addLayer(layers, `command.defaultConfig.subjects.${subjectKey}`, subjectConfig);
  }

  addLayer(layers, 'provided', provided);

  const raw = {};
  const sources = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.params)) {
      raw[key] = value;
      sources[key] = layer.name;
    }
  }

  const params = mergeParams(command, raw);
  return {
    params,
    meta: {
      subjectParam,
      subject: subject === undefined ? null : subject,
      layers: layers.map((layer) => layer.name),
      sources
    }
  };
}

function addLayer(layers, name, params) {
  const normalized = normalizeObject(params);
  if (Object.keys(normalized).length) layers.push({ name, params: normalized });
}

function normalizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}
