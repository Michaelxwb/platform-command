import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mergeParams } from '../src/command_store.js';
import { verifyCommand } from '../src/verify.js';

const demo = verifyCommand('demo.search_example');
assert.equal(demo.ok, true, demo.errors.join('\n'));

const merged = mergeParams(demo.command, { keyword: 'abc' });
assert.equal(merged.keyword, 'abc');
assert.equal(merged.page, 1);

const help = execFileSync('node', ['src/cli.js', '--help'], { encoding: 'utf8' });
assert.match(help, /platform-command/);

const dry = execFileSync('node', ['src/cli.js', 'execute', '--command', 'demo.search_example', '--dry-run', 'keyword=abc'], { encoding: 'utf8' });
const parsed = JSON.parse(dry);
assert.equal(parsed.status, 'dry_run');
assert.equal(parsed.params.keyword, 'abc');
assert.equal(parsed.params.page, 1);

console.log('All tests passed.');
