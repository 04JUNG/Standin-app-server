/** Strict Converter typed-FBX skin proof; this never solves or modifies geometry. */
import { z } from "zod";
import { sha256Hex } from "../converter/client.js";
import { hash, InteractiveError, SHA, type Operation } from "../interactive-state/model.js";
import type { ResolvedSelection } from "../interactive-state/selection.js";
import { skinSchema, type Skin } from "./skin.js";
export const SKIN_EXPRESSION = "neutral-uv-embedded-basecolor-v1";
export const MAX_SKIN_BYTES = 30 * 1024 * 1024;
export interface SkinAssetPin {
  characterSha256: string;
  vertices: number;
  bones: number;
  polygonIndicesSha256: string;
  weightsSha256: string;
  uvSha256: string;
  uvBytes: number;
  previewMesh: string;
  trianglesSha256: string;
  previewResolution: number;
  previewTextures: Partial<Record<Skin["id"], { sha256: string; bytes: number }>>;
  textures: Partial<Record<Skin["id"], { sha256: string; bytes: number }>>;
}
export interface SkinContext {
  runtimeRevision: string;
  assetManifestSha256: string;
  assetVersion: string;
  asset: SkinAssetPin;
  skin: Skin;
  /** Includes exact approved asset metadata and the requested composition target. */
  approvalIdentity: string;
}
export function skinBinding(op: Operation, selection: ResolvedSelection, context: SkinContext) {
  if (!op.skin || op.skin.id === "default" || !op.receipt || !op.stateHash || !op.snapshotProof)
    throw new InteractiveError("SKIN_BINDING_MISMATCH");
  return hash({ version: "textured-fbx-binding-v1",
    owner: { installationId: op.installationId, jobId: op.jobId, personIndex: op.personIndex },
    operation: op.operationId, revision: op.revision, candidateId: op.candidateId,
    selectionHash: op.selectionHash, stateHash: op.stateHash, snapshotProof: op.snapshotProof,
    sourceArtifactSha256: op.receipt.artifactSha256, skin: op.skin,
    ...(op.appearance ? { appearance: op.appearance } : {}),
    characterId: selection.characterId, characterSha256: selection.body.resolvedBody!.assetSha256,
    outputScope: selection.scope, expression: SKIN_EXPRESSION,
    approvalIdentity: context.approvalIdentity, runtimeRevision: context.runtimeRevision,
    assetManifestSha256: context.assetManifestSha256, assetVersion: context.assetVersion,
    uvSha256: context.asset.uvSha256, textureSha256: context.asset.textures[op.skin.id]?.sha256 });
}
const sha = z.string().regex(SHA), id = z.string().regex(/^[1-9][0-9]{0,18}$/);
const receiptSchema = z.object({
  version: z.literal("skin-fbx-receipt-v1"), expression: z.literal(SKIN_EXPRESSION), runtime_revision: sha,
  blender_version: z.string().min(1).max(100), source_artifact_sha256: sha, fbx_sha256: sha,
  skin: skinSchema, skin_sha256: sha, binding_sha256: sha,
  character_id: z.string().min(1).max(200), character_sha256: sha, output_scope: z.literal("full"),
  asset_manifest_sha256: sha, asset_version: z.string().min(1).max(100), uv_sha256: sha, texture_sha256: sha,
  base: z.object({ typed_fbx_values_preserved: z.literal(true), approved_surface_changes_only: z.literal(true),
    maxPositionErrorM: z.number().finite().nonnegative().max(.0001),
    maxMatrixError: z.number().finite().nonnegative().max(.0001),
    maxWeightError: z.number().finite().nonnegative().max(.000001),
    maxNormalError: z.number().finite().nonnegative().max(.0001),
  }).strict(),
  material: z.object({ embedded: z.literal(true), uv_verified: z.literal(true), image_verified: z.literal(true),
    manifest: z.object({ objects: z.record(id, sha), connections: z.array(sha).length(3),
      removed_connections: z.array(sha).length(1), geometry: id, uv: sha, uv_layer_link: sha,
      texture_sha256: sha, embedded: z.literal(true), meshes: z.literal(1),
    }).strict(),
  }).strict(),
  file_verified: z.literal(true), csp_certified: z.literal(true), verification_seconds: z.number().finite().nonnegative(),
}).strict();
export function parseTexturedArtifact(raw: unknown, op: Operation, selection: ResolvedSelection, context: SkinContext) {
  try {
    const envelope = z.object({ artifact_contract: z.literal("textured-fbx-v1"),
      fbx_base64: z.string().min(1).max(4 * Math.ceil(MAX_SKIN_BYTES / 3)), fbx_sha256: sha, receipt: receiptSchema,
    }).strict().parse(raw);
    const r = envelope.receipt, a = context.asset, texture = op.skin && a.textures[op.skin.id];
    const baseRig = op.receipt?.skin as { meshes?: unknown; bones?: unknown } | undefined;
    if (!texture || op.skin?.id === "default" || selection.scope !== "full" ||
      hash(context.skin) !== hash(op.skin) || a.characterSha256 !== selection.body.resolvedBody?.assetSha256 ||
      baseRig?.meshes !== 1 || baseRig.bones !== a.bones || !Number.isSafeInteger(a.bones) || a.bones < 1 || a.bones > 256 ||
      r.runtime_revision !== context.runtimeRevision || r.asset_manifest_sha256 !== context.assetManifestSha256 || r.asset_version !== context.assetVersion ||
      r.uv_sha256 !== a.uvSha256 || r.texture_sha256 !== texture.sha256 ||
      r.material.manifest.texture_sha256 !== texture.sha256 ||
      r.character_id !== selection.characterId || r.character_sha256 !== a.characterSha256 || r.output_scope !== selection.scope ||
      r.source_artifact_sha256 !== op.receipt?.artifactSha256 || r.binding_sha256 !== skinBinding(op, selection, context) ||
      hash(r.skin) !== hash(op.skin) || r.skin_sha256 !== hash(op.skin)) throw new Error("binding");
    const manifest = r.material.manifest, entries = Object.entries(manifest.objects);
    const ids = [...entries.map(([key]) => key), manifest.geometry];
    const fingerprints = [...entries.map(([, digest]) => digest), ...manifest.connections, ...manifest.removed_connections, manifest.uv, manifest.uv_layer_link];
    if (entries.length !== 3 || new Set(ids).size !== ids.length || ids.some(key => BigInt(key) >= 2n ** 63n) ||
      new Set(fingerprints).size !== fingerprints.length) throw new Error("manifest");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(envelope.fbx_base64)) throw new Error("base64");
    const bytes = Buffer.from(envelope.fbx_base64, "base64");
    if (bytes.length > MAX_SKIN_BYTES || bytes.toString("base64") !== envelope.fbx_base64 ||
      !bytes.subarray(0, 23).equals(Buffer.from("Kaydara FBX Binary  \0\x1a\0")) ||
      sha256Hex(bytes) !== envelope.fbx_sha256 || r.fbx_sha256 !== envelope.fbx_sha256) throw new Error("bytes");
    return { bytes, receipt: { artifactSha256: envelope.fbx_sha256, artifactBytes: bytes.length,
      bindingSha256: r.binding_sha256, skin: r.skin, sourceArtifactSha256: r.source_artifact_sha256,
      runtimeRevision: r.runtime_revision, expression: r.expression,
      assetManifestSha256: r.asset_manifest_sha256, assetVersion: r.asset_version,
      uvSha256: r.uv_sha256, textureSha256: r.texture_sha256,
      compatibility: { characterId: selection.characterId, characterSha256: a.characterSha256,
        vertices: a.vertices, bones: a.bones, polygonIndicesSha256: a.polygonIndicesSha256, weightsSha256: a.weightsSha256,
        previewMesh: a.previewMesh, trianglesSha256: a.trianglesSha256 },
      proof: r } };
  } catch { throw new InteractiveError("SKIN_INTEGRITY_ERROR"); }
}
