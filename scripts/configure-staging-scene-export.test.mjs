import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureStagingSceneExport as configure } from './configure-staging-scene-export.mjs';

const ref = 'refs/heads/develop';
const source = () => ({ containerDefinitions: [
  { name: 'bff', image: 'existing-image', environment: [
    { name: 'FBX_EXPORT_ENABLED', value: 'true' },
    { name: 'CONVERTER_BASE_URL', value: 'http://converter.internal' },
    { name: 'UNRELATED', value: 'retained' },
    { name: 'SCENE_EXPORT_ENABLED', value: 'true' },
  ], secrets: [{ name: 'UNRELATED_TOKEN', valueFrom: 'existing-secret-reference' }] },
  { name: 'body-assets-init', image: 'existing-initializer' },
] });

test('disabling integrated scenes preserves individual FBX export and all other settings', () => {
  const input = source();
  const expected = structuredClone(input);
  expected.containerDefinitions[0].environment[3].value = 'false';
  assert.deepEqual(configure(input, 'false', ref), expected);
  assert.equal(input.containerDefinitions[0].environment[3].value, 'true');
});
test('manual enabling and repeated configuration produce exactly one flag', () => {
  const disabled = configure(source(), 'false', ref);
  const enabled = configure(disabled, 'true', ref);
  assert.deepEqual(enabled, source());
  assert.deepEqual(configure(enabled, 'true', ref), enabled);
});
test('a staging hotfix branch can disable scenes before develop merge', () => {
  assert.equal(configure(source(), 'false', 'refs/heads/fix/staging-toggle')
    .containerDefinitions[0].environment.at(-1).value, 'false');
});
test('main, tag and missing branch references cannot be changed', () => {
  for (const value of ['refs/heads/main', 'refs/tags/test', undefined])
    assert.throws(() => configure(source(), 'false', value), /staging-only/);
});
test('invalid flags, missing or duplicate BFF containers are rejected', () => {
  for (const enabled of ['', '0', 'yes', undefined])
    assert.throws(() => configure(source(), enabled, ref), /true or false/);
  assert.throws(() => configure({ containerDefinitions: [] }, 'false', ref), /one BFF/);
  const duplicate = source();
  duplicate.containerDefinitions.push(structuredClone(duplicate.containerDefinitions[0]));
  assert.throws(() => configure(duplicate, 'false', ref), /one BFF/);
});
test('enabling needs a working FBX configuration; disabling does not', () => {
  const task = source();
  task.containerDefinitions[0].environment = [];
  assert.throws(() => configure(task, 'true', ref), /requires enabled FBX/);
  assert.equal(configure(task, 'false', ref).containerDefinitions[0].environment[0].value, 'false');
});
test('a conflicting secret is not silently removed or overridden', () => {
  const task = source();
  task.containerDefinitions[0].secrets.push({ name: 'SCENE_EXPORT_ENABLED', valueFrom: 'existing' });
  assert.throws(() => configure(task, 'false', ref), /managed as a secret/);
});
