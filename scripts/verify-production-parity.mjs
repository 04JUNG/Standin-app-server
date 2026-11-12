import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const profile=JSON.parse(readFileSync(new URL('../config/production-runtime-parity.json',import.meta.url),'utf8'));
export function verify(task,name) {
  if(!['bff','analysis-worker'].includes(name)||!task.family?.startsWith('StandinApp'))throw Error('production task required');
  const main=task.containerDefinitions.filter(c=>c.name===name);if(main.length!==1)throw Error('ambiguous serving container');
  const env=Object.fromEntries((main[0].environment??[]).map(e=>[e.name,e.value]));
  if(JSON.stringify(env).includes('standinstagingapp-'))throw Error('staging asset reference in production');
  const init=task.containerDefinitions.filter(c=>c.name==='body-assets-init');if(init.length!==1)throw Error('production body infrastructure must be deployed first');
  const body=Object.fromEntries(init[0].environment.map(e=>[e.name,e.value]));
  if(body.BODY_ASSETS_MANIFEST_KEY!==profile.bodyManifests.bff.manifestKey||body.BODY_ASSETS_MANIFEST_SHA256!==profile.bodyManifests.bff.manifestSha256)throw Error('approved production anatomy preset pin required');
  if(env.CONVERTER_CHARACTER_ID!=='male-base-v0-8-0')throw Error('approved default character required');
  if(name==='bff'&&(env.INTERACTIVE_STATE_ENABLED!=='true'||!main[0].secrets?.some(s=>s.name==='CONVERTER_INTERACTIVE_TOKEN'&&s.valueFrom.includes(':secret:standin/production/'))))throw Error('production private Converter transport must be provisioned first');
  if(env.REPLAY_ENVIRONMENT!=='production'||env.REPLAY_CONSENT_MODE!=='explicit'||!env.REPLAY_BUCKET)throw Error('production consent and private replay storage required');
  return true;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){verify(JSON.parse(readFileSync(process.argv[2],'utf8')),process.argv[3]);console.log('Production product and body asset parity verified');}
