import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function configureStagingRefine(task, containerName, settings = {}) {
  if (!task.family?.startsWith('StandinStagingApp')) throw new Error('Refine policy is staging-only');
  if (!['bff', 'analysis-worker'].includes(containerName)) throw new Error('Unsupported container');
  const values = { REFINE_RELEASE_ENABLED: '0', REFINE_FEATURE_ENABLED: 'true', ...settings };
  if (Object.keys(values).length !== 2 ||
      !['0', '1'].includes(values.REFINE_RELEASE_ENABLED) ||
      !['false', 'true'].includes(values.REFINE_FEATURE_ENABLED)) throw new Error('Invalid refine settings');
  const result = structuredClone(task);
  const containers = result.containerDefinitions?.filter(c => c.name === containerName);
  if (containers?.length !== 1) throw new Error('Expected one target container');
  const target = containers[0];
  const rows = target.environment ?? [];
  const env = Object.fromEntries(rows.map(e => [e.name, e.value]));
  if (Object.keys(env).length !== rows.length) throw new Error('Duplicate environment setting');
  if ((target.secrets ?? []).some(s => s.name in values)) throw new Error('Refine setting conflicts with a secret');
  Object.assign(env, values);
  target.environment = Object.entries(env).map(([name, value]) => ({ name, value }));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, containerName = 'bff'] = process.argv.slice(2);
  if (!file) throw new Error('usage: configure-staging-refine.mjs TASKDEF [bff|analysis-worker]');
  const result = configureStagingRefine(JSON.parse(readFileSync(file, 'utf8')), containerName, {
    REFINE_RELEASE_ENABLED: process.env.STAGING_REFINE_RELEASE_ENABLED ?? '0',
    REFINE_FEATURE_ENABLED: process.env.STAGING_REFINE_FEATURE_ENABLED ?? 'true',
  });
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.log(`Staging ${containerName}: refine policy applied; unrelated settings preserved`);
}
