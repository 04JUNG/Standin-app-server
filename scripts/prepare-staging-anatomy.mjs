import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const release = JSON.parse(readFileSync(new URL('../config/staging-anatomy-release.json', import.meta.url), 'utf8'));
export const initializer = readFileSync(new URL('./staging-body-assets-init.mjs', import.meta.url), 'utf8');
const setEnv = (container, values) => {
  const env = new Map((container.environment ?? []).map(e => [e.name, e.value]));
  for (const [key, value] of Object.entries(values)) env.set(key, value);
  container.environment = [...env].map(([name, value]) => ({ name, value }));
};
/** Apply only the checked-in staging body release; preserve unrelated deploy settings. */
export function prepareStagingAnatomy(task, mainName = 'bff') {
  if (!['bff', 'analysis-worker'].includes(mainName)) throw Error('Unexpected BFF container');
  if (!task.family?.startsWith('StandinStagingApp')) throw Error('Anatomy preparation requires staging');
  const next = structuredClone(task);
  const main = next.containerDefinitions?.find(c => c.name === mainName);
  const init = next.containerDefinitions?.find(c => c.name === 'body-assets-init');
  if (!main || !init || !main.dependsOn?.some(d => d.containerName === init.name && d.condition === 'SUCCESS'))
    throw Error('Missing reviewed body initializer dependency');
  const assets = mainName === 'analysis-worker' ? release.worker : release;
  setEnv(init, { BODY_ASSETS_ROLE: 'bff', BODY_ASSETS_ROOT: '/app/body-staging',
    BODY_ASSETS_MANIFEST_KEY: assets.prefix + '/manifest.json', BODY_ASSETS_MANIFEST_SHA256: assets.manifestSha256 });
  setEnv(main, { CONVERTER_CHARACTER_ID: 'male-base-v0-8-0', BODY_CATALOG_PATH: '/app/body-staging/body-models.json' });
  init.command = ['node', '--input-type=module', '-e', initializer];
  return next;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const task = prepareStagingAnatomy(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3] ?? 'bff');
  writeFileSync(process.argv[2], JSON.stringify(task, null, 2) + '\n');
  console.log('Pinned staging preset release prepared');
}
