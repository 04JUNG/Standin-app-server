/** Converter /outline-contract and /outline-fbx proof validation. No geometry solver here. */
import { z } from "zod";
import { appearanceSchema } from "./model.js";
import { hash, InteractiveError, SHA, type Operation } from "../interactive-state/model.js";
import { sha256Hex } from "../converter/client.js";
import type { ResolvedSelection } from "../interactive-state/selection.js";
const sha = z.string().regex(SHA);
export const MAX_OUTLINE_BYTES = 30 * 1024 * 1024;
export const outlineContractSchema = z.object({
  version: z.literal("fbx-outline-v1"), enabled: z.boolean(),
  expression: z.literal("skinned-inverted-hull-fbx-culling-v1"),
  mapping: z.literal("stature-relative-v1-experimental"),
  runtime_revision: sha, csp_certified: z.boolean(),
  certified_expressions: z.array(z.string().max(100)).max(20),
  supported_characters: z.array(z.string().max(200)).max(100),
  supported_scopes: z.array(z.enum(["full", "half", "bust", "shoulder_head", "head"])).max(5),
  candidate_characters: z.record(z.string().max(200), sha),
  width: z.object({ min: z.literal(0), max: z.literal(2) }).strict(),
  zero: z.literal("legacy-byte-preserving"),
}).strict();
export type OutlineContract = z.infer<typeof outlineContractSchema>;
export function checkContract(raw: unknown, selection: ResolvedSelection): OutlineContract {
  const parsed = outlineContractSchema.safeParse(raw);
  if (!parsed.success) throw new InteractiveError("OUTLINE_UNAVAILABLE", 503);
  const c = parsed.data;
  if (!c.enabled) throw new InteractiveError("OUTLINE_DISABLED", 503);
  // Actual CSP 5.1.1 automatic-import probes rejected this representation.
  // No environment flag or upstream boolean can certify it; a new reviewed contract is required.
  const rejected = new Set(["skinned-inverted-hull-fbx-culling-v1"]);
  if (rejected.has(c.expression) || !c.csp_certified || !c.certified_expressions.includes(c.expression))
    throw new InteractiveError("OUTLINE_NOT_CSP_CERTIFIED", 503);
  if (!c.supported_characters.includes(selection.characterId) || !c.supported_scopes.includes(selection.scope) ||
      c.candidate_characters[selection.characterId] !== selection.body.resolvedBody?.assetSha256)
    throw new InteractiveError("OUTLINE_UNSUPPORTED");
  return c;
}
export function outlineBinding(op: Operation, selection: ResolvedSelection, statureM: number, contract: OutlineContract) {
  if (!op.appearance || !op.receipt || !op.stateHash || !op.snapshotProof)
    throw new InteractiveError("OUTLINE_BINDING_MISMATCH");
  return hash({ version: "outlined-fbx-binding-v1", owner: { installationId: op.installationId, jobId: op.jobId, personIndex: op.personIndex },
    operation: op.operationId, revision: op.revision, candidateId: op.candidateId,
    selectionHash: op.selectionHash, stateHash: op.stateHash, snapshotProof: op.snapshotProof,
    sourceArtifactSha256: op.receipt.artifactSha256, appearance: op.appearance,
    characterId: selection.characterId, characterSha256: selection.body.resolvedBody!.assetSha256,
    outputScope: selection.scope, statureM,
    expression: contract.expression, mapping: contract.mapping, runtimeRevision: contract.runtime_revision });
}
const receiptSchema = z.object({
  version: z.literal("outlined-fbx-receipt-v1"),
  expression: z.literal("skinned-inverted-hull-fbx-culling-v1"),
  mapping: z.literal("stature-relative-v1-experimental"), runtime_revision: sha,
  blender_version: z.string().min(1).max(100), source_artifact_sha256: sha, fbx_sha256: sha,
  appearance: appearanceSchema, appearance_sha256: sha, binding_sha256: sha,
  character_id: z.string().min(1).max(200), character_sha256: sha,
  output_scope: z.enum(["full", "half", "bust", "shoulder_head", "head"]),
  stature_m: z.number().finite().min(1).max(2.5), thickness_m: z.number().finite().positive().max(.01),
  culling: z.literal("CullingOnCCW"),
  base: z.object({ typed_fbx_values_preserved: z.literal(true),
    maxPositionErrorM: z.number().finite().nonnegative().max(.0001),
    maxMatrixError: z.number().finite().nonnegative().max(.0001),
    maxWeightError: z.number().finite().nonnegative().max(.000001),
    maxNormalError: z.number().finite().nonnegative().max(.0001),
  }).strict(),
  outline: z.object({
    manifest: z.object({
      objects: z.record(z.string().regex(/^[0-9]{1,19}$/), sha),
      connections: z.array(sha).min(1).max(10000), culling: z.literal("CullingOnCCW"),
      meshes: z.number().int().positive().max(100),
    }).strict(),
    skin_verified: z.literal(true), displacement_verified: z.literal(true),
    max_displacement_error_m: z.number().finite().nonnegative().max(.000001),
    blender_import_backface_culling: z.array(z.boolean()).min(1).max(100),
  }).strict(),
  file_verified: z.literal(true), csp_certified: z.literal(true),
  verification_seconds: z.number().finite().nonnegative(),
}).strict();
export function parseOutlinedArtifact(raw: unknown, op: Operation, selection: ResolvedSelection, statureM: number, contract: OutlineContract) {
  try {
    const value = z.object({ artifact_contract: z.literal("outlined-fbx-v1"), fbx_base64: z.string().min(1).max(4 * Math.ceil(MAX_OUTLINE_BYTES / 3)), fbx_sha256: sha, receipt: receiptSchema }).strict().parse(raw);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.fbx_base64)) throw new Error("base64");
    const bytes = Buffer.from(value.fbx_base64, "base64"), r = value.receipt;
    const baseSkin = op.receipt?.skin as { meshes?: unknown; bones?: unknown } | undefined;
    const objects = Object.entries(r.outline.manifest.objects), meshes = r.outline.manifest.meshes;
    if (baseSkin?.meshes !== meshes || typeof baseSkin.bones !== "number" || !Number.isSafeInteger(baseSkin.bones) || baseSkin.bones < 1 || baseSkin.bones > 256 ||
        objects.length < meshes * 4 + 1 || objects.length > meshes * (baseSkin.bones + 4) + 1 ||
        objects.some(([id]) => BigInt(id) <= 0n || BigInt(id) >= 2n ** 63n) ||
        new Set(objects.map(([, digest]) => digest)).size !== objects.length ||
        new Set(r.outline.manifest.connections).size !== r.outline.manifest.connections.length)
      throw new Error("explicit manifest bounds");
    if (bytes.toString("base64") !== value.fbx_base64 || bytes.length > MAX_OUTLINE_BYTES ||
        !bytes.subarray(0, 23).equals(Buffer.from("Kaydara FBX Binary  \0\x1a\0")) ||
        sha256Hex(bytes) !== value.fbx_sha256 || r.fbx_sha256 !== value.fbx_sha256 ||
        r.source_artifact_sha256 !== op.receipt?.artifactSha256 || r.binding_sha256 !== outlineBinding(op, selection, statureM, contract) ||
        hash(r.appearance) !== hash(op.appearance) || r.appearance_sha256 !== hash(op.appearance) ||
        r.character_id !== selection.characterId || r.character_sha256 !== selection.body.resolvedBody!.assetSha256 ||
        r.output_scope !== selection.scope || r.stature_m !== statureM ||
        r.expression !== contract.expression || r.mapping !== contract.mapping || r.runtime_revision !== contract.runtime_revision ||
        // The converter-authored manifest is bounded and mandatory; never accept a bare verified flag.
        Object.keys(r.outline.manifest.objects).length < r.outline.manifest.meshes ||
        Object.keys(r.outline.manifest.objects).length > 10000 ||
        r.outline.blender_import_backface_culling.length !== r.outline.manifest.meshes)
      throw new Error("binding");
    // Mapping is checked against the versioned contract; CSS width is never a length in mm.
    if (Math.abs(r.thickness_m - r.appearance.width / 2 * statureM * .0015) > 1e-12)
      throw new Error("mapping");
    return { bytes, receipt: { artifactSha256: value.fbx_sha256, artifactBytes: bytes.length,
      bindingSha256: r.binding_sha256, appearance: r.appearance, sourceArtifactSha256: r.source_artifact_sha256,
      runtimeRevision: r.runtime_revision, expression: r.expression, mapping: r.mapping,
      proof: r } };
  } catch { throw new InteractiveError("OUTLINE_INTEGRITY_ERROR"); }
}
