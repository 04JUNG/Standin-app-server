// refine 미리보기를 **refine 응답 밖에서** 그린다.
//
// 예전에는 추론 서버가 `/refine` 안에서 전환기로 미리보기를 그렸다. 그게 20초쯤 걸리는데
// BFF는 `/refine`을 5초에 끊는다(인프라 `REFINE_TIMEOUT_MS`). 그래서 미리보기가 안 나오는
// 정도가 아니라, 조정 결과까지 `upstream_unavailable`로 버려졌다(2026-10-08 staging 로그:
// 5.003초에 끊김, 추론은 20.04초에 썸네일 포기).
//
// 이제 refine은 미리보기 없이 빨리 끝나고, 미리보기는 처음 볼 때 여기서 그려 S3에 둔다.
// 한 번 그리면 다음부터는 저장된 것을 쓴다.
//
// 일부러 refine 직후 백그라운드로 그리지 않는다. 전환기는 한 번에 한 건만 처리하므로,
// 아무도 보지 않을 미리보기가 사용자의 FBX 내보내기 앞을 20초씩 막게 된다.

import { config } from "../config.js";
import { renderThumbnail } from "../converter/client.js";
import { convertFramed } from "../converter/framing.js";
import { queryOne } from "../db.js";
import { log } from "../log.js";
import {
  getRefinedBvh,
  getRefinedThumbnail,
  putRefinedThumbnail,
  refinedThumbnailObjectKey,
} from "../refineStorage.js";
import { findRefinedArtifact, loadCandidate, saveRefinedArtifact } from "./store.js";

export interface ThumbnailDeps {
  findRefinedArtifact: typeof findRefinedArtifact;
  loadCandidate: typeof loadCandidate;
  saveRefinedArtifact: typeof saveRefinedArtifact;
  getRefinedBvh: typeof getRefinedBvh;
  getRefinedThumbnail: typeof getRefinedThumbnail;
  putRefinedThumbnail: typeof putRefinedThumbnail;
  installationOf: (jobId: string) => Promise<string | null>;
  renderView: (bvh: Uint8Array, view: string) => Promise<Uint8Array>;
  renderCamera: (bvh: Uint8Array, rotation: number[][]) => Promise<Uint8Array>;
  now: () => number;
}

async function installationOf(jobId: string): Promise<string | null> {
  const row = await queryOne<{ installation_id: string | null }>(
    "SELECT installation_id FROM jobs WHERE id = $1",
    [jobId],
  );
  return row?.installation_id ?? null;
}

function defaultDeps(): ThumbnailDeps {
  return {
    findRefinedArtifact,
    loadCandidate,
    saveRefinedArtifact,
    getRefinedBvh,
    getRefinedThumbnail,
    putRefinedThumbnail,
    installationOf,
    renderView: (bvh, view) => renderThumbnail({ bvhBytes: bvh, view }),
    // 후보에 카메라가 붙어 있으면 그 카메라로 그려야 "저장될 포즈"와 같은 각도가 된다.
    // 추론이 하던 것과 같은 경로(`/convert-framed`)다.
    renderCamera: async (bvh, rotation) =>
      (
        await convertFramed({
          bvhBytes: bvh,
          characterId: config.converterCharacterId,
          scope: "full",
          cameraRotation: rotation,
        })
      ).preview,
    now: () => Date.now(),
  };
}

/** 같은 미리보기를 동시에 두 번 그리지 않는다. 전환기는 한 번에 한 건만 처리한다. */
const inflight = new Map<string, Promise<Uint8Array | null>>();

/**
 * 조정본의 미리보기 PNG. 저장돼 있으면 그것을, 없으면 그려서 저장하고 돌려준다.
 *
 * 조정하지 않은 후보(refined=false)는 null이다 — 그때 맞는 그림은 라이브러리 후보 썸네일이고,
 * 화면이 이미 그것을 보여 준다. 그리다 실패해도 null이고, 다음에 볼 때 다시 시도한다.
 */
export async function ensureRefinedThumbnail(
  jobId: string,
  personIndex: number,
  candidateId: string,
  overrides: Partial<ThumbnailDeps> = {},
): Promise<Uint8Array | null> {
  const key = `${jobId}|${personIndex}|${candidateId}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const work = render(jobId, personIndex, candidateId, { ...defaultDeps(), ...overrides }).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, work);
  return work;
}

async function render(
  jobId: string,
  personIndex: number,
  candidateId: string,
  deps: ThumbnailDeps,
): Promise<Uint8Array | null> {
  const artifact = await deps.findRefinedArtifact(jobId, personIndex, candidateId);
  if (!artifact || !artifact.refined || !artifact.objectKey) return null;

  if (artifact.thumbnailKey) {
    const stored = await deps.getRefinedThumbnail(artifact.thumbnailKey);
    if (stored) return stored;
    // 키는 있는데 객체가 없다(90일 만료 등). 아래에서 다시 그린다.
  }

  const [bvh, candidate, installationId] = await Promise.all([
    deps.getRefinedBvh(artifact.objectKey),
    deps.loadCandidate(jobId, personIndex, candidateId),
    deps.installationOf(jobId),
  ]);
  // 조정본이 만료됐거나 작업이 지워졌으면 그릴 것이 없다.
  if (!bvh || !candidate || !installationId) return null;

  const started = deps.now();
  let png: Uint8Array;
  try {
    png = candidate.camera
      ? await deps.renderCamera(bvh, candidate.camera.rotation)
      : await deps.renderView(bvh, candidate.view);
  } catch (error) {
    log.warn({
      type: "refine_thumbnail_deferred",
      jobId,
      personIndex,
      outcome: "render_failed",
      errorName: error instanceof Error ? error.name : "unknown",
      elapsedMs: deps.now() - started,
    });
    return null;
  }

  const thumbnailKey = refinedThumbnailObjectKey({ installationId, jobId, personIndex, candidateId });
  try {
    await deps.putRefinedThumbnail(thumbnailKey, png);
    // upsert가 thumbnail_key를 덮어쓴다. 작업이 그 사이 지워졌으면 아무것도 하지 않는다
    // (saveRefinedArtifact가 jobs 행을 잠그고 확인한다).
    await deps.saveRefinedArtifact({ ...artifact, thumbnailKey });
  } catch {
    // 저장에 실패해도 이번에 그린 그림은 보여 준다. 다음에 볼 때 다시 그린다.
    log.warn({
      type: "refine_thumbnail_deferred", jobId, personIndex, outcome: "persist_failed" });
    return png;
  }
  log.info({
    type: "refine_thumbnail_deferred",
    jobId,
    personIndex,
    outcome: "ok",
    camera: Boolean(candidate.camera),
    elapsedMs: deps.now() - started,
  });
  return png;
}
