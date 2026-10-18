import { resolvePersonOutputScope } from "../output-scope/model.js";
import { validateRenderCamera } from "../pose-presentation.js";
/** PNG-only lookup of selected hands. Never returns FBX or promotes a pose's permissions. */
import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { AppEnv } from "../env.js";
import { getOwnedJob } from "../jobs/store.js";
import { queryOne } from "../db.js";
import { getPoseBvh } from "../inference.js";
import { config } from "../config.js";
import { convertFramed, FramedArtifactCache } from "../converter/framing.js";
import { checkCharacter } from "../characters/service.js";
import { handStore } from "./store.js";
import { handBakeFor } from "./service.js";
import { HandError } from "./model.js";
import { errorEnvelope } from "../mapping.js";
import type { PrivatePreviewAsset } from "../pose-presentation.js";
import { tryConsume } from "../limits/store.js";
import { fixedWindow } from "../limits/policy.js";
const cache = new FramedArtifactCache(64 * 1024 * 1024, 300_000, 4);
const defaults = {
  getOwnedJob,
  getPoseBvh,
  selection: handStore.selection,
  handBakeFor,
  convertFramed,
  checkCharacter,
  characterId: () => config.converterCharacterId,
  consume: (owner: string) =>
    tryConsume("hand_preview", owner, fixedWindow(Date.now(), 60), 6),
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
export async function previewAssetBytes(
  asset: PrivatePreviewAsset,
  fetchBvh: typeof getPoseBvh,
) {
  let bytes: Uint8Array;
  if (asset.transport === "inline_bvh")
    bytes = Buffer.from(asset.bvh ?? "", "utf8");
  else {
    if (!asset.pose_id)
      throw new HandError(
        "PREVIEW_UNAVAILABLE",
        409,
        "미리보기를 확인해 주세요.",
      );
    const r = await fetchBvh(asset.pose_id),
      reader = r.body?.getReader();
    if (
      !r.ok ||
      !reader ||
      Number(r.headers.get("Content-Length")) > 2_000_000
    ) {
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      } else await r.body?.cancel().catch(() => {});
      throw new HandError(
        "PREVIEW_UNAVAILABLE",
        409,
        "미리보기를 확인해 주세요.",
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const n = await reader.read();
        if (n.done) break;
        size += n.value.length;
        if (size > 2_000_000)
          throw new HandError(
            "PREVIEW_UNAVAILABLE",
            409,
            "미리보기를 확인해 주세요.",
          );
        chunks.push(n.value);
      }
      bytes = Buffer.concat(chunks);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  if (
    !bytes.length ||
    bytes.length > 2_000_000 ||
    createHash("sha256").update(bytes).digest("hex") !== asset.bvh_sha256
  )
    throw new HandError(
      "PREVIEW_SOURCE_CHANGED",
      409,
      "원본 미리보기가 변경되었습니다.",
    );
  return bytes;
}
export function createHandPreviewRoutes(
  overrides: Partial<typeof defaults> = {},
) {
  const deps = { ...defaults, ...overrides };
  const app = new Hono<AppEnv>();
  app.get(
    "/:job/people/:index/pose-previews/:candidate/:hash/hands",
    async (c) => {
      const fail = (status: 400 | 404 | 409 | 429 | 503, code: string) =>
        c.json(
          errorEnvelope(
            code,
            "손 미리보기를 확인하지 못했습니다.",
            c.get("requestId"),
          ),
          status,
        );
      const jobId = c.req.param("job"),
        index = Number(c.req.param("index")),
        id = c.req.param("candidate"),
        hash = c.req.param("hash"),
        owner = c.get("installationId")!;
      const revision = c.req.query("revision");
      if (Object.keys(c.req.query()).some((key) => key !== "revision"))
        return fail(400, "INVALID_INPUT");
      if (
        !/^\d+$/.test(c.req.param("index")) ||
        !Number.isSafeInteger(index) ||
        !/^preview_[a-f0-9]{64}$/.test(id) ||
        !/^[a-f0-9]{64}$/.test(hash) ||
        !revision ||
        !/^\d+$/.test(revision)
      )
        return fail(400, "INVALID_INPUT");
      try {
        const job = await deps.getOwnedJob(jobId, owner),
          person = job?.result?.candidatesByPerson.find(
            (p) => p.personIndex === index,
          );
        const presentation = person?.posePresentation;
        const candidate =
          presentation &&
          [
            ...presentation.library_candidates,
            ...presentation.review_candidates,
            ...presentation.generated_candidates,
          ].find((p) => p.candidate_id === id);
        if (
          job?.status !== "completed" ||
          !candidate ||
          candidate.asset.bvh_sha256 !== hash
        )
          return fail(404, "PREVIEW_UNAVAILABLE");
        const asset = (await deps.loadAssets(jobId, index))[id];
        if (
          !asset ||
          asset.bvh_sha256 !== hash ||
          asset.pose_id !== candidate.pose_id ||
          asset.transport !== candidate.asset.transport
        )
          return fail(409, "PREVIEW_SOURCE_CHANGED");
        const selection = await deps.selection(owner, jobId, index);
        if (String(selection.revision) !== revision)
          return fail(409, "HANDS_CHANGED");
        const hands = await deps.handBakeFor({ handSelection: selection });
        if (!hands) return fail(409, "HANDS_CHANGED");
        const scope = resolvePersonOutputScope(person).resolved;
        if (
          !["full", "half", "bust", "shoulder_head", "head"].includes(
            scope ?? "",
          )
        )
          return fail(409, "PREVIEW_UNAVAILABLE");
        const characterId = deps.characterId();
        if ((await deps.checkCharacter(characterId)) !== "ok")
          return fail(503, "HANDS_UNAVAILABLE");
        if (!(await deps.consume(owner))) return fail(429, "RATE_LIMITED");
        const bvhBytes = await previewAssetBytes(asset, deps.getPoseBvh);
        const key = JSON.stringify([
          "hand-lookup",
          owner,
          jobId,
          index,
          id,
          hash,
          hands,
          characterId,
          scope,
          candidate.render_camera,
        ]);
        const artifact = await cache.get(key, () =>
          deps.convertFramed({
            bvhBytes,
            characterId,
            scope,
            cameraRotation: validateRenderCamera(candidate.render_camera)
              .rotation,
            hands,
          }),
        );
        const current = await deps.getOwnedJob(jobId, owner);
        const livePerson = current?.result?.candidatesByPerson.find(
          (p) => p.personIndex === index,
        );
        const live = livePerson?.posePresentation;
        if (
          current?.status !== "completed" ||
          !live ||
          ![
            ...live.library_candidates,
            ...live.review_candidates,
            ...live.generated_candidates,
          ].some((p) => p.candidate_id === id && p.asset.bvh_sha256 === hash) ||
          resolvePersonOutputScope(livePerson).resolved !== scope ||
          JSON.stringify(
            [
              ...live.library_candidates,
              ...live.review_candidates,
              ...live.generated_candidates,
            ].find((p) => p.candidate_id === id)?.render_camera,
          ) !== JSON.stringify(candidate.render_camera)
        )
          return fail(409, "PREVIEW_SOURCE_CHANGED");
        const after = await deps.selection(owner, jobId, index);
        if (
          after.revision !== selection.revision ||
          after.library_sha256 !== selection.library_sha256 ||
          after.left !== selection.left ||
          after.right !== selection.right
        )
          return fail(409, "HANDS_CHANGED");
        await deps.handBakeFor({ handSelection: after }); // Fresh inference/converter library agreement.
        return new Response(artifact.preview, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "private, no-store",
            "X-Standin-Hand-Revision": revision,
            "X-Standin-Output-Scope": scope,
            "X-Standin-Hand-Library-SHA256": selection.library_sha256,
            "X-Standin-Preview-Only": "true",
          },
        });
      } catch (e) {
        return e instanceof HandError
          ? fail(e.status, e.code)
          : fail(503, "HANDS_UNAVAILABLE");
      }
    },
  );
  return app;
}
