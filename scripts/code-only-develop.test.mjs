import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const deploy = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const condition = deploy.match(/^    if: >-\n((?:      .+\n)+)/m)[1].trim();
const enabled = new Function('vars', 'github', 'contains', `return ${condition}`);
const contains = (text, part) => String(text ?? '').toLowerCase().includes(part.toLowerCase());

for (const [auto, event, message, expected] of [
  ['true', 'push', 'feat: normal develop change', true],
  ['true', 'push', 'feat: body defaults [skip deploy]', false],
  ['true', 'push', 'feat: body defaults [SKIP DEPLOY]', false],
  ['false', 'push', 'feat: normal develop change', false],
  ['false', 'push', 'feat: body defaults [skip deploy]', false],
  ['true', 'workflow_dispatch', '', true],
  ['false', 'workflow_dispatch', '', false],
]) test(`deploy guard: ${auto}/${event}/${message}`, () => {
  assert.equal(enabled({AUTO_DEPLOY_ENABLED:auto}, {event_name:event, event:{head_commit:{message}}}, contains), expected);
});

test('code-only merge marker leaves develop CI enabled', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /push:\n    branches: \[develop\]/);
  assert.ok(!ci.includes('[skip deploy]'));
});
