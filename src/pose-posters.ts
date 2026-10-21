import { previewScope } from "./output-scope/preview.js";
/** Canonical, read-only references. No converter calls or selection writes. */
import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import { getOwnedJob } from "./jobs/store.js";
import { getPoseBvh, getPosePoster } from "./inference.js";
import { sha256Hex } from "./converter/client.js";
import { BodyError } from "./body-selection/store.js";
import { errorEnvelope } from "./mapping.js";
import {
  POSTER_VARIANT,
  posterCamera,
  posterOptions,
  annotatePoster,
  type PosterOptions,
} from "./poster-yaw.js";

export async function verifiedPoster(
  poseId: string,
  source: string,
  get = getPosePoster,
  scope = "full",
  options?: PosterOptions,
): Promise<Response> {
  const response = await get(poseId, source, scope, options);
  const fail = () => new BodyError("PREVIEW_UNAVAILABLE", 404);
  if (!response.ok) {
    await response.body?.cancel();
    throw fail();
  }
  const kind = response.headers.get("X-Standin-Poster-Kind");
  const character = response.headers.get("X-Standin-Character-Id");
  const sha = response.headers.get("X-Standin-Character-SHA256");
  const native =
    response.headers.get("X-Standin-Preview-Method") ===
    "frozen-native-scope8-v1";
  const media = native ? "image/jpeg" : "image/png";
  if (
    response.headers.get("Content-Type") !== media ||
    response.headers.get("X-Standin-Poster-Version") !==
      "default-body-poster-v1" ||
    response.headers.get("X-Standin-Source-BVH-SHA256") !== source ||
    response.headers.get("X-Standin-Output-Scope") !== scope ||
    response.headers.get("X-Standin-Preview-Projection") !== "orthographic" ||
    response.headers.get("X-Standin-Preview-Only") !== "true" ||
    !/^[a-f0-9]{64}$/.test(
      response.headers.get("X-Standin-Preview-Revision") ?? "",
    ) ||
    !(
      (kind === "default-body" &&
        character === "standin-master-v2" &&
        /^[a-f0-9]{64}$/.test(sha ?? "")) ||
      (kind === "pose-only" && character === "none" && sha === "none")
    )
  ) {
    await response.body?.cancel();
    throw fail();
  }
  const method = response.headers.get("X-Standin-Preview-Method");
  if (
    (method &&
      ![
        "frozen-retarget-v1",
        "pose-only",
        "reference-skinning-v1",
        "frozen-native-scope8-v1",
      ].includes(method)) ||
    (method === "pose-only" && kind !== "pose-only") ||
    (method === "frozen-retarget-v1" && kind !== "default-body") ||
    (method === "reference-skinning-v1" &&
      (kind !== "default-body" ||
        sha !==
          "7c648b97a24a3bb4914b6e5d515708c33727979881d92ef916d5726e22301f3d" ||
        !/^[a-f0-9]{64}$/.test(
          response.headers.get("X-Standin-Template-SHA256") ?? "",
        )))
  ) {
    await response.body?.cancel();
    throw fail();
  }
  if (options) {
    const served = response.headers.get("X-Standin-Poster-Yaw");
    const reason = response.headers.get("X-Standin-Poster-Fallback");
    const expected = String(Number(options.view.slice(4)));
    if (
      response.headers.get("X-Standin-Poster-Variant") !== POSTER_VARIANT ||
      response.headers.get("X-Standin-Projection-Matches-Search") !== "false" ||
      kind !== "default-body" ||
      ![
        "none",
        "missing_angle",
        "missing_directional_asset",
        "unsupported_scope",
      ].includes(reason ?? "") ||
      (reason === "none" ? served !== expected : served !== "0") ||
      (native &&
        (sha !==
          "7c648b97a24a3bb4914b6e5d515708c33727979881d92ef916d5726e22301f3d" ||
          response.headers.get("X-Standin-Preview-View") !==
            `yaw_${String((360 - Number(served)) % 360).padStart(3, "0")}` ||
          response.headers.get("X-Standin-Poster-Asset-Version") !==
            "scope8-v1" ||
          !/^lib-\d{8}-[a-f0-9]{8}$/.test(
            response.headers.get("X-Standin-Asset-Library-Version") ?? "",
          )))
    ) {
      await response.body?.cancel();
      throw fail();
    }
  } else if (native) {
    await response.body?.cancel();
    throw fail();
  }
  const reader = response.body?.getReader();
  if (!reader) throw fail();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const p = await reader.read();
      if (p.done) break;
      size += p.value.length;
      if (size > 2 * 1024 * 1024) throw fail();
      chunks.push(p.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const image = Buffer.concat(chunks);
  if (
    !(native
      ? image.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : image
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    sha256Hex(image) !== response.headers.get("X-Standin-Artifact-SHA256")
  )
    throw fail();
  const headers = new Headers({
    "Content-Type": media,
    "Cache-Control": "private, no-store",
  });
  for (const [name, value] of response.headers)
    if (name.startsWith("x-standin-")) headers.set(name, value);
  return new Response(image, { headers });
}

const defaults = { getOwnedJob, getPoseBvh, getPosePoster };
export function createDefaultPosterRoutes(
  overrides: Partial<typeof defaults> = {},
) {
  const deps = { ...defaults, ...overrides };
  const routes = new Hono<AppEnv>();
  routes.get("/:id/poster", async (c) => {
    const fail = (code = "PREVIEW_UNAVAILABLE", status: 404 | 409 = 404) =>
      c.json(
        errorEnvelope(
          code,
          "참고 이미지를 불러오지 못했습니다.",
          c.get("requestId"),
        ),
        status,
      );
    const owner = c.get("installationId");
    const jobId = c.req.query("jobId") ?? "";
    const raw = c.req.query("personIndex") ?? "";
    if (
      !owner ||
      !/^(0|[1-9]\d*)$/.test(raw) ||
      !Number.isSafeInteger(Number(raw))
    )
      return fail();
    const read = () => deps.getOwnedJob(jobId, owner);
    const find = (job: Awaited<ReturnType<typeof read>>) =>
      job?.status === "completed"
        ? job.result?.candidatesByPerson
            .find((p) => p.personIndex === Number(raw))
            ?.candidates.find(
              (candidate) =>
                candidate.id === c.req.query("candidateId") &&
                candidate.poseId === c.req.param("id"),
            )
        : undefined;
    const job = await read();
    const person = job?.result?.candidatesByPerson.find(
      (p) => p.personIndex === Number(raw),
    );
    const candidate = find(job);
    if (
      !person ||
      !candidate ||
      !candidate.poseId ||
      candidate.lookupAllowed === false
    )
      return fail();
    const candidateSnapshot = JSON.stringify(candidate);
    const scope = previewScope(person);
    const variant = c.req.query("variant");
    if (variant && variant !== POSTER_VARIANT) return fail();
    const p = person.posePresentation;
    const row =
      p &&
      [
        ...p.library_candidates,
        ...p.review_candidates,
        ...p.generated_candidates,
      ].find(
        (x) =>
          x.candidate_id === candidate.id &&
          x.asset.bvh_sha256 === candidate.sourceBvhSha256,
      );
    const camera = posterCamera(row);
    const options = variant ? posterOptions(camera) : undefined;
    if (c.req.query("view") && c.req.query("view") !== options?.view)
      return fail("PREVIEW_SOURCE_CHANGED", 409);
    if (c.req.query("scope") && c.req.query("scope") !== scope)
      return fail("PREVIEW_SOURCE_CHANGED", 409);
    const sourceResponse = await deps.getPoseBvh(candidate.poseId);
    if (!sourceResponse.ok) {
      await sourceResponse.body?.cancel();
      return fail();
    }
    const reader = sourceResponse.body?.getReader();
    if (!reader) return fail();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2_000_000) return fail();
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const source = Buffer.concat(chunks);
    const hash = sha256Hex(source);
    const expected =
      candidate.sourceBvhSha256 ?? candidate.camera?.source_bvh_sha256;
    if (expected && expected !== hash)
      return fail("PREVIEW_SOURCE_CHANGED", 409);
    try {
      const response = await verifiedPoster(
        candidate.poseId,
        hash,
        deps.getPosePoster,
        scope,
        options,
      );
      const currentJob = await read();
      const currentPerson = currentJob?.result?.candidatesByPerson.find(
        (p) => p.personIndex === Number(raw),
      );
      if (!currentPerson || previewScope(currentPerson) !== scope)
        return fail("PREVIEW_SOURCE_CHANGED", 409);
      const currentPresentation = currentPerson.posePresentation;
      const currentRow =
        currentPresentation &&
        [
          ...currentPresentation.library_candidates,
          ...currentPresentation.review_candidates,
          ...currentPresentation.generated_candidates,
        ].find(
          (x) =>
            x.candidate_id === candidate.id &&
            x.asset.bvh_sha256 === candidate.sourceBvhSha256,
        );
      if (
        options &&
        JSON.stringify(posterCamera(currentRow)) !== JSON.stringify(camera)
      )
        return fail("PREVIEW_SOURCE_CHANGED", 409);
      const current = find(currentJob);
      if (!current || JSON.stringify(current) !== candidateSnapshot)
        return fail("PREVIEW_SOURCE_CHANGED", 409);
      return options ? annotatePoster(response, camera) : response;
    } catch {
      return fail();
    }
  });
  return routes;
}
