import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyStagingAnatomy } from './verify-staging-anatomy.mjs';
const environment = values => Object.entries(values).map(([name, value]) => ({ name, value }));
const fixture = () => ({ family: 'StandinStagingApp-BffTask', containerDefinitions: [
  { name: 'bff', dependsOn: [{ containerName: 'body-assets-init', condition: 'SUCCESS' }], environment: environment({ CONVERTER_CHARACTER_ID: 'male-base-v0-8-0', BODY_CATALOG_PATH: '/app/body-staging/body-models.json' }) },
  { name: 'body-assets-init', environment: environment({ BODY_ASSETS_ROLE: 'bff', BODY_ASSETS_ROOT: '/app/body-staging', BODY_ASSETS_MANIFEST_KEY: 'body-models/releases/anatomy-20261111-5ab242a0112a-bff/manifest.json', BODY_ASSETS_MANIFEST_SHA256: '5ab242a0112a1914bddf5a68f821ec4180db90605e7a5aeeeb69a0dcd680e898' }) },
] });
test('accept approved task without mutation; reject old default, missing init and production', () => {
  const task = fixture(), before = structuredClone(task);
  assert.equal(verifyStagingAnatomy(task), task); assert.deepEqual(task, before);
  for (const change of [t => t.family = 'StandinApp-BffTask', t => t.containerDefinitions.pop(), t => t.containerDefinitions[0].environment[0].value = 'male-base-v0-7-2', t => t.containerDefinitions[1].environment[3].value = '0'.repeat(64)]) {
    const invalid = fixture(); change(invalid); assert.throws(() => verifyStagingAnatomy(invalid));
  }
});
