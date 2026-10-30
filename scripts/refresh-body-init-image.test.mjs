import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshBodyInitImage } from './refresh-body-init-image.mjs';

const repository = '136889124221.dkr.ecr.ap-northeast-2.amazonaws.com/standin/bff';
const image = `${repository}@sha256:${'a'.repeat(64)}`;
const fixture = name => ({
  family: 'existing-task', executionRoleArn: 'existing-execution-role',
  taskRoleArn: 'existing-task-role', volumes: [{ name: 'body-assets' }],
  containerDefinitions: [
    { name, image: `${repository}:old-commit`, environment: [{ name: 'EXISTING_FLAG', value: 'true' }],
      dependsOn: [{ containerName: 'body-assets-init', condition: 'SUCCESS' }],
      mountPoints: [{ sourceVolume: 'body-assets', containerPath: '/app/body-staging', readOnly: true }] },
    { name: 'body-assets-init', image: `${repository}@sha256:${'e'.repeat(64)}`,
      command: ['node', '--input-type=module', '-e', 'existing installer'], essential: false,
      environment: [{ name: 'BODY_ASSETS_ROLE', value: 'bff' },
        { name: 'BODY_ASSETS_MANIFEST_SHA256', value: 'existing-manifest' }],
      mountPoints: [{ sourceVolume: 'body-assets', containerPath: '/app/body-staging', readOnly: false }] },
  ],
});

for (const name of ['bff', 'analysis-worker']) {
  test(`${name}: replace stale initializer image while preserving assets, roles and startup dependency`, () => {
    const original = fixture(name);
    const before = structuredClone(original);
    const result = refreshBodyInitImage(original, image, name);
    const expected = structuredClone(original);
    expected.containerDefinitions[1].image = image;
    assert.deepEqual(result, expected);
    assert.deepEqual(original, before);
  });
}

test('deployments without body assets remain supported', () => {
  const task = { containerDefinitions: [{ name: 'bff', image: `${repository}:old` }] };
  assert.deepEqual(refreshBodyInitImage(task, image, 'bff'), task);
});

test('reject incompatible runtimes, broken dependencies, mutable images and unrelated repositories', () => {
  const python = fixture('bff'); python.containerDefinitions[1].command[0] = 'python';
  const wrongRole = fixture('bff'); wrongRole.containerDefinitions[1].environment[0].value = 'inference';
  const dependency = fixture('bff'); dependency.containerDefinitions[0].dependsOn[0].condition = 'START';
  const missing = fixture('bff'); missing.containerDefinitions.pop();
  for (const task of [python, wrongRole, dependency, missing]) {
    assert.throws(() => refreshBodyInitImage(task, image, 'bff'));
  }
  assert.throws(() => refreshBodyInitImage(fixture('bff'), `${repository}:latest`, 'bff'));
  assert.throws(() => refreshBodyInitImage(fixture('bff'), image.replace('/bff@', '/inference@'), 'bff'));
  assert.throws(() => refreshBodyInitImage(fixture('bff'), image, 'inference'));
});
