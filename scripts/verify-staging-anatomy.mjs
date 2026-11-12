import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { release, initializer } from './prepare-staging-anatomy.mjs';

export function verifyStagingAnatomy(task, mainName = 'bff') {
  if (!task.family?.startsWith('StandinStagingApp')) throw Error('Anatomy guard requires a staging task');
  const main = task.containerDefinitions?.find(c => c.name === mainName);
  const init = task.containerDefinitions?.find(c => c.name === 'body-assets-init');
  const env = c => Object.fromEntries((c?.environment ?? []).map(e => [e.name, e.value]));
  const assets = mainName === 'analysis-worker' ? release.worker : release;
  const expected = {
    BODY_ASSETS_ROLE: 'bff',
    BODY_ASSETS_ROOT: '/app/body-staging',
    BODY_ASSETS_MANIFEST_KEY: assets.prefix + '/manifest.json',
    BODY_ASSETS_MANIFEST_SHA256: assets.manifestSha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (env(init)[key] !== value) throw Error(`Staging anatomy release changed: ${key}`);
  }
  if (JSON.stringify(init.command) !== JSON.stringify(['node', '--input-type=module', '-e', initializer]))
    throw Error('Staging body initializer changed');
  if (env(main).CONVERTER_CHARACTER_ID !== 'male-base-v0-8-0' ||
      env(main).BODY_CATALOG_PATH !== '/app/body-staging/body-models.json' ||
      !main?.dependsOn?.some(d => d.containerName === init?.name && d.condition === 'SUCCESS')) {
    throw Error('Staging anatomy default/catalog dependency changed');
  }
  return task;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyStagingAnatomy(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3] ?? 'bff');
  console.log('Approved staging anatomy release verified');
}
