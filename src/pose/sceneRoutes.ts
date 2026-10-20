import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getOwnedJob } from "../jobs/store.js";
import { validateConfirmedSelection } from "../analytics/store.js";
import { config } from "../config.js";
import {
  ConverterError,
  converterEnabled,
  sha256Hex,
} from "../converter/client.js";
import { composeRoughScene, type SceneSource } from "../converter/scene.js";
import { errorEnvelope } from "../mapping.js";

const defaults = {
  getOwnedJob,
  validateConfirmedSelection,
  composeRoughScene,
  enabled: () => config.sceneExportEnabled && converterEnabled(),
};
export function createSceneRoutes(
  dispatch: (request: Request) => Response | Promise<Response>,
  overrides: Partial<typeof defaults> = {},
) {
  const deps = { ...defaults, ...overrides };
  const routes = new Hono<AppEnv>();
  routes.post("/:jobId/scene", async (c) => {
    const fail = (
      status: 400 | 409 | 502 | 503 | 504,
      code: string,
      message: string,
    ) => c.json(errorEnvelope(code, message, c.get("requestId")), status);
    if (!deps.enabled())
      return fail(
        503,
        "SCENE_UNAVAILABLE",
        "지금은 장면 FBX 저장을 사용할 수 없습니다.",
      );
    const owner = c.get("installationId")!,
      jobId = c.req.param("jobId");
    let value: unknown;
    try {
      value = await c.req.json();
    } catch {
      return fail(400, "INVALID_INPUT", "저장할 인물을 다시 선택해 주세요.");
    }
    const input = value as { persons?: unknown } | null;
    if (
      !input ||
      !Array.isArray(input.persons) ||
      input.persons.length < 1 ||
      input.persons.length > 8
    )
      return fail(
        400,
        "INVALID_INPUT",
        "한 장면에는 1~8명을 저장할 수 있습니다.",
      );
    const job = await deps.getOwnedJob(jobId, owner);
    if (
      !job?.result?.image ||
      job.status !== "completed" ||
      job.result.source === "semantic"
    )
      return fail(
        409,
        "SCENE_OBSERVATION_MISSING",
        "러프의 인물 위치를 찾지 못했습니다. 다시 분석해 주세요.",
      );
    const image = job.result.image;
    const seen = new Set<number>();
    const refs: {
      personIndex: number;
      candidateId: string;
      exportPath: string;
      sha256: string;
    }[] = [];
    const sources: SceneSource[] = [];
    try {
      for (const raw of input.persons) {
        const row = raw as (typeof refs)[number];
        if (
          !row ||
          !Number.isInteger(row.personIndex) ||
          seen.has(row.personIndex) ||
          typeof row.candidateId !== "string" ||
          typeof row.exportPath !== "string" ||
          typeof row.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.sha256)
        )
          return fail(
            400,
            "INVALID_INPUT",
            "저장할 인물 정보가 올바르지 않습니다.",
          );
        seen.add(row.personIndex);
        const person = job.result.candidatesByPerson.find(
          (p) => p.personIndex === row.personIndex,
        );
        const candidate = person?.candidates.find(
          (p) => p.id === row.candidateId,
        );
        if (
          !person ||
          !candidate ||
          !person.box ||
          person.box.length !== 4 ||
          !(await deps.validateConfirmedSelection(
            owner,
            jobId,
            row.personIndex,
            row.candidateId,
          ))
        )
          return fail(
            409,
            "INVALID_EXPORT",
            "확정한 인물과 후보를 다시 확인해 주세요.",
          );
        // Local dispatch reuses every existing body/hand/scope/review/lineage guard.
        // This is never a network request to a client-supplied URL.
        const url = new URL(row.exportPath, "https://scene.internal");
        const prefix = `/v1/pose-candidates/${encodeURIComponent(candidate.poseId)}/`;
        if (
          url.origin !== "https://scene.internal" ||
          !row.exportPath.startsWith("/v1/") ||
          url.hash ||
          ![prefix + "framed", prefix + "export"].includes(url.pathname) ||
          Object.keys(Object.fromEntries(url.searchParams)).some(
            (key) => url.searchParams.getAll(key).length !== 1,
          ) ||
          url.searchParams.get("jobId") !== jobId ||
          url.searchParams.get("personIndex") !== String(row.personIndex) ||
          url.searchParams.get("candidateId") !== row.candidateId ||
          url.searchParams.get("format") !== "fbx"
        )
          return fail(400, "INVALID_INPUT", "확인한 FBX 저장 경로가 아닙니다.");
        const headers = new Headers();
        for (const key of ["X-Installation-Id", "X-Device-Token"])
          if (c.req.header(key)) headers.set(key, c.req.header(key)!);
        const response = await dispatch(new Request(url, { headers }));
        if (!response.ok)
          return new Response(response.body, {
            status: response.status,
            headers: response.headers,
          });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 32 * 1024 * 1024 || sha256Hex(bytes) !== row.sha256)
          return fail(
            409,
            "SCENE_SOURCE_CHANGED",
            "확인한 파일이 바뀌었습니다. 저장 전 확인으로 돌아가 주세요.",
          );
        const [x1, y1, x2, y2] = person.box;
        const box = [
          Math.max(0, x1!),
          Math.max(0, y1!),
          Math.min(image.width, x2!),
          Math.min(image.height, y2!),
        ];
        sources.push({
          person_index: row.personIndex,
          bytes,
          observation: {
            box,
            keypoints:
              person.skeleton?.keypoints ??
              Array.from({ length: 17 }, () => [0, 0]),
            scores: person.skeleton?.scores ?? (Array(17).fill(0) as number[]),
          },
        });
        refs.push(row);
      }
      const scene = await deps.composeRoughScene(jobId, image, sources);
      const current = await deps.getOwnedJob(jobId, owner);
      if (
        !current ||
        current.updatedAt !== job.updatedAt ||
        current.status !== "completed" ||
        !(
          await Promise.all(
            refs.map((r) =>
              deps.validateConfirmedSelection(
                owner,
                jobId,
                r.personIndex,
                r.candidateId,
              ),
            ),
          )
        ).every(Boolean)
      )
        return fail(
          409,
          "SCENE_SOURCE_CHANGED",
          "작업이 변경되었습니다. 후보 화면에서 다시 확인해 주세요.",
        );
      // Body/hand revisions live outside the job row. Re-authorize pinned
      // downloads after composition as well; stale reviews cannot be released.
      for (const ref of refs) {
        const headers = new Headers();
        for (const key of ["X-Installation-Id", "X-Device-Token"])
          if (c.req.header(key)) headers.set(key, c.req.header(key)!);
        const response = await dispatch(
          new Request(new URL(ref.exportPath, "https://scene.internal"), {
            headers,
          }),
        );
        if (!response.ok)
          return new Response(response.body, {
            status: response.status,
            headers: response.headers,
          });
        if (
          sha256Hex(new Uint8Array(await response.arrayBuffer())) !== ref.sha256
        )
          return fail(
            409,
            "SCENE_SOURCE_CHANGED",
            "확인한 체형이나 손이 바뀌었습니다. 다시 확인해 주세요.",
          );
      }
      return new Response(scene.bytes, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "private, no-store",
          "X-Standin-Artifact-SHA256": scene.sha256,
          "X-Standin-Person-Count": String(sources.length),
          "X-Standin-Scene-Version": "rough-layout-v1",
          "Content-Disposition": 'attachment; filename="standin_scene.fbx"',
        },
      });
    } catch (e) {
      const code = e instanceof ConverterError ? e.code : "SCENE_FAILED";
      return fail(
        code === "CONVERTER_TIMEOUT"
          ? 504
          : code === "CONVERTER_UNAVAILABLE"
            ? 503
            : 502,
        code,
        "장면 FBX를 만들지 못했습니다. 다시 시도해 주세요.",
      );
    }
  });
  return routes;
}
