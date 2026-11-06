/** Synthetic fixture metadata/bytes for protocol tests only. Never production support. */
import { fixtureSelection } from "../interactive-state/fixture.js";
import { hash, type Operation } from "../interactive-state/model.js";
import { sha256Hex } from "../converter/client.js";
import { SKIN_EXPRESSION, skinBinding, type SkinContext } from "./skin-proof.js";
export const bytes = Buffer.from("Kaydara FBX Binary  \0\x1a\0synthetic-texture-proof-only"), sha = hash("synthetic runtime");
const original = fixtureSelection(hash("synthetic base selection"));
export const selection = { ...original, characterId: "synthetic-current-model", body: { ...original.body,
  resolvedBody: { ...original.body.resolvedBody!, assetSha256: hash("synthetic model") } } };
export const context: SkinContext = { runtimeRevision: sha, assetManifestSha256: hash("synthetic manifest"), assetVersion: "synthetic-v1",
  approvalIdentity: hash("synthetic exact full skin-only target"), skin: { version: "fbx-skin-v1", id: "flesh" },
  asset: { characterSha256: selection.body.resolvedBody.assetSha256, vertices: 100, bones: 52,
    polygonIndicesSha256: hash("synthetic indices"), weightsSha256: hash("synthetic neutral weights"),
    uvSha256: hash("synthetic corner UV"), uvBytes: 10, previewResolution: 2048, previewTextures: { flesh: { sha256: hash("synthetic preview PNG"), bytes: 20 } }, previewMesh: "mesh_000", trianglesSha256: hash("synthetic triangles"), textures: { flesh: { sha256: hash("synthetic PNG"), bytes: 10 } } } };
export const op: Operation = { installationId: "inst_synthetic", jobId: "job_synthetic", personIndex: 0,
  operationId: "op_synthetic", revision: 1, candidateId: "candidate", selectionHash: hash("approved selection"),
  stateHash: hash("canonical state"), snapshotProof: { identityHash: sha, modelSha256: sha, runtimeRevision: sha },
  previewState: "authoritative", exportState: "building", eventSequence: 1, expiresAt: "2099-01-01T00:00:00Z",
  createdAt: "2026-11-06T00:00:00Z", mutationId: "synthetic-mutation", requestHash: sha, errorCode: null,
  snapshotId: "synthetic", poster: null, skin: context.skin, receipt: { artifactSha256: hash("synthetic source"), skin: { meshes: 1, bones: 52 } } };
export function fixture() {
  return { artifact_contract: "textured-fbx-v1", fbx_base64: bytes.toString("base64"), fbx_sha256: sha256Hex(bytes),
    receipt: { version: "skin-fbx-receipt-v1", expression: SKIN_EXPRESSION, runtime_revision: sha, blender_version: "synthetic",
      source_artifact_sha256: op.receipt!.artifactSha256, fbx_sha256: sha256Hex(bytes), skin: op.skin!, skin_sha256: hash(op.skin),
      binding_sha256: skinBinding(op, selection, context), character_id: selection.characterId,
      character_sha256: context.asset.characterSha256, output_scope: "full",
      asset_manifest_sha256: context.assetManifestSha256, asset_version: context.assetVersion, uv_sha256: context.asset.uvSha256, texture_sha256: context.asset.textures.flesh!.sha256,
      base: { typed_fbx_values_preserved: true, approved_surface_changes_only: true, maxPositionErrorM: 0, maxNormalError: 0, maxMatrixError: 0, maxWeightError: 0 },
      material: { embedded: true, uv_verified: true, image_verified: true, manifest: {
        objects: { "1": hash(1), "2": hash(2), "3": hash(3) }, connections: [hash(4), hash(5), hash(6)], removed_connections: [hash(7)],
        geometry: "4", uv: hash(8), uv_layer_link: hash(9), texture_sha256: context.asset.textures.flesh!.sha256, embedded: true, meshes: 1 } },
      file_verified: true, csp_certified: true, verification_seconds: 0 } };
}
