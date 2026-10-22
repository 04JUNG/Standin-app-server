// Local synthetic wire data from joined production handlers; no real worker or S3.
// npm run build; NODE_ENV=test BETA_DATA_BUCKET= node tools/export-scene-wire-fixture.mjs /explicit/output.json
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { captureSceneWireFixture } from "../dist/pose/sceneIntegration.fixture.js";
if (!process.argv[2]) throw new Error("An explicit fixture output path is required");
const output = resolve(process.argv[2]);
const fixture = await captureSceneWireFixture();
const sources = ["../dist/pose/sceneRoutes.js", "../dist/pose/sceneRefinement.js", "../dist/output-scope/framingRoutes.js", "../dist/pose/sceneIntegration.fixture.js"];
const implementation = createHash("sha256");
for (const source of sources) implementation.update(source).update(await readFile(new URL(source, import.meta.url)));
fixture.provenance.implementationSha256 = implementation.digest("hex");
await writeFile(output, JSON.stringify(fixture, null, 2) + "\n");
console.log(JSON.stringify({ output, generatedAt: fixture.generatedAt, provenance: fixture.provenance.kind,
  persons: fixture.persons.length, reviewedSha: fixture.responses.prepare.json.artifactSha256 }));
