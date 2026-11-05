/** Optional cross-worktree check, never edits client source. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { readAnalysisProgress } = await import(pathToFileURL(process.argv[2]).href);
let checked=0;
for (const file of ["pipeline-v1.json","contract-cases-v1.json"]) {
  const fixture=JSON.parse(await readFile(`fixtures/analysis-progress/${file}`,"utf8"));
  for (const c of fixture.cases) for (const p of c.snapshots) {
    assert.ok(readAnalysisProgress(p),`${file}/${c.name}/${p.sequence}`); checked++;
  }
}
console.log(`${checked} public snapshots accepted by the client's production parser`);
