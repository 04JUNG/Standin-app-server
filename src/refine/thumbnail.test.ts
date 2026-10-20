import assert from "node:assert/strict";
import test from "node:test";
import { ensureRefinedThumbnail, type ThumbnailDeps } from "./thumbnail.js";
import type { RefinedArtifact } from "./store.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const STORED = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const BVH = new TextEncoder().encode("HIERARCHY\n");
const JOB = "job_00000000-0000-4000-8000-000000000001";

function artifact(overrides: Partial<RefinedArtifact> = {}): RefinedArtifact {
  return {
    jobId: JOB,
    personIndex: 0,
    candidateId: "pose-1::front",
    poseId: "pose-1",
    refined: true,
    reason: "ok_partial",
    objectKey: "installations/inst_x/jobs/job/refined/0/pose-1__front.bvh",
    thumbnailKey: null,
    limbs: ["right_leg"],
    ...overrides,
  };
}

function deps(overrides: Partial<ThumbnailDeps> = {}) {
  const calls = { view: 0, camera: 0, put: 0, save: [] as RefinedArtifact[] };
  const base: Partial<ThumbnailDeps> = {
    findRefinedArtifact: async () => artifact(),
    loadCandidate: async () => ({ poseId: "pose-1", view: "front", distance: 0.2 }),
    saveRefinedArtifact: async (row) => { calls.save.push(row); },
    getRefinedBvh: async () => BVH,
    getRefinedThumbnail: async () => STORED,
    putRefinedThumbnail: async () => { calls.put += 1; },
    installationOf: async () => "inst_00000000-0000-4000-8000-000000000001",
    renderView: async () => { calls.view += 1; return PNG; },
    renderCamera: async () => { calls.camera += 1; return PNG; },
    now: () => 0,
    ...overrides,
  };
  return { deps: base, calls };
}

test("저장된 미리보기가 있으면 다시 그리지 않는다", async () => {
  const { deps: d, calls } = deps({ findRefinedArtifact: async () => artifact({ thumbnailKey: "k.png" }) });
  const png = await ensureRefinedThumbnail(JOB, 0, "a", d);
  assert.deepEqual(png, STORED);
  assert.equal(calls.view + calls.camera, 0);
});

test("없으면 그려서 저장하고 thumbnail_key를 남긴다", async () => {
  const { deps: d, calls } = deps();
  const png = await ensureRefinedThumbnail(JOB, 0, "b", d);
  assert.deepEqual(png, PNG);
  assert.equal(calls.view, 1);
  assert.equal(calls.put, 1);
  assert.equal(calls.save.length, 1);
  assert.match(calls.save[0].thumbnailKey ?? "", /\.png$/);
});

test("키는 있는데 객체가 만료됐으면 다시 그린다", async () => {
  const { deps: d, calls } = deps({
    findRefinedArtifact: async () => artifact({ thumbnailKey: "gone.png" }),
    getRefinedThumbnail: async () => null,
  });
  assert.deepEqual(await ensureRefinedThumbnail(JOB, 0, "c", d), PNG);
  assert.equal(calls.view, 1);
});

test("후보에 카메라가 있으면 그 카메라로 그린다", async () => {
  // 저장될 포즈와 같은 각도여야 한다. 방향 이름만으로 그리면 다른 구도가 된다.
  const rotation = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const { deps: d, calls } = deps({
    loadCandidate: async () => ({
      poseId: "pose-1", view: "front", distance: 0.2,
      camera: { version: "candidate-camera-v1", rotation, source_bvh_sha256: "a".repeat(64),
                reference: "pelvis-torso-yaw", canonical_yaw: 0, display_view: "front" } as never,
    }),
  });
  await ensureRefinedThumbnail(JOB, 0, "d", d);
  assert.equal(calls.camera, 1);
  assert.equal(calls.view, 0);
});

test("조정하지 않은 후보는 그리지 않는다", async () => {
  // 그때 맞는 그림은 라이브러리 후보 썸네일이고 화면이 이미 보여 준다.
  const { deps: d, calls } = deps({ findRefinedArtifact: async () => artifact({ refined: false, objectKey: null }) });
  assert.equal(await ensureRefinedThumbnail(JOB, 0, "e", d), null);
  assert.equal(calls.view + calls.camera, 0);
});

test("조정본 BVH가 만료됐으면 null이다", async () => {
  const { deps: d } = deps({ getRefinedBvh: async () => null });
  assert.equal(await ensureRefinedThumbnail(JOB, 0, "f", d), null);
});

test("그리다 실패하면 null이고 저장하지 않는다", async () => {
  const { deps: d, calls } = deps({ renderView: async () => { throw new Error("converter down"); } });
  assert.equal(await ensureRefinedThumbnail(JOB, 0, "g", d), null);
  assert.equal(calls.put, 0);
  assert.equal(calls.save.length, 0);
});

test("저장에 실패해도 이번에 그린 그림은 돌려준다", async () => {
  const { deps: d } = deps({ putRefinedThumbnail: async () => { throw new Error("s3 down"); } });
  assert.deepEqual(await ensureRefinedThumbnail(JOB, 0, "h", d), PNG);
});

test("같은 미리보기를 동시에 두 번 그리지 않는다", async () => {
  // 전환기는 한 번에 한 건만 처리한다. 같은 걸 두 번 넣으면 사용자 내보내기가 더 밀린다.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { deps: d, calls } = deps({ renderView: async () => { calls.view += 1; await gate; return PNG; } });
  const first = ensureRefinedThumbnail(JOB, 0, "same", d);
  const second = ensureRefinedThumbnail(JOB, 0, "same", d);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, PNG);
  assert.deepEqual(b, PNG);
  assert.equal(calls.view, 1);
});

test("끝난 뒤에는 다시 그릴 수 있다", async () => {
  const { deps: d, calls } = deps();
  await ensureRefinedThumbnail(JOB, 0, "again", d);
  await ensureRefinedThumbnail(JOB, 0, "again", d);
  assert.equal(calls.view, 2);
});
