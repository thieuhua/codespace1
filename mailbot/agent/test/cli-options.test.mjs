import test from 'node:test';
import assert from 'node:assert/strict';
import { jobOptions, optionArgs, claudeAllowedTools, claudeSettings, SECRET_DIRS, GIT_READ_TOOLS } from '../cli-options.mjs';

test('per-job options map to verified CLI flags, agy model not duplicated', () => {
  const o = jobOptions({ options_json: JSON.stringify({ new: true, model: 'opus', effort: 'max' }) });
  assert.equal(o.new, true);
  assert.deepEqual(optionArgs('claude', o), ['--model', 'opus', '--effort', 'max']);
  assert.deepEqual(optionArgs('codex', o), ['-m', 'opus', '-c', 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(optionArgs('agy', o, 'fallback'), ['--model', 'opus', '--effort', 'max']);
  assert.deepEqual(optionArgs('agy', {}, 'fallback'), ['--model', 'fallback']);
});
test('malformed job options cannot become CLI arguments', () => {
  for (const raw of ['bad json', 'null', '{"model":"--evil", "effort":"anything"}']) {
    assert.deepEqual(optionArgs('claude', jobOptions({ options_json: raw })), []);
  }
});
test('default shell allowlist only read-only git, test runners explicitly configured per project', () => {
  assert.deepEqual(claudeAllowedTools(), GIT_READ_TOOLS);
  assert.deepEqual(claudeAllowedTools({ claude_allowed_tools: ['Bash(npm test:*)'] }), [...GIT_READ_TOOLS, 'Bash(npm test:*)']);
  const deny = JSON.parse(claudeSettings('C:\\Users\\test')).permissions.deny;
  for (const s of ['*--no-index*', '*--output*', '*--ext-diff*', '*-c *', '*core.*']) assert.ok(deny.includes(`Bash(${s})`));
  for (const s of SECRET_DIRS) {
    assert.ok(deny.includes(`Bash(*${s}*)`));
    assert.ok(deny.some((r) => r.startsWith('Read(') && r.includes(s)));
    assert.ok(deny.some((r) => r.startsWith('Edit(') && r.includes(s)));
  }
});
