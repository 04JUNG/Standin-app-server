import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureStagingRefine as configure } from './configure-staging-refine.mjs';

const task = (name = 'bff') => ({ family: 'StandinStagingAppTask', cpu: '1024', containerDefinitions: [
  { name, image: 'fixed-image', environment: [{ name: 'REFINE_RELEASE_ENABLED', value: '1' }, { name: 'OTHER', value: 'unchanged' }],
    secrets: [{ name: 'INTERACTIVE_STATE_TOKEN', valueFrom: 'unchanged-reference' }] },
  { name: 'body-assets-init', image: 'fixed-initializer' },
] });

for (const name of ['bff', 'analysis-worker']) {
  test(`${name}: disable RC4 and keep legacy refine with all other wiring unchanged`, () => {
    const input = task(name), before = structuredClone(input), expected = structuredClone(input);
    expected.containerDefinitions[0].environment[0].value = '0';
    expected.containerDefinitions[0].environment.push({ name: 'REFINE_FEATURE_ENABLED', value: 'true' });
    const actual = configure(input, name);
    assert.deepEqual(actual, expected);
    assert.deepEqual(input, before);
    assert.deepEqual(configure(actual, name), actual);
  });
}
test('reject production, other containers, ambiguous env and secret collisions', () => {
  const prod = task(); prod.family = 'StandinAppBffTask';
  assert.throws(() => configure(prod, 'bff'), /staging-only/);
  assert.throws(() => configure(task(), 'inference'), /Unsupported/);
  const duplicate = task(); duplicate.containerDefinitions[0].environment.push({ name: 'OTHER', value: 'x' });
  assert.throws(() => configure(duplicate, 'bff'), /Duplicate/);
  const secret = task(); secret.containerDefinitions[0].secrets.push({ name: 'REFINE_RELEASE_ENABLED', valueFrom: 'x' });
  assert.throws(() => configure(secret, 'bff'), /conflicts/);
  assert.throws(() => configure({ ...task(), containerDefinitions: [] }, 'bff'), /one target/);
  const two = task(); two.containerDefinitions.push(structuredClone(two.containerDefinitions[0]));
  assert.throws(() => configure(two, 'bff'), /one target/);
});
test('reject invalid flags and permit an intentional future rollout or emergency disable', () => {
  for (const settings of [{ REFINE_RELEASE_ENABLED: 'true' }, { REFINE_FEATURE_ENABLED: '1' }, { UNKNOWN: '0' }])
    assert.throws(() => configure(task(), 'bff', settings), /Invalid/);
  const actual = configure(task(), 'bff', { REFINE_RELEASE_ENABLED: '1', REFINE_FEATURE_ENABLED: 'false' });
  const env = Object.fromEntries(actual.containerDefinitions[0].environment.map(e => [e.name, e.value]));
  assert.equal(env.REFINE_RELEASE_ENABLED, '1'); assert.equal(env.REFINE_FEATURE_ENABLED, 'false');
});
