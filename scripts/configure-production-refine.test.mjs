import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
for (const name of ["bff", "analysis-worker"]) {
  test(`production ${name} disables RC4 without changing legacy refine or storage`, () => {
    const root = mkdtempSync(join(tmpdir(), "refine-policy-"));
    try {
      const file = join(root, "task.json");
      writeFileSync(file, JSON.stringify({containerDefinitions:[{name, environment:[
        {name:"REFINE_RELEASE_ENABLED",value:"1"},
        {name:"REFINE_RELEASE_WORKER_URL",value:"http://staging-worker"},
        {name:"REFINE_FEATURE_ENABLED",value:"true"},
        {name:"REFINED_BUCKET",value:"keep-production-bucket"},
      ]}]}));
      execFileSync(process.execPath, [new URL("./configure-production-refine.mjs",import.meta.url).pathname,file,name]);
      const env=Object.fromEntries(JSON.parse(readFileSync(file)).containerDefinitions[0].environment.map(v=>[v.name,v.value]));
      assert.equal(env.REFINE_RELEASE_ENABLED,"0");
      assert.equal(env.REFINE_V3_SHADOW,"false");
      assert.equal(env.REFINE_RELEASE_WORKER_URL,undefined);
      assert.equal(env.REFINE_FEATURE_ENABLED,"true");
      assert.equal(env.REFINED_BUCKET,"keep-production-bucket");
    } finally { rmSync(root,{recursive:true,force:true}); }
  });
}
