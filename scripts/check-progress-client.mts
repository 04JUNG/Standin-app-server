/** Optional cross-worktree check, never edits client source. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { readAnalysisProgress } = await import(pathToFileURL(process.argv[2]).href);
let checked=0;
for (const file of ["pipeline-v1.json","contract-cases-v1.json","focus-v1.json","scene-v1.json"]) {
  const fixture=JSON.parse(await readFile(`fixtures/analysis-progress/${file}`,"utf8"));
  for (const c of fixture.cases) for (const p of c.snapshots) {
    const parsed = readAnalysisProgress(p);
    assert.ok(parsed,`${file}/${c.name}/${p.sequence}`);
    if (p.focus) assert.deepEqual(parsed.focus,p.focus,`${file}/${c.name}/${p.sequence}/focus`);
    if (p.scene) assert.deepEqual(parsed.scene,p.scene,`${file}/${c.name}/${p.sequence}/scene`);
    checked++;
  }
}
console.log(`${checked} public snapshots accepted by the client's production parser`);
