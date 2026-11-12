/** tsc does not emit .mjs sources. Copy vendored runtime modules into dist byte-for-byte,
 * refusing to build when a module no longer matches its pinned PROVENANCE SHA256. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const source = "src/interactive-state/shared", target = "dist/interactive-state/shared";
const provenance = await readFile(`${source}/PROVENANCE.txt`, "utf8");
const pinned = /^SHA256: ([a-f0-9]{64})$/m.exec(provenance)?.[1];
const name = /^Path: converter\/shared\/(interactive_pose_v2\.mjs)$/m.exec(provenance)?.[1];
if (!pinned || !name) throw new Error(`${source}/PROVENANCE.txt has no Path/SHA256 pin`);
const bytes = await readFile(`${source}/${name}`);
const actual = createHash("sha256").update(bytes).digest("hex");
if (actual !== pinned) throw new Error(`${source}/${name} sha256 ${actual} does not match PROVENANCE ${pinned}`);
await mkdir(target, { recursive: true });
await writeFile(`${target}/${name}`, bytes);
