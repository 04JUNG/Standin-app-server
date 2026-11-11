import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyStagingAnatomy } from './verify-staging-anatomy.mjs';
import { prepareStagingAnatomy } from './prepare-staging-anatomy.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const environment = values => Object.entries(values).map(([name, value]) => ({ name, value }));
const fixture = () => prepareStagingAnatomy({ family: 'StandinStagingApp-BffTask', containerDefinitions: [
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
test('every deploy restores the pinned release without modifying unrelated settings', () => {
  const old = fixture(); old.containerDefinitions[1].environment[3].value = '0'.repeat(64);
  old.containerDefinitions[0].image = 'reviewed-bff-image';
  const before = structuredClone(old), prepared = prepareStagingAnatomy(old);
  assert.deepEqual(old, before); assert.equal(prepared.containerDefinitions[0].image, old.containerDefinitions[0].image);
  assert.doesNotThrow(() => verifyStagingAnatomy(prepared));
  const prod = structuredClone(old); prod.family = 'StandinApp-BffTask';
  assert.throws(() => prepareStagingAnatomy(prod));
});
test('analysis worker receives the identical catalog when it captures new job policy', () => {
  const task = fixture(); task.containerDefinitions[0].name = 'analysis-worker';
  const worker = prepareStagingAnatomy(task, 'analysis-worker');
  assert.doesNotThrow(() => verifyStagingAnatomy(worker, 'analysis-worker'));
});
test('catalog-only worker release installs inside its existing scoped prefix and verifies bytes', async () => {
  process.env.BODY_ASSETS_INIT_TEST = '1';
  const { install } = await import('./staging-body-assets-init.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'anatomy-init-test-'));
  const data = Buffer.from('{"version":"verified","assets":[]}');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = Buffer.from(JSON.stringify({schema:'body-assets.v1',version:'test',files:[{path:'body-models.json',size:data.length,sha256:sha(data),roles:['bff']}]}));
  const env = { BODY_ASSETS_ROLE:'bff', BODY_ASSETS_ROOT:root,
    BODY_ASSETS_MANIFEST_KEY:'body-models/releases/existing-release/presets-012345abcdef/manifest.json', BODY_ASSETS_MANIFEST_SHA256:sha(manifest) };
  try {
    await install(async key => key.endsWith('/manifest.json') ? manifest : data, env);
    assert.deepEqual(await readFile(path.join(root, 'body-models.json')), data);
    await assert.rejects(install(async () => Buffer.from('wrong'), env), /checksum/);
    await assert.rejects(install(async () => manifest, {...env, BODY_ASSETS_MANIFEST_KEY:'body-models/releases/existing-release/../manifest.json'}), /invalid pinned/);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert(path.basename(root).startsWith('anatomy-init-test-'));
    await rm(root, { recursive:true, force:true });
  }
});
