/** Read-only Top-K previews bound to the persisted body choice. No search/refine mutation. */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { CandidateCamera } from "../types.js";
import { config } from "../config.js";
import { getOwnedJob } from "../jobs/store.js";
import { getPoseBvh } from "../inference.js";
import { checkCharacter } from "../characters/service.js";
import { errorEnvelope } from "../mapping.js";
import { cameraArtifact } from "../candidate-camera/artifacts.js";
import { convertFramed } from "../converter/framing.js";
import {
  ConverterError,
  converterEnabled,
  sha256Hex,
} from "../converter/client.js";
import { getPreviewModel } from "../converter/previewModel.js";
import {
  getPreviewRuntime,
  type PreviewRuntime,
} from "../converter/previewRuntime.js";
import { bodyRef, type BodyRef } from "./model.js";
import { BodyError, bodyStore } from "./store.js";

export const BODY_PREVIEW_SCHEMA = "body-previews.v1";
export function bodyPreviewManifestUrl(jobId: string, personIndex: number) {
  return `/v1/analysis/jobs/${encodeURIComponent(jobId)}/people/${personIndex}/body-previews`;
}
const defaults = {
  enabled: () => config.bodySelectionEnabled,
  converterEnabled,
  getOwnedJob,
  selection: bodyStore.selection,
  checkCharacter,
  getPoseBvh,
  getPreviewRuntime,
  convertFramed,
  getModel: (source: string, body: BodyRef, runtime: PreviewRuntime) =>
    getPreviewModel(source, body.characterId, fetch, {
      characterSha256: body.assetSha256,
      previewRevision: runtime.previewRevision,
      modelRevision: runtime.modelRevision,
    }),
};
export type BodyPreviewDeps = typeof defaults;

function validCamera(
  camera: CandidateCamera | undefined,
): camera is CandidateCamera {
  if (
    !camera ||
    camera.version !== "candidate-camera-v1" ||
    !/^[a-f0-9]{64}$/.test(camera.source_bvh_sha256)
  )
    return false;
  const m = camera.rotation;
  if (
    !Array.isArray(m) ||
    m.length !== 3 ||
    m.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== 3 ||
        row.some((x) => typeof x !== "number" || !Number.isFinite(x)),
    )
  )
    return false;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      if (
        Math.abs(
          m[i].reduce((sum, x, k) => sum + x * m[j][k], 0) - (i === j ? 1 : 0),
        ) > 1e-6
      )
        return false;
  const [a, b, c] = m;
  return (
    Math.abs(
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0]) -
        1,
    ) < 1e-6
  );
}

/** All values used in the key come from owned stored results or the converter contract. */
export async function bodyPreviewManifest(
  owner: string,
  jobId: string,
  personIndex: number,
  deps: BodyPreviewDeps = defaults,
) {
  const job = await deps.getOwnedJob(jobId, owner);
  if (!job) throw new BodyError("NOT_FOUND", 404);
  if (job.status !== "completed" || !job.result)
    throw new BodyError("NOT_READY", 409);
  const person = job.result.candidatesByPerson.find(
    (p) => p.personIndex === personIndex,
  );
  if (!person) throw new BodyError("NOT_FOUND", 404);
  // selection() checks the current catalog, job policy snapshot and installation ownership.
  const selection = await deps.selection(owner, jobId, personIndex);
  if (!person.candidates.length)
    throw new BodyError("BODY_NOT_APPLICABLE", 409);
  if (selection.resolutionStatus !== "ready" || !selection.resolvedBody)
    throw new BodyError(
      selection.resolutionStatus === "needs_selection"
        ? "BODY_SELECTION_REQUIRED"
        : "BODY_UNAVAILABLE",
      409,
    );
  const body = bodyRef(selection.resolvedBody);
  if ((await deps.checkCharacter(body.characterId)) !== "ok")
    throw new BodyError("BODY_UNAVAILABLE", 409);
  if (!deps.converterEnabled())
    throw new BodyError("BODY_PREVIEW_UNAVAILABLE", 503);
  const ids = new Set<string>();
  const candidates = person.candidates.map((c) => {
    if (!c.bvhAvailable || !validCamera(c.camera) || ids.has(c.id))
      throw new BodyError("BODY_PREVIEW_UNSUPPORTED", 409);
    ids.add(c.id);
    return {
      candidateId: c.id,
      poseId: c.poseId,
      rank: c.rank,
      view: c.view,
      camera: structuredClone(c.camera),
      sourceBvhSha256: c.camera.source_bvh_sha256,
    };
  });
  const runtime = await deps.getPreviewRuntime();
  const renderKey = sha256Hex(
    Buffer.from(
      JSON.stringify([
        BODY_PREVIEW_SCHEMA,
        owner,
        jobId,
        personIndex,
        selection.selectionRevision,
        body,
        "full",
        runtime,
        candidates,
      ]),
    ),
  );
  const prefix = bodyPreviewManifestUrl(jobId, personIndex);
  return {
    schemaVersion: BODY_PREVIEW_SCHEMA,
    jobId,
    personIndex,
    selectionRevision: selection.selectionRevision,
    resolvedBody: body,
    renderKey,
    outputScope: "full" as const,
    // Manifest readiness is not successful rendering; bytes are fetched on demand.
    status: "renderable" as const,
    renderingExecuted: false as const,
    runtime,
    candidates: candidates.map((c) => {
      const base = `${prefix}/${renderKey}/${encodeURIComponent(c.candidateId)}`;
      return {
        ...c,
        thumbnailUrl: `${base}/png`,
        previewModel: {
          url: `${base}/glb`,
          rotation: c.camera.rotation,
          sourceSha: c.sourceBvhSha256,
          characterId: body.characterId,
          characterSha256: body.assetSha256,
          modelRevision: runtime.modelRevision,
          previewRevision: runtime.previewRevision,
        },
      };
    }),
  };
}
export type BodyPreviewManifest = Awaited<
  ReturnType<typeof bodyPreviewManifest>
>;

export function createBodyPreviewRoutes(
  overrides: Partial<BodyPreviewDeps> = {},
) {
  const deps = { ...defaults, ...overrides };
  const app = new Hono<AppEnv>();
  const prefix = "/:jobId/people/:personIndex/body-previews";
  for (const path of [prefix, `${prefix}/*`])
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      if (!c.get("installationId"))
        return c.json(
          errorEnvelope(
            "UNAUTHORIZED",
            "설치 인증이 필요합니다.",
            c.get("requestId"),
          ),
          401,
        );
      if (!deps.enabled()) throw new BodyError("BODY_SELECTION_DISABLED", 503);
      await next();
    });
  app.onError((error, c) => {
    if (error instanceof BodyError)
      return c.json(
        errorEnvelope(
          error.code,
          "현재 체형과 후보를 확인한 뒤 다시 시도해 주세요.",
          c.get("requestId"),
          error.details,
        ),
        error.status,
      );
    if (error instanceof ConverterError) {
      const status = ["CONVERTER_INTEGRITY", "CONVERTER_REJECTED"].includes(
        error.code,
      )
        ? 409
        : 503;
      return c.json(
        errorEnvelope(
          error.code,
          "체형 미리보기를 불러오지 못했습니다.",
          c.get("requestId"),
        ),
        status,
      );
    }
    return c.json(
      errorEnvelope(
        "BODY_PREVIEW_UNAVAILABLE",
        "체형 미리보기를 불러오지 못했습니다.",
        c.get("requestId"),
      ),
      503,
    );
  });
  function index(raw: string) {
    if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new BodyError("INVALID_INPUT", 400);
    return Number(raw);
  }
  app.get(prefix, async (c) =>
    c.json(
      await bodyPreviewManifest(
        c.get("installationId")!,
        c.req.param("jobId"),
        index(c.req.param("personIndex")),
        deps,
      ),
    ),
  );
  app.get(`${prefix}/:renderKey/:candidateId/:format`, async (c) => {
    const owner = c.get("installationId")!,
      jobId = c.req.param("jobId"),
      personIndex = index(c.req.param("personIndex"));
    const format = c.req.param("format"),
      requestedKey = c.req.param("renderKey");
    if (
      !["glb", "png"].includes(format) ||
      !/^[a-f0-9]{64}$/.test(requestedKey) ||
      Object.keys(c.req.query()).length
    )
      throw new BodyError("INVALID_INPUT", 400);
    const manifest = await bodyPreviewManifest(owner, jobId, personIndex, deps);
    if (manifest.renderKey !== requestedKey)
      throw new BodyError("BODY_PREVIEW_STALE", 409);
    const candidate = manifest.candidates.find(
      (p) => p.candidateId === c.req.param("candidateId"),
    );
    if (!candidate) throw new BodyError("NOT_FOUND", 404);
    // Preserve existing quarantine/source checks even when serving precomputed or cached assets.
    const response = await deps.getPoseBvh(candidate.poseId);
    if (!response.ok) {
      await response.body?.cancel();
      throw new BodyError(
        response.status === 409 || response.status === 404
          ? "POSE_UNAVAILABLE"
          : "BODY_PREVIEW_UNAVAILABLE",
        response.status === 409 || response.status === 404 ? 409 : 503,
      );
    }
    const bvhBytes = new Uint8Array(await response.arrayBuffer());
    if (sha256Hex(bvhBytes) !== candidate.sourceBvhSha256)
      throw new BodyError("POSE_UNAVAILABLE", 409);
    let bytes: Uint8Array;
    if (format === "glb")
      bytes = await deps.getModel(
        candidate.sourceBvhSha256,
        manifest.resolvedBody,
        manifest.runtime,
      );
    else {
      const artifact = await cameraArtifact(
        [owner, jobId, personIndex, requestedKey, candidate.candidateId],
        {
          bvhBytes,
          characterId: manifest.resolvedBody.characterId,
          scope: "full",
          cameraRotation: candidate.camera.rotation,
          expectedCharacterSha256: manifest.resolvedBody.assetSha256,
          expectedPreviewRevision: manifest.runtime.previewRevision,
        },
        deps.convertFramed,
      );
      if (
        artifact.characterSha256 !== manifest.resolvedBody.assetSha256 ||
        artifact.previewRevision !== manifest.runtime.previewRevision
      )
        throw new ConverterError(
          "CONVERTER_INTEGRITY",
          "body preview mismatch",
        );
      bytes = artifact.preview;
    }
    // Re-read after download/render/cache lookup. Changed body, pose, camera, catalog or runtime cannot win late.
    const current = await bodyPreviewManifest(owner, jobId, personIndex, deps);
    if (current.renderKey !== requestedKey)
      throw new BodyError("BODY_PREVIEW_STALE", 409);
    return new Response(bytes, {
      headers: {
        "Content-Type": format === "glb" ? "model/gltf-binary" : "image/png",
        "Cache-Control": "private, no-store",
        "X-Standin-Body-Render-Key": manifest.renderKey,
        "X-Standin-Body-Revision": String(manifest.selectionRevision),
        "X-Standin-Character-SHA256": manifest.resolvedBody.assetSha256,
        "X-Standin-Source-BVH-SHA256": candidate.sourceBvhSha256,
        "X-Standin-Preview-Revision": manifest.runtime.previewRevision,
        "X-Standin-Model-Revision": manifest.runtime.modelRevision,
        "X-Standin-Artifact-SHA256": sha256Hex(bytes),
      },
    });
  });
  return app;
}
