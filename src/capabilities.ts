// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { renderValue } from './workflow.js';
import { exportRows, normalizeCapability } from './exporters.js';
import { readDataSource } from './data_sources.js';

export function hasAutoCapability(command) {
  return Boolean(command?.dataSource && command?.output?.capability);
}

export const JSON_CAPABILITIES = new Set(['return_json', 'save_json']);

export async function executeAutoCapability(command, params, options = {}) {
  if (!hasAutoCapability(command)) return null;
  const context = { params, steps: {}, warnings: [] };
  const dataSource = renderValue(command.dataSource, context);
  const data = await readDataSource(dataSource, params, { commandDir: options.commandDir });
  context.steps[dataSource.id || 'data'] = { rows: data.rows, title: data.title };

  const output = renderValue(command.output, context);
  const requestedCapability = output.capability || output.format || output.path;
  if (JSON_CAPABILITIES.has(requestedCapability)) {
    const payload = {
      title: output.title || data.title || command.description,
      rows: data.rows,
      meta: data.meta || {}
    };
    let outputPath = null;
    if (requestedCapability === 'save_json') {
      if (!output.path) throw new Error('output.path is required for save_json');
      outputPath = path.resolve(output.path);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
    }
    return {
      status: 'executed',
      command: command.name,
      capability: requestedCapability,
      outputPath,
      rows: payload.rows,
      meta: payload.meta,
      dataSource: {
        type: dataSource.type,
        handler: dataSource.handler || dataSource.name || null,
        meta: data.meta || {}
      }
    };
  }

  const capability = normalizeCapability(requestedCapability);
  if (!capability) throw new Error(`Unsupported output capability: ${requestedCapability}`);
  const result = exportRows({
    capability,
    outputPath: output.path,
    columns: output.columns,
    rows: data.rows,
    title: output.title || data.title || command.description
  });
  return {
    status: 'executed',
    command: command.name,
    capability: result.capability,
    outputPath: result.outputPath,
    rows: result.rows,
    columns: result.columns,
    dataSource: {
      type: dataSource.type,
      handler: dataSource.handler || dataSource.name || null,
      meta: data.meta || {}
    }
  };
}
