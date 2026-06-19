// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';

export function initCommandScaffold(options = {}) {
  const dir = path.resolve(options.dir || 'commands');
  const platform = options.platform || 'demo';
  const action = options.action || 'new_action';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${platform}.${action}.json`);
  if (fs.existsSync(file) && !options.force) throw new Error(`File already exists: ${file}`);
  const command = {
    name: `${platform}.${action}`,
    platform,
    description: `Describe ${platform}.${action}`,
    riskLevel: 'low',
    parameters: {
      subject: { type: 'string', required: false, description: 'Business subject or tenant.' }
    },
    defaultConfig: { global: {}, subjects: {} },
    execution: { prefer: ['api', 'ui'], api: { method: 'GET', url: 'https://example.com' } },
    successCriteria: ['Dry-run plan can be generated.'],
    failureCases: ['Missing required configuration.']
  };
  fs.writeFileSync(file, JSON.stringify(command, null, 2));
  return { file, command };
}
