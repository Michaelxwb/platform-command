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

const workflowVerify = verifyCommand('demo.workflow_example');
assert.equal(workflowVerify.ok, true, workflowVerify.errors.join('\n'));

const workflowDry = execFileSync('node', ['src/cli.js', 'execute', '--command', 'demo.workflow_example', '--dry-run', 'keyword=abc', 'limit=5'], { encoding: 'utf8' });
const workflowParsed = JSON.parse(workflowDry);
assert.equal(workflowParsed.status, 'dry_run');
assert.equal(workflowParsed.plan.kind, 'workflow');
assert.equal(workflowParsed.plan.steps.length, 4);
assert.equal(workflowParsed.plan.steps[0].request.query.q, 'abc');
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

console.log('All tests passed.');
