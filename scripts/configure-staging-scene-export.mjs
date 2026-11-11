import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function configureStagingSceneExport(task, enabled, ref) {
  if (!ref?.startsWith('refs/heads/') || ref === 'refs/heads/main') {
    throw new Error('Scene export toggle is staging-only');
  }
  if (!['true', 'false'].includes(enabled)) throw new Error('Expected true or false');
  const result = structuredClone(task);
  const containers = result.containerDefinitions?.filter(c => c.name === 'bff');
  if (containers?.length !== 1) throw new Error('Expected one BFF container');
  const bff = containers[0];
  const values = Object.fromEntries((bff.environment ?? []).map(e => [e.name, e.value]));
  if (enabled === 'true' &&
      (values.FBX_EXPORT_ENABLED !== 'true' || !values.CONVERTER_BASE_URL?.trim())) {
    throw new Error('Integrated FBX export requires enabled FBX export and a Converter URL');
  }
  if ((bff.secrets ?? []).some(s => s.name === 'SCENE_EXPORT_ENABLED')) {
    throw new Error('SCENE_EXPORT_ENABLED is already managed as a secret');
  }
  bff.environment = (bff.environment ?? []).filter(e => e.name !== 'SCENE_EXPORT_ENABLED');
  bff.environment.push({ name: 'SCENE_EXPORT_ENABLED', value: enabled });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file] = process.argv.slice(2);
  if (!file) throw new Error('usage: configure-staging-scene-export.mjs TASKDEF');
  const enabled = process.env.STAGING_SCENE_EXPORT_ENABLED;
  const task = configureStagingSceneExport(
    JSON.parse(readFileSync(file, 'utf8')), enabled, process.env.GITHUB_REF,
  );
  writeFileSync(file, JSON.stringify(task, null, 2) + '\n');
  console.log(`Staging BFF: SCENE_EXPORT_ENABLED=${enabled}`);
}
