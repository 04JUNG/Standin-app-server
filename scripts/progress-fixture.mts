/** Convert offline producer fixtures through the REAL public allowlist. */
import { readFile, writeFile } from "node:fs/promises";
import { sanitizeProgress } from "../src/jobs/progress.js";
const source=JSON.parse(await readFile(process.argv[2],"utf8"));
const cases=source.cases.map((c:{name:string;providerCalls:number;snapshots:unknown[]})=>({
  name:c.name,providerCalls:c.providerCalls,
  snapshots:c.snapshots.flatMap(s=>{const p=sanitizeProgress(s);return p?[p]:[];}),
}));
await writeFile("fixtures/analysis-progress/pipeline-v1.json",JSON.stringify({fixtureOnly:true,
  description:"Offline mock-pipeline milestones passed through production BFF sanitizer. No provider/render calls for UI.",cases},null,2)+"\n");
