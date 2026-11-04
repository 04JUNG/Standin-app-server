/** Opt-in, read-only evidence check. Never mounts assets or activates flags.
 * npm run build
 * BODY_SHAPE_EDIT_ENABLED=true BODY_DEFAULT_MANIFEST=<manifest.json> BODY_DEFAULT_BASE_CATALOG=<previous.json> node scripts/check-body-default-release.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseCatalog } from '../dist/body-selection/catalog.js';
import { bodyRef, defaultPreferences, snapshot, resolveBody } from '../dist/body-selection/model.js';
import { presentShapeEditable } from '../dist/body-selection/store.js';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const digest = p => createHash('sha256').update(readFileSync(p)).digest('hex');
assert.equal(process.env.BODY_SHAPE_EDIT_ENABLED, 'true', 'This standalone read-only check requires BODY_SHAPE_EDIT_ENABLED=true in this process only');
assert.ok(process.env.BODY_DEFAULT_MANIFEST, 'BODY_DEFAULT_MANIFEST is required');
assert.ok(process.env.BODY_DEFAULT_BASE_CATALOG, 'BODY_DEFAULT_BASE_CATALOG is required');
const manifest = read(process.env.BODY_DEFAULT_MANIFEST);
const contract = manifest.catalogContract;
const catalog = parseCatalog(read(contract.catalogPath));
const baseline = read(process.env.BODY_DEFAULT_BASE_CATALOG);
const registry = read(contract.charactersPath).characters;
const shapes = read(contract.shapeRegistryPath);
const gaps = [], evidence = [];
for (const [gender, model] of Object.entries(manifest.models)) {
  const a = catalog.assets.find(a => a.characterId === model.characterId);
  assert.ok(a, `${gender}: new asset missing`);
  assert.equal(a.role, 'default'); assert.equal(a.gender, gender);
  assert.equal(a.assetSha256, model.fbxSha256);
  assert.equal(digest(model.fbxPath), a.assetSha256, 'actual FBX bytes must match catalog');
  assert.equal(registry[a.characterId].sha256, a.assetSha256, 'converter character identity');
  assert.notEqual(a.characterId, model.currentEditorPreviousCharacterId);
  assert.equal(a.shape.controls.find(c => c.key === 'heads').default, model.targetHeads);
  for (const [pathKey, shaKey] of [['blend','blend_sha256'],['controller','controller_sha256']])
    assert.equal(digest(model.source[pathKey]), model.source[shaKey], 'actual authoring source');
  assert.equal(a.shapeSource.blendSha256, model.source.blend_sha256);
  assert.equal(a.shapeSource.controllerSha256, model.source.controller_sha256);
  assert.ok(shapes.characters[a.characterId], 'converter shape registry');
  const previous = catalog.assets.find(a => a.characterId === model.currentEditorPreviousCharacterId);
  const original = baseline.assets.find(a => a.characterId === previous?.characterId);
  assert.ok(previous && original, 'previous editor BASE must remain selectable');
  assert.equal(previous.role, 'previous_default');
  assert.deepEqual(bodyRef(previous), bodyRef(original));
  for (const key of ['shape','shapeSource','shapeRuntime']) assert.deepEqual(previous[key],original[key],`previous ${key} must not change`);
  assert.equal(registry[previous.characterId].sha256, previous.assetSha256);
  const poses = a.supportedPoseIds;
  const rec = {status:'available',body:bodyRef(a),reasonCodes:[]};
  const prefs = defaultPreferences(), policy = snapshot(prefs,catalog);
  assert.equal(policy.firstUseDefault.characterId,manifest.models.male.characterId);
  const automatic = resolveBody(0,policy,rec,catalog,poses,'auto');
  assert.equal(automatic.resolvedBody.characterId,a.characterId);
  assert.equal(automatic.resolutionStatus,'ready');
  assert.deepEqual(resolveBody(0,policy,rec,catalog,previous.supportedPoseIds,'manual',bodyRef(previous)).resolvedBody,bodyRef(previous));
  const used = snapshot({...prefs,lastUsed:{characterId:previous.characterId,controls:null,usedAt:'fixture'}},catalog);
  assert.equal(resolveBody(0,used,rec,catalog,previous.supportedPoseIds).resolvedBody.characterId,previous.characterId);
  const displayed = presentShapeEditable(catalog).find(e=>e.characterId===a.characterId);
  assert.equal(displayed.role,'default'); assert.equal(displayed.gender,gender);
  if (!a.neutralPreview) gaps.push(`${gender}: catalog neutral PNG not yet published`);
  else assert.equal(digest(a.neutralPreview.path),a.neutralPreview.sha256);
  if (!a.shapeRuntime) gaps.push(`${gender}: sampled runtime not yet published`);
  evidence.push({gender,characterId:a.characterId,assetSha256:a.assetSha256,previousCharacterId:previous.characterId,previousSha256:previous.assetSha256,measurement:model.measurement,poseCoverage:poses});
}
console.log(JSON.stringify({schema:'body-default-integration-evidence.v1',modelManifestSha256:digest(process.env.BODY_DEFAULT_MANIFEST),catalogSha256:digest(contract.catalogPath),previousCatalogSha256:digest(process.env.BODY_DEFAULT_BASE_CATALOG),status:'local_identity_policy_passed',activationAllowed:false,upstreamStatus:manifest.status,gaps,evidence,scope:'actual local FBX/source hashes and registry/catalog identities + policy checks; not a live HTTP conversion, final download or UI runtime proof'},null,2));
