import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The Node initializer uses the BFF's S3 dependency. Keep its runtime on the
// exact image being deployed instead of copying an expired historical digest.
export function refreshBodyInitImage(task, image, mainName) {
  if (!['bff', 'analysis-worker'].includes(mainName)) throw new Error('unexpected BFF container');
  const imageMatch = /^([^@\s]+)@sha256:[a-f0-9]{64}$/.exec(image);
  if (!imageMatch) throw new Error('deployment image must use an immutable digest');
  const result = structuredClone(task);
  const containers = result.containerDefinitions;
  if (!Array.isArray(containers)) throw new Error('missing container definitions');
  const main = containers.find(container => container.name === mainName);
  if (!main) throw new Error('missing BFF container');
  const repository = main.image?.split('@')[0].replace(/:[^/:]+$/, '');
  if (repository !== imageMatch[1]) throw new Error('initializer must use the BFF repository');
  const init = containers.find(container => container.name === 'body-assets-init');
  if (!init) {
    if (main.dependsOn?.some(dependency => dependency.containerName === 'body-assets-init')) {
      throw new Error('missing required body initializer');
    }
    return result;
  }
  if (init.command?.[0] !== 'node'
      || !init.environment?.some(variable => variable.name === 'BODY_ASSETS_ROLE' && variable.value === 'bff')
      || !main.dependsOn?.some(dependency => dependency.containerName === init.name && dependency.condition === 'SUCCESS')) {
    throw new Error('unexpected body initializer contract');
  }
  init.image = image;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, image, mainName] = process.argv.slice(2);
  if (!file) throw new Error('usage: refresh-body-init-image.mjs TASKDEF IMAGE MAIN_CONTAINER');
  const task = refreshBodyInitImage(JSON.parse(readFileSync(file, 'utf8')), image, mainName);
  writeFileSync(file, JSON.stringify(task, null, 2) + '\n');
  console.log(`Body initializer runtime prepared for ${mainName}`);
}
