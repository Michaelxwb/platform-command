import { renderValue } from './workflow.js';
import { exportRows, normalizeCapability } from './exporters.js';
import { readDataSource } from './data_sources.js';

export function hasAutoCapability(command) {
  return Boolean(command?.dataSource && command?.output?.capability);
}

export async function executeAutoCapability(command, params, options = {}) {
  if (!hasAutoCapability(command)) return null;
  const context = { params, steps: {}, warnings: [] };
  const dataSource = renderValue(command.dataSource, context);
  const data = await readDataSource(dataSource, params, { commandDir: options.commandDir });
  context.steps[dataSource.id || 'data'] = { rows: data.rows, title: data.title };

  const output = renderValue(command.output, context);
  const capability = normalizeCapability(output.capability || output.format || output.path);
  if (!capability) throw new Error(`Unsupported output capability: ${output.capability || output.format || output.path}`);
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
