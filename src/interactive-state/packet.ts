/** Validate the Converter's separately versioned canonical snapshot; never relax static GLB. */
import { z } from "zod";
import { sha256Hex } from "../converter/client.js";
import { EXPECTED_SOLVER_VERSION } from "../converter/client.js";
import { InteractiveError, hash, SHA, type Operation } from "./model.js";
import type { ResolvedSelection } from "./selection.js";
const sha = z.string().regex(SHA),
  number = z.number().finite(),
  matrix = z.array(number).length(16);
export const identitySchema = z
  .object({
    ownerBinding: sha,
    selection: z
      .object({
        operation: z.string().min(1),
        revision: z.number().int().positive(),
        person: z.string().min(1),
        candidate: z.string().min(1),
      })
      .strict(),
    source: z
      .object({
        originalBvhSha256: sha,
        refinedBvhSha256: sha.nullable(),
        refineVersion: z.string().min(1),
      })
      .strict(),
    body: z
      .object({
        characterId: z.string().min(1),
        characterSha256: sha,
        rigProfile: z.string().min(1),
      })
      .strict(),
    shape: z
      .object({
        sha256: sha.nullable(),
        rulesVersion: z.string().min(1),
        sourceSha256: sha.nullable(),
        controlsSha256: sha.nullable(),
      })
      .strict(),
    hands: z
      .object({
        left: z.string().nullable(),
        right: z.string().nullable(),
        librarySha256: sha,
        rulesVersion: z.literal("hand-bake-v1"),
      })
      .strict(),
    scope: z.enum(["full", "half", "bust", "head", "shoulder_head"]),
    mirror: z.boolean(),
    camera: z
      .object({
        projection: z.enum(["orthographic", "perspective"]),
        viewMatrix: matrix,
        projectionMatrix: matrix,
        distanceTorso: number.positive(),
        torsoReferenceSha256: sha,
        baked: z.literal(false),
      })
      .strict(),
    solver: z
      .object({
        version: z.literal(EXPECTED_SOLVER_VERSION),
        manifestSha256: sha,
        adapterVersion: z.enum(["post-frozen-snapshot-v1", "post-frozen-file-canonical-snapshot-v2"]),
        runtimeSha256: sha,
      })
      .strict(),
  })
  .strict();
export type Identity = z.infer<typeof identitySchema>;
const packetSchema = z
  .object({
    schema: z.literal("solved-pose-state-v1"),
    operation: z.string(),
    revision: z.number().int().positive(),
    stateHash: sha,
    previewState: z.literal("authoritative"),
    exportState: z.literal("not-requested"),
    canonicalEncoding: z.literal("typed-f64be-json-v1"),
    canonicalState: z
      .string()
      .min(1)
      .max(64 * 1024 * 1024),
  })
  .strict();
const safety = z
  .object({
    bodyAccepted: z.literal(true),
    handChecksPassed: z.literal(true),
    surface: z.literal("existing-adapter-checks-only"),
    finalFileVerified: z.literal(false),
  })
  .strict();
const vector = z.array(number).length(3);
const modelSchema = z
  .object({
    schema: z.literal("interactive-pose-model-v1"),
    coordinates: z
      .object({
        space: z.literal("right-handed-y-up-metres-hip-origin"),
        originBlender: vector,
        matrixLayout: z.literal("row-major"),
        baked: z.literal("rigged_rest"),
      })
      .strict(),
    capabilities: z.object({ localHands: z.literal(false) }).strict(),
    bones: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            parent: z.number().int().min(-1),
            restLocal: matrix,
            poseLocal: matrix,
            inverseBind: matrix,
          })
          .strict(),
      )
      .min(1)
      .max(256),
    meshes: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            positions: z.array(vector).min(1).max(500000),
            normals: z.array(vector).min(1).max(3000000),
            normalTriangles: z
              .array(z.array(z.number().int().nonnegative()).length(3))
              .min(1)
              .max(1000000),
            triangles: z
              .array(z.array(z.number().int().nonnegative()).length(3))
              .min(1)
              .max(1000000),
            weights: z
              .array(
                z
                  .array(
                    z.tuple([
                      z.number().int().nonnegative(),
                      number.positive().max(1),
                    ]),
                  )
                  .min(1)
                  .max(32),
              )
              .max(500000),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
const payloadSchema = z
  .object({
    schema: z.literal("solved-pose-state-v1"),
    identity: identitySchema,
    model: modelSchema,
    safety,
    dependencies: z
      .object({
        initialFbxRequired: z.literal(true),
        boundary: z.literal("post-frozen-body-pre-final-export-v1"),
      })
      .strict(),
  })
  .strict();
/** Float tags preserve Python's exact hash bytes. Never hash a decoded JS re-stringify. */
export function decodeTyped(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new InteractiveError("CONVERTER_INTEGRITY");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new InteractiveError("CONVERTER_INTEGRITY");
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => decodeTyped(v, depth + 1));
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Object.hasOwn(v, "$f64")) {
      if (
        Object.keys(v).length !== 1 ||
        typeof v.$f64 !== "string" ||
        !/^[a-f0-9]{16}$/.test(v.$f64)
      )
        throw new InteractiveError("CONVERTER_INTEGRITY");
      const n = Buffer.from(v.$f64, "hex").readDoubleBE();
      if (!Number.isFinite(n))
        throw new InteractiveError("CONVERTER_INTEGRITY");
      return n;
    }
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, x] of Object.entries(v)) {
      if (
        !/^[\x00-\x7f]*$/.test(k) ||
        ["__proto__", "prototype", "constructor"].includes(k)
      )
        throw new InteractiveError("CONVERTER_INTEGRITY");
      out[k] = decodeTyped(x, depth + 1);
    }
    return out;
  }
  throw new InteractiveError("CONVERTER_INTEGRITY");
}
export function checkIdentity(
  identity: Identity,
  op: Operation,
  selection: ResolvedSelection,
) {
  const i = identity;
  if (
    i.ownerBinding !== selection.identity.ownerBinding ||
    i.selection.operation !== op.operationId ||
    i.selection.revision !== op.revision ||
    i.selection.person !== String(op.personIndex) ||
    i.selection.candidate !== op.candidateId ||
    i.source.originalBvhSha256 !== selection.originalSha ||
    i.source.refinedBvhSha256 !==
      (selection.identity.source.variant === "refined"
        ? selection.sourceSha
        : null) ||
    i.body.characterId !== selection.characterId ||
    i.body.characterSha256 !== selection.body.resolvedBody!.assetSha256 ||
    i.shape.sha256 !== (selection.body.shape?.shapeSha256 ?? null) ||
    i.shape.rulesVersion !== (selection.body.shapeSource?.rules ?? (!selection.body.shape ? selection.defaultShapeRules : null) ?? "none") ||
    i.hands.left !== (selection.hands?.left ?? null) ||
    i.hands.right !== (selection.hands?.right ?? null) ||
    (selection.hands &&
      i.hands.librarySha256 !== selection.hands.library_sha256) ||
    i.scope !== selection.scope ||
    i.mirror !== false ||
    i.camera.projection !== selection.camera.projection ||
    i.camera.torsoReferenceSha256 !== selection.body.resolvedBody!.assetSha256
  )
    throw new InteractiveError("CONVERTER_INTEGRITY");
}
export function parsePacket(
  raw: unknown,
  op: Operation,
  selection: ResolvedSelection,
) {
  try {
    const packet = packetSchema.parse(raw);
    if (
      packet.operation !== op.operationId ||
      packet.revision !== op.revision ||
      (op.stateHash && packet.stateHash !== op.stateHash) ||
      !/^[\x00-\x7f]+$/.test(packet.canonicalState) ||
      sha256Hex(Buffer.from(packet.canonicalState, "ascii")) !==
        packet.stateHash
    )
      throw new Error("packet binding");
    const typed: unknown = JSON.parse(packet.canonicalState);
    if (canonicalTyped(typed) !== packet.canonicalState)
      throw new Error("noncanonical state");
    const payload = payloadSchema.parse(decodeTyped(typed));
    checkIdentity(payload.identity, op, selection);
    let vertices = 0;
    const bones = new Set<string>(),
      names = new Set<string>();
    payload.model.bones.forEach((b, i) => {
      if (b.parent >= i || bones.has(b.name)) throw new Error("bone hierarchy");
      bones.add(b.name);
    });
    for (const m of payload.model.meshes) {
      vertices += m.positions.length;
      if (
        vertices > 500000 ||
        m.triangles.length !== m.normalTriangles.length ||
        m.positions.length !== m.weights.length ||
        names.has(m.name)
      )
        throw new Error("mesh bounds");
      names.add(m.name);
      if (
        m.triangles.some((f) => f.some((v) => v >= m.positions.length)) ||
        m.normalTriangles.some((f) => f.some((v) => v >= m.normals.length))
      )
        throw new Error("triangle");
      for (const weights of m.weights) {
        const ids = new Set<number>();
        let total = 0;
        for (const [id, w] of weights) {
          if (id >= bones.size || ids.has(id)) throw new Error("skin");
          ids.add(id);
          total += w;
        }
        if (Math.abs(total - 1) > 1e-4) throw new Error("weights");
      }
    }
    const rawModel = (typed as Record<string, unknown>).model;
    const snapshotProof = {
      identityHash: hash(payload.identity),
      modelSha256: sha256Hex(Buffer.from(canonicalTyped(rawModel), "ascii")),
      runtimeRevision: payload.identity.solver.runtimeSha256,
    };
    if (op.snapshotProof && hash(op.snapshotProof) !== hash(snapshotProof))
      throw new Error("snapshot proof changed");
    return { packet, payload, snapshotProof };
  } catch {
    throw new InteractiveError("CONVERTER_INTEGRITY");
  }
}
export const receiptSchema = z
  .object({
    schema: z.literal("interactive-fbx-receipt-v1"),
    stateHash: sha,
    revision: z.number().int().positive(),
    operation: z.string(),
    identity: identitySchema,
    verified: z.literal(true),
    artifactSha256: sha,
    artifactBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    runtimeRevision: sha,
    packetModelSha256: sha,
    reimportModelSha256: sha,
    skin: z
      .object({
        version: z.literal("final-fbx-v1"),
        artifact_sha256: sha,
        scope: z.string(),
        bones: z.number().int().positive(),
        meshes: z.number().int().positive(),
        vertices: z.number().int().positive(),
        polygons: z.number().int().positive(),
        skin_verified: z.literal(true),
      })
      .strict(),
    correspondence: z
      .object({
        topology: z.literal(true),
        jointIdentity: z.literal(true),
        skinIdentity: z.literal(true),
        maxPositionErrorM: number.nonnegative(),
        maxMatrixError: number.nonnegative(),
        maxWeightError: number.nonnegative(),
        maxNormalError: number.nonnegative(),
        positionToleranceM: number.positive(),
        matrixTolerance: number.positive(),
        weightTolerance: number.positive(),
      })
      .strict(),
    safety,
    limitations: z.array(z.string().max(100)).max(20),
  })
  .strict();
export function parseReceipt(
  raw: unknown,
  op: Operation,
  selection: ResolvedSelection,
) {
  try {
    const r = receiptSchema.parse(raw);
    checkIdentity(r.identity, op, selection);
    const e = r.correspondence;
    if (
      !op.snapshotProof ||
      hash(r.identity) !== op.snapshotProof.identityHash ||
      r.packetModelSha256 !== op.snapshotProof.modelSha256 ||
      r.runtimeRevision !== op.snapshotProof.runtimeRevision ||
      r.runtimeRevision !== r.identity.solver.runtimeSha256 ||
      r.stateHash !== op.stateHash ||
      r.operation !== op.operationId ||
      r.revision !== op.revision ||
      r.skin.artifact_sha256 !== r.artifactSha256 ||
      r.skin.scope !== selection.scope ||
      e.positionToleranceM > 0.0001 ||
      e.matrixTolerance > 0.00001 ||
      e.weightTolerance > 0.000001 ||
      e.maxPositionErrorM > e.positionToleranceM ||
      e.maxMatrixError > e.positionToleranceM ||
      e.maxWeightError > e.weightTolerance ||
      e.maxNormalError > 0.0001
    )
      throw new Error("receipt");
    return r;
  } catch {
    throw new InteractiveError("CONVERTER_INTEGRITY");
  }
}

/** Serialize the still-typed tree, preserving Python IEEE754 tags exactly. */
function canonicalTyped(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
    );
  if (Array.isArray(value))
    return "[" + value.map(canonicalTyped).join(",") + "]";
  return (
    "{" +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => canonicalTyped(k) + ":" + canonicalTyped(v))
      .join(",") +
    "}"
  );
}
