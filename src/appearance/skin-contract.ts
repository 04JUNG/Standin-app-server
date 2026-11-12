/** Exact live contract intersected with independent immutable asset/CSP pins. */
import { z } from "zod";
import type { Appearance } from "./model.js";
import { skinSchema, skinSupportsScope, type Skin } from "./skin.js";
import { SKIN_EXPRESSION, type SkinAssetPin, type SkinContext } from "./skin-proof.js";
import { skinPreview } from "./skin-preview.js";
import { approvedSkins } from "./skin-pins.js";
import { hash, InteractiveError, SHA } from "../interactive-state/model.js";
import type { ResolvedSelection } from "../interactive-state/selection.js";
export interface SkinPolicy {
  assetManifestSha256: string;
  assetVersion: string;
  models: Record<string, SkinAssetPin>;
  certifiedTargets: { characterId: string; characterSha256: string; scope: "full"; skinId: Skin["id"];
    minOutlineWidth: number; maxOutlineWidth: number }[];
}
const sha = z.string().regex(SHA), skinId = skinSchema.shape.id;
const model = z.object({ character_sha256: sha, vertices: z.number().int().positive().max(1000000),
  bones: z.number().int().positive().max(256), preview_resolution: z.literal(2048),
  preview_mesh: z.string().min(1).max(100), triangles_sha256: sha, polygon_indices_sha256: sha, weights_sha256: sha }).strict();
const asset = z.object({ character_id: z.string().min(1).max(200), kind: z.enum(["uv", "texture", "preview-texture"]),
  skin_id: skinId.nullable(), sha256: sha, bytes: z.number().int().positive().max(16 * 1024 * 1024),
  url: z.string().max(100) }).strict();
export const skinContractSchema = z.object({ version: z.literal("fbx-skin-v1"), expression: z.literal(SKIN_EXPRESSION),
  enabled: z.boolean(), assets_available: z.boolean(), csp_certified: z.boolean(), acceptance_scope: z.literal("posed-fbx-import"),
  runtime_revision: sha, asset_manifest_sha256: sha, asset_version: z.string().min(1).max(100),
  skins: z.array(skinId).max(6), supported_targets: z.array(z.object({ character_id: z.string().min(1).max(200),
    character_sha256: sha, output_scope: z.literal("full"), skin_ids: z.array(skinId).min(1).max(5) }).strict()).max(100),
  candidate_models: z.record(z.string().max(200), model), assets: z.array(asset).max(256),
  zero: z.literal("default-legacy-byte-preserving"), order: z.tuple([z.literal("skin"), z.literal("outline")]),
}).strict();
export function checkSkinContract(raw: unknown, selection: ResolvedSelection, skin?: Skin, appearance?: Appearance, policy: SkinPolicy = approvedSkins) {
  const parsed = skinContractSchema.safeParse(raw);
  if (!parsed.success) throw new InteractiveError("SKIN_UNAVAILABLE", 503);
  const c = parsed.data;
  if (!c.enabled) throw new InteractiveError("SKIN_DISABLED", 503);
  if (!c.assets_available) throw new InteractiveError("SKIN_ASSETS_UNAVAILABLE", 503);
  if (!c.csp_certified) throw new InteractiveError("SKIN_NOT_CSP_CERTIFIED", 503);
  const pin = policy.models[selection.characterId], m = c.candidate_models[selection.characterId];
  if (!pin || !m || !skinSupportsScope(selection.scope) || pin.characterSha256 !== selection.body.resolvedBody?.assetSha256 ||
    c.asset_manifest_sha256 !== policy.assetManifestSha256 || c.asset_version !== policy.assetVersion ||
    m.character_sha256 !== pin.characterSha256 || m.vertices !== pin.vertices || m.bones !== pin.bones ||
    m.polygon_indices_sha256 !== pin.polygonIndicesSha256 || m.weights_sha256 !== pin.weightsSha256 ||
    m.preview_mesh !== pin.previewMesh || m.triangles_sha256 !== pin.trianglesSha256 || m.preview_resolution !== pin.previewResolution)
    throw new InteractiveError("SKIN_UNSUPPORTED");
  const targets = c.supported_targets.filter(t => t.character_id === selection.characterId && t.character_sha256 === pin.characterSha256 && t.output_scope === selection.scope);
  if (targets.length !== 1 || new Set(targets[0].skin_ids).size !== targets[0].skin_ids.length)
    throw new InteractiveError("SKIN_UNSUPPORTED");
  function checkedAsset(kind: "uv" | "texture" | "preview-texture", sid: Skin["id"] | null, digest: string, bytes: number) {
    const matches = c.assets.filter(a => a.character_id === selection.characterId && a.kind === kind && a.skin_id === sid);
    return matches.length === 1 && matches[0].sha256 === digest && matches[0].bytes === bytes && matches[0].url === `/skin-assets/${digest}`;
  }
  if (!checkedAsset("uv", null, pin.uvSha256, pin.uvBytes)) throw new InteractiveError("SKIN_UV_INCOMPATIBLE");
  const width = appearance?.width ?? 0;
  const supportedIds = skinSchema.shape.id.options.filter(id => id !== "default" &&
    c.skins.includes(id) && targets[0].skin_ids.includes(id) && !!pin.textures[id] &&
    checkedAsset("texture", id, pin.textures[id]!.sha256, pin.textures[id]!.bytes) &&
    !!pin.previewTextures[id] && checkedAsset("preview-texture", id, pin.previewTextures[id]!.sha256, pin.previewTextures[id]!.bytes) &&
    policy.certifiedTargets.some(t => t.characterId === selection.characterId && t.characterSha256 === pin.characterSha256 &&
      t.scope === selection.scope && t.skinId === id && width >= t.minOutlineWidth && width <= t.maxOutlineWidth));
  const chosen = skin?.id ?? supportedIds[0];
  if (!chosen || chosen === "default" || !supportedIds.includes(chosen)) throw new InteractiveError("SKIN_UNSUPPORTED");
  const selectedSkin: Skin = { version: "fbx-skin-v1", id: chosen };
  const approvalIdentity = hash({ version: "skin-asset-approval-v1", expression: c.expression, runtimeRevision: c.runtime_revision,
    assetManifestSha256: policy.assetManifestSha256, assetVersion: policy.assetVersion, characterId: selection.characterId,
    characterSha256: pin.characterSha256, vertices: pin.vertices, bones: pin.bones, polygonIndicesSha256: pin.polygonIndicesSha256,
    weightsSha256: pin.weightsSha256, previewMesh: pin.previewMesh, trianglesSha256: pin.trianglesSha256, uvSha256: pin.uvSha256, uvBytes: pin.uvBytes, texture: pin.textures[chosen],
    outputScope: selection.scope, skin: selectedSkin, outlineWidth: width });
  const context: SkinContext = { runtimeRevision: c.runtime_revision, assetManifestSha256: c.asset_manifest_sha256,
    assetVersion: c.asset_version, asset: pin, skin: selectedSkin, approvalIdentity };
  return { context, approval: { identity: approvalIdentity, preview: skinPreview(context, selection.characterId), supportedIds: ["default" as const, ...supportedIds] }, contract: c };
}
