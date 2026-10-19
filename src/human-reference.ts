import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import { getDefaultBodyTemplate, getPoseBvh } from "./inference.js";
import { getOwnedJob } from "./jobs/store.js";
import { previewScope } from "./output-scope/preview.js";
import { sha256Hex } from "./converter/client.js";
import { errorEnvelope } from "./mapping.js";
const scopes = new Set(["full", "half", "bust", "shoulder_head", "head"]);
const defaultSha =
  "7c648b97a24a3bb4914b6e5d515708c33727979881d92ef916d5726e22301f3d";
async function bounded(response: Response, max: number) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("empty reference");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const p = await reader.read();
      if (p.done) break;
      size += p.value.length;
      if (size > max) throw Error("reference too large");
      chunks.push(p.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
const defaults = { getOwnedJob, getPoseBvh, getDefaultBodyTemplate };
export function createHumanReferenceRoutes(
  overrides: Partial<typeof defaults> = {},
) {
  const deps = { ...defaults, ...overrides };
  const routes = new Hono<AppEnv>();
  routes.get("/default-body-template/:scope", async (c) => {
    const fail = () =>
      c.json(
        errorEnvelope(
          "PREVIEW_UNAVAILABLE",
          "기본 인체 참고를 불러오지 못했습니다.",
          c.get("requestId"),
        ),
        404,
      );
    if (!c.get("installationId") || !scopes.has(c.req.param("scope")))
      return fail();
    const response = await deps.getDefaultBodyTemplate(c.req.param("scope"));
    const h = response.headers;
    if (
      !response.ok ||
      h.get("Content-Type") !== "application/gzip" ||
      h.get("X-Standin-Template-Version") !== "default-body-template-v1" ||
      h.get("X-Standin-Preview-Only") !== "true" ||
      h.get("X-Standin-Character-Id") !== "standin-master-v2" ||
      h.get("X-Standin-Character-SHA256") !== defaultSha ||
      h.get("X-Standin-Output-Scope") !== c.req.param("scope") ||
      h.get("X-Standin-Preview-Method") !== "reference-skinning-v1" ||
      !/^[a-f0-9]{64}$/.test(h.get("X-Standin-Template-JSON-SHA256") ?? "")
    ) {
      await response.body?.cancel();
      return fail();
    }
    try {
      const data = await bounded(response, 2_000_000);
      if (
        data[0] !== 31 ||
        data[1] !== 139 ||
        sha256Hex(data) !== h.get("X-Standin-Artifact-SHA256")
      )
        return fail();
      const headers = new Headers({
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Cache-Control": "private, max-age=86400",
      });
      for (const [name, value] of h)
        if (name.startsWith("x-standin-")) headers.set(name, value);
      headers.set(
        "X-Standin-Template-SHA256",
        h.get("X-Standin-Artifact-SHA256")!,
      );
      headers.set(
        "X-Standin-Artifact-SHA256",
        h.get("X-Standin-Template-JSON-SHA256")!,
      );
      return new Response(data, { headers });
    } catch {
      return fail();
    }
  });
  routes.get("/:id/poster-source", async (c) => {
    const fail = (status: 404 | 409 = 404) =>
      c.json(
        errorEnvelope(
          status === 409 ? "PREVIEW_SOURCE_CHANGED" : "PREVIEW_UNAVAILABLE",
          "인체 포즈 참고를 확인하지 못했습니다.",
          c.get("requestId"),
        ),
        status,
      );
    const owner = c.get("installationId"),
      jobId = c.req.query("jobId") ?? "",
      index = c.req.query("personIndex") ?? "";
    if (
      !owner ||
      !/^(0|[1-9]\d*)$/.test(index) ||
      !Number.isSafeInteger(Number(index))
    )
      return fail();
    const read = () => deps.getOwnedJob(jobId, owner);
    const find = (job: Awaited<ReturnType<typeof read>>) => {
      const person =
        job?.status === "completed"
          ? job.result?.candidatesByPerson.find(
              (p) => p.personIndex === Number(index),
            )
          : undefined;
      const candidate = person?.candidates.find(
        (p) =>
          p.id === c.req.query("candidateId") && p.poseId === c.req.param("id"),
      );
      return person && candidate ? { person, candidate } : undefined;
    };
    const first = find(await read());
    if (!first || first.candidate.lookupAllowed === false) return fail();
    const snapshot = JSON.stringify(first.candidate);
    const scope = previewScope(first.person);
    if (c.req.query("scope") !== scope) return fail(409);
    const response = await deps.getPoseBvh(first.candidate.poseId);
    if (!response.ok) {
      await response.body?.cancel();
      return fail();
    }
    try {
      const source = await bounded(response, 2_000_000),
        hash = sha256Hex(source);
      const expected =
        first.candidate.sourceBvhSha256 ??
        first.candidate.camera?.source_bvh_sha256;
      if (expected && expected !== hash) return fail(409);
      const current = find(await read());
      if (
        !current ||
        previewScope(current.person) !== scope ||
        JSON.stringify(current.candidate) !== snapshot
      )
        return fail(409);
      return new Response(source, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Standin-Source-BVH-SHA256": hash,
          "X-Standin-Output-Scope": scope,
          "X-Standin-Preview-Only": "true",
        },
      });
    } catch {
      return fail();
    }
  });
  return routes;
}
