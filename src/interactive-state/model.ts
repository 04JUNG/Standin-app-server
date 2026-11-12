/** Additive HTTP contract. Client requests contain identifiers, never authoritative geometry. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { appearanceSchema, nonzeroAppearance, type Appearance } from "../appearance/model.js";
import type { SkinPreview } from "../appearance/skin-preview.js";
import { skinSchema, nondefaultSkin, type Skin } from "../appearance/skin.js";
export const HTTP_SCHEMA = "standin.interactive-http.v1";
export const SHA = /^[a-f0-9]{64}$/;
export class InteractiveError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 410 | 413 | 426 | 429 | 503 = 409,
  ) {
    super(code);
  }
}
export const prepareSchema = z
  .object({
    schemaVersion: z.literal(HTTP_SCHEMA),
    candidateId: z.string().min(1).max(200),
    appearance: appearanceSchema.optional(),
    skin: skinSchema.optional(),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    expectedStateHash: z.string().regex(SHA).nullable(),
    mutationId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  })
  .strict()
  .refine((v) => v.revision > v.expectedRevision)
  .transform(({ appearance, skin, ...rest }) => {
    const normalized = nonzeroAppearance(appearance);
    const material = nondefaultSkin(skin);
    return { ...rest, ...(normalized ? { appearance: normalized } : {}), ...(material ? { skin: material } : {}) };
  });
export type Prepare = Omit<z.infer<typeof prepareSchema>, "appearance"> & { appearance?: Appearance };
export interface Location {
  installationId: string;
  jobId: string;
  personIndex: number;
}
export type PreviewState =
  | "solving"
  | "authoritative"
  | "error"
  | "superseded"
  | "cancelled";
export type ExportState =
  | "not-requested"
  | "queued"
  | "building"
  | "ready"
  | "failed"
  | "superseded"
  | "cancelled";
export interface Operation extends Location {
  operationId: string;
  candidateId: string;
  appearance?: Appearance;
  skin?: Skin;
  skinReceipt?: Record<string, unknown>;
  skinPreview?: SkinPreview;
  /** Separately verified postprocess proof; base receipt stays unchanged. */
  outlineReceipt?: Record<string, unknown>;
  revision: number;
  /** Stable request identity; includes server preferences, no clocks/paths/display names. */
  selectionHash: string;
  /** Converter canonical snapshot digest. Null until solve; never replaced once assigned. */
  stateHash: string | null;
  previewState: PreviewState;
  exportState: ExportState;
  eventSequence: number;
  expiresAt: string;
  createdAt: string;
  mutationId: string;
  requestHash: string;
  errorCode: string | null;
  snapshotProof: {
    identityHash: string;
    modelSha256: string;
    runtimeRevision: string;
  } | null;
  snapshotId: string | null;
  receipt: Record<string, unknown> | null;
  uiFrame?: { sha256: string; renderer: string; cameraHash: string };
  poster: { sha256: string; renderer: string } | null;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  throw new InteractiveError("INVALID_STATE");
}
export const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const locationKey = (l: Location) =>
  [l.installationId, l.jobId, l.personIndex].join(":");
/** The base rig receipt is never replaced with a material/outline proof. */
export function finalReceipt(op: Operation) {
  return op.appearance ? op.outlineReceipt : op.skin ? op.skinReceipt : op.receipt;
}
export function postprocessReady(op: Operation) {
  return (!op.skin || !!op.skinReceipt) && (!op.appearance || !!op.outlineReceipt);
}
/** Outline verifies the textured source while the durable operation retains its base receipt. */
export function outlineSourceOperation(op: Operation): Operation {
  if (!op.skin) return op;
  if (!op.skinReceipt || !op.receipt || op.skinReceipt.sourceArtifactSha256 !== op.receipt.artifactSha256)
    throw new InteractiveError("SKIN_BINDING_MISMATCH");
  return { ...op, receipt: { ...op.receipt, artifactSha256: op.skinReceipt.artifactSha256, artifactBytes: op.skinReceipt.artifactBytes } };
}
export function active(op: Operation) {
  return !["superseded", "cancelled", "error"].includes(op.previewState);
}
export function publicOperation(op: Operation) {
  const base = `/v1/analysis/jobs/${encodeURIComponent(op.jobId)}/people/${op.personIndex}/interactive-state/${op.operationId}`;
  return {
    schemaVersion: HTTP_SCHEMA,
    operationId: op.operationId,
    candidateId: op.candidateId,
    ...(op.appearance ? { appearance: op.appearance } : {}),
    ...(op.skin ? { skin: op.skin } : {}),
    ...(op.skin && op.skinPreview && active(op) && op.stateHash ? { skinPreview: { ...op.skinPreview,
      uv: { ...op.skinPreview.uv, url: `${base}/skin-assets/${op.skinPreview.uv.sha256}` },
      texture: { ...op.skinPreview.texture, url: `${base}/skin-assets/${op.skinPreview.texture.sha256}` } } } : {}),
    revision: op.revision,
    selectionHash: op.selectionHash,
    stateHash: op.stateHash,
    previewState: op.previewState,
    exportState: op.exportState,
    eventSequence: op.eventSequence,
    expiresAt: op.expiresAt,
    modelUrl: active(op) && op.stateHash ? `${base}/model` : null,
    fileUrl: active(op) && postprocessReady(op) && op.exportState === "ready" ? `${base}/file` : null,
    posterUrl: active(op) && op.poster ? `${base}/poster` : null,
    exportReceipt:
      active(op) && postprocessReady(op) && op.exportState === "ready" && op.receipt
        ? {
            schema: "interactive-fbx-receipt-v1",
            operationId: op.operationId,
            revision: op.revision,
            stateHash: op.stateHash,
            artifactSha256: finalReceipt(op)?.artifactSha256,
            artifactBytes: finalReceipt(op)?.artifactBytes,
            ...(op.appearance ? { appearance: op.appearance, outline: op.outlineReceipt } : {}),
            ...(op.skin ? { skin: op.skin, skinProof: op.skinReceipt } : {}),
            runtimeRevision: op.receipt.runtimeRevision,
            packetModelSha256: op.receipt.packetModelSha256,
            solverVersion: "chain-transport-v3.2.5",
            validationVersion: "final-fbx-v1",
            initialFbxRequired: true,
            nativeSaved: false,
          }
        : null,
    errorCode: op.errorCode,
  };
}
