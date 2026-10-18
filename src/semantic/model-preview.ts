import { BodyError, bodyStore } from "../body-selection/store.js";
import { sameBody } from "../body-selection/model.js";
import { shapeRenderable, sameShapeSource } from "../body-selection/shape.js";
import { bodyUxAvailable } from "../body-selection/availability.js";
import { getPreviewRuntime } from "../converter/previewRuntime.js";
/** Owned text-result surfaces. Persisted body choices never grant export/refine. */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getOwnedJob } from "../jobs/store.js";
import { queryOne } from "../db.js";
import { getPoseBvh } from "../inference.js";
import { previewAssetBytes } from "../hands/preview.js";
import { HandError } from "../hands/model.js";
import { checkCharacter } from "../characters/service.js";
import {
  convertFramed,
  FramedArtifactCache,
  modelPreviewIdentity,
} from "../converter/framing.js";
import {
  getPreviewModel,
  matchesLibraryModel,
} from "../converter/previewModel.js";
import { ConverterError, sha256Hex } from "../converter/client.js";
import { errorEnvelope } from "../mapping.js";
import type { PrivatePreviewAsset } from "../pose-presentation.js";
import { tryConsume } from "../limits/store.js";
import { fixedWindow } from "../limits/policy.js";
export const SEMANTIC_CHARACTER_ID = "standin-master-v2";
const cache = new FramedArtifactCache(64 * 1024 * 1024, 300_000, 2);
const defaults = {
  getOwnedJob,
  bodyEnabled: bodyUxAvailable,
  shapeRenderable,
  selection: bodyStore.selection,
  getPreviewRuntime,
  getPoseBvh,
  checkCharacter,
  modelPreviewIdentity,
  getPreviewModel,
  convertFramed,
  consume: (owner: string) =>
    tryConsume(
      "semantic_model_preview",
      owner,
      fixedWindow(Date.now(), 60),
      20,
    ),
  loadAssets: async (
    job: string,
    index: number,
  ): Promise<Record<string, PrivatePreviewAsset>> => {
    const row = await queryOne<{ refine_context_json: string | null }>(
      "SELECT refine_context_json FROM analysis_people WHERE job_id=$1 AND person_index=$2",
      [job, index],
    );
    return (
      JSON.parse(row?.refine_context_json ?? "{}").posePresentationAssets ?? {}
    );
  },
};
export function createSemanticModelRoutes(
  overrides: Partial<typeof defaults> = {},
) {
  const deps = { ...defaults, ...overrides };
  const app = new Hono<AppEnv>();
  app.get(
    "/:job/people/:index/pose-previews/:candidate/:hash/model",
    async (c) => {
      const fail = (status: 400 | 404 | 409 | 429 | 503, code: string) =>
        c.json(
          errorEnvelope(
            code,
            "선택한 체형 모델을 불러오지 못했습니다. 다시 시도해 주세요.",
            c.get("requestId"),
          ),
          status,
        );
      const jobId = c.req.param("job"),
        index = Number(c.req.param("index")),
        id = c.req.param("candidate"),
        hash = c.req.param("hash"),
        owner = c.get("installationId")!;
      if (
        Object.keys(c.req.query()).some((k) => k !== "bodyRevision") ||
        (c.req.query("bodyRevision") !== undefined &&
          (!/^\d+$/.test(c.req.query("bodyRevision")!) ||
            !Number.isSafeInteger(Number(c.req.query("bodyRevision"))))) ||
        !/^\d+$/.test(c.req.param("index")) ||
        !Number.isSafeInteger(index) ||
        !/^preview_[a-f0-9]{64}$/.test(id) ||
        !/^[a-f0-9]{64}$/.test(hash)
      )
        return fail(400, "INVALID_INPUT");
      try {
        const job = await deps.getOwnedJob(jobId, owner);
        const presentation = job?.result?.candidatesByPerson.find(
          (p) => p.personIndex === index,
        )?.posePresentation;
        const candidate =
          presentation &&
          [
            ...presentation.library_candidates,
            ...presentation.review_candidates,
          ].find((p) => p.candidate_id === id);
        if (
          job?.status !== "completed" ||
          job.result?.source !== "semantic" ||
          presentation?.version !== "semantic-pose-presentation-v1" ||
          presentation.output_scope !== "full" ||
          !candidate ||
          candidate.source !== "library" ||
          candidate.asset.bvh_sha256 !== hash
        )
          return fail(404, "PREVIEW_UNAVAILABLE");
        const asset = (await deps.loadAssets(jobId, index))[id];
        if (
          !asset ||
          asset.transport !== "library_bvh" ||
          candidate.asset.transport !== asset.transport ||
          asset.pose_id !== candidate.pose_id ||
          asset.bvh_sha256 !== hash
        )
          return fail(409, "PREVIEW_SOURCE_CHANGED");
        const requestedRevision = c.req.query("bodyRevision");
        if (requestedRevision !== undefined && !deps.bodyEnabled())
          return fail(503, "BODY_SELECTION_DISABLED");
        const body =
          requestedRevision === undefined
            ? null
            : await deps.selection(owner, jobId, index);
        if (
          body &&
          (String(body.selectionRevision) !== requestedRevision ||
            body.resolutionStatus !== "ready" ||
            !body.resolvedBody)
        )
          return fail(409, "BODY_SELECTION_CONFLICT");
        if (body && !deps.shapeRenderable(body))
          return fail(409, "BODY_SHAPE_RENDER_UNSUPPORTED");
        const characterId =
          body?.resolvedBody?.characterId ?? SEMANTIC_CHARACTER_ID;
        if ((await deps.checkCharacter(characterId)) !== "ok")
          return fail(503, "PREVIEW_UNAVAILABLE");
        const identity = await deps.modelPreviewIdentity(characterId);
        if (!identity) return fail(503, "PREVIEW_UNAVAILABLE");
        if (
          body?.resolvedBody &&
          identity.characterSha256 !== body.resolvedBody.assetSha256
        )
          return fail(409, "BODY_UNAVAILABLE");
        const runtime = body ? await deps.getPreviewRuntime() : null;
        if (!(await deps.consume(owner))) return fail(429, "RATE_LIMITED");
        const bvhBytes = await previewAssetBytes(asset, deps.getPoseBvh);
        let data: Uint8Array | undefined,
          version = "posed-mesh-v1";
        try {
          if (body?.shape)
            throw new ConverterError(
              "PREVIEW_NOT_READY",
              "shaped surface needs render",
            );
          const library = await deps.getPreviewModel(hash, characterId);
          if (
            !matchesLibraryModel(
              library,
              hash,
              characterId,
              identity.characterSha256,
            )
          )
            return fail(503, "PREVIEW_UNAVAILABLE");
          const meta = JSON.parse(
            library
              .subarray(20, 20 + library.readUInt32LE(12))
              .toString("utf8"),
          ).asset.extras;
          if (meta.revision === identity.modelRevision) data = library;
        } catch (e) {
          // Only a missing precomputed surface may queue a fixed-body render.
          if (!(e instanceof ConverterError) || e.code !== "PREVIEW_NOT_READY")
            throw e;
        }
        if (!data) {
          version = "framed-mesh-v1";
          const artifact = await cache.get(
            JSON.stringify([
              owner,
              jobId,
              index,
              id,
              hash,
              characterId,
              identity,
              body,
              runtime,
            ]),
            () =>
              deps.convertFramed({
                bvhBytes,
                characterId,
                scope: "full",
                previewFormat: "model",
                ...identity,
                expectedCharacterSha256: identity.characterSha256,
                ...(body
                  ? {
                      shape: body.shape,
                      shapeSource: body.shapeSource,
                      expectedPreviewRevision: runtime!.previewRevision,
                    }
                  : {}),
              }),
          );
          data = artifact.preview;
        }
        const current = await deps.getOwnedJob(jobId, owner);
        const live = current?.result?.candidatesByPerson.find(
          (p) => p.personIndex === index,
        )?.posePresentation;
        if (
          current?.status !== "completed" ||
          current.result?.source !== "semantic" ||
          live?.output_scope !== "full" ||
          ![...live.library_candidates, ...live.review_candidates].some(
            (p) => p.candidate_id === id && p.asset.bvh_sha256 === hash,
          )
        )
          return fail(409, "PREVIEW_SOURCE_CHANGED");
        const after = await deps.modelPreviewIdentity(characterId);
        if (
          !after ||
          after.characterSha256 !== identity.characterSha256 ||
          after.modelRevision !== identity.modelRevision
        )
          return fail(409, "PREVIEW_SOURCE_CHANGED");
        if (body) {
          const liveBody = await deps.selection(owner, jobId, index);
          if (
            liveBody.selectionRevision !== body.selectionRevision ||
            liveBody.resolutionStatus !== "ready" ||
            !liveBody.resolvedBody ||
            !sameBody(liveBody.resolvedBody, body.resolvedBody!) ||
            (liveBody.shape?.shapeSha256 ?? null) !==
              (body.shape?.shapeSha256 ?? null) ||
            (body.shape &&
              !sameShapeSource(body.shapeSource, liveBody.shapeSource))
          )
            return fail(409, "BODY_SELECTION_CONFLICT");
          const liveRuntime = await deps.getPreviewRuntime();
          if (JSON.stringify(liveRuntime) !== JSON.stringify(runtime))
            return fail(409, "PREVIEW_SOURCE_CHANGED");
        }
        return new Response(data, {
          headers: {
            "Content-Type": "model/gltf-binary",
            "Cache-Control": "private, no-store",
            "X-Standin-Preview-Only": "true",
            ...(body
              ? {
                  "X-Standin-Body-Revision": String(body.selectionRevision),
                  "X-Standin-Body-Shape-SHA256":
                    body.shape?.shapeSha256 ?? "none",
                }
              : {}),
            "X-Standin-Character-Id": characterId,
            "X-Standin-Model-Version": version,
            "X-Standin-Source-BVH-SHA256": hash,
            "X-Standin-Character-SHA256": identity.characterSha256,
            "X-Standin-Model-Revision": identity.modelRevision,
            "X-Standin-Artifact-SHA256": sha256Hex(data),
          },
        });
      } catch (e) {
        return e instanceof HandError || e instanceof BodyError
          ? fail(e.status, e.code)
          : fail(503, "PREVIEW_UNAVAILABLE");
      }
    },
  );
  return app;
}
