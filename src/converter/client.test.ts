// converter client 계약 테스트.
//
// 여기서 지키는 것은 "성공처럼 보이는 실패"다. converter가 200을 주고 FBX처럼 생긴
// 바이트를 줘도, lineage 헤더가 우리 계산과 어긋나면 그 파일은 나가면 안 된다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ConverterError, convertBvhToFbx, sha256Hex } from "./client.js";

const BVH = new TextEncoder().encode("HIERARCHY\nROOT Hips\nMOTION\nFrames: 1\n");
const FBX = new Uint8Array([0x4b, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61, 0x20]);
const SOLVER = "chain-transport-v3.2";

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function okResponse(overrides: Record<string, string> = {}, body: Uint8Array = FBX): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "X-Standin-Conversion-Id": "conv-1",
      "X-Standin-Source-BVH-SHA256": sha(BVH),
      "X-Standin-Artifact-SHA256": sha(body),
      "X-Standin-Solver-Version": SOLVER,
      ...overrides,
    },
  });
}

function deps(fetchImpl: typeof fetch) {
  return { fetch: fetchImpl, baseUrl: "http://converter:8001", timeoutMs: 1000, defaultCharacterId: "standin-master-v2" };
}

test("converter가 강제하는 고정 옵션을 그대로 보낸다", async () => {
  let sent: FormData | undefined;
  const result = await convertBvhToFbx(
    { bvhBytes: BVH, fileName: "pose.bvh" },
    deps((async (_url, init) => {
      sent = init?.body as FormData;
      return okResponse();
    }) as typeof fetch),
  );

  assert.equal(sent?.get("frame"), "0");
  assert.equal(sent?.get("output_mode"), "rigged_rest");
  assert.equal(sent?.get("apply_root_translation"), "false");
  // mirror는 converter가 한 번만 적용한다. 기본은 항상 false여야 한다.
  assert.equal(sent?.get("mirror"), "false");
  assert.equal(sent?.get("character_id"), "standin-master-v2");
  assert.equal(result.conversionId, "conv-1");
  assert.equal(result.sourceBvhSha256, sha256Hex(BVH));
});

test("converter가 다른 BVH를 봤다고 하면 FBX를 폐기한다", async () => {
  await assert.rejects(
    convertBvhToFbx(
      { bvhBytes: BVH, fileName: "pose.bvh" },
      deps((async () => okResponse({ "X-Standin-Source-BVH-SHA256": "0".repeat(64) })) as typeof fetch),
    ),
    (error: unknown) =>
      error instanceof ConverterError && error.code === "CONVERTER_INTEGRITY",
  );
});

test("응답 본문이 선언된 artifact 해시와 다르면 폐기한다", async () => {
  await assert.rejects(
    convertBvhToFbx(
      { bvhBytes: BVH, fileName: "pose.bvh" },
      deps((async () => okResponse({ "X-Standin-Artifact-SHA256": "0".repeat(64) })) as typeof fetch),
    ),
    (error: unknown) =>
      error instanceof ConverterError && error.code === "CONVERTER_INTEGRITY",
  );
});

test("solver 버전이 다르면 폐기한다", async () => {
  await assert.rejects(
    convertBvhToFbx(
      { bvhBytes: BVH, fileName: "pose.bvh" },
      deps((async () => okResponse({ "X-Standin-Solver-Version": "chain-transport-v3.1" })) as typeof fetch),
    ),
    (error: unknown) =>
      error instanceof ConverterError && error.code === "CONVERTER_INTEGRITY",
  );
});

test("422는 재시도 불가(REJECTED)로, 503은 재시도 가능(UNAVAILABLE)으로 나눈다", async () => {
  const respond = (status: number) =>
    convertBvhToFbx(
      { bvhBytes: BVH, fileName: "pose.bvh" },
      deps((async () =>
        new Response(JSON.stringify({ error: { code: "X", message: "y", conversion_id: "conv-9" } }), {
          status,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch),
    );

  await assert.rejects(respond(422), (e: unknown) =>
    e instanceof ConverterError && e.code === "CONVERTER_REJECTED" && e.conversionId === "conv-9");
  await assert.rejects(respond(503), (e: unknown) =>
    e instanceof ConverterError && e.code === "CONVERTER_UNAVAILABLE");
  await assert.rejects(respond(504), (e: unknown) =>
    e instanceof ConverterError && e.code === "CONVERTER_TIMEOUT");
});

test("도달 실패와 timeout을 구분한다", async () => {
  await assert.rejects(
    convertBvhToFbx(
      { bvhBytes: BVH, fileName: "pose.bvh" },
      deps((async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch),
    ),
    (e: unknown) => e instanceof ConverterError && e.code === "CONVERTER_UNAVAILABLE",
  );

  await assert.rejects(
    convertBvhToFbx(
      { bvhBytes: BVH, fileName: "pose.bvh" },
      deps((async () => {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        throw error;
      }) as typeof fetch),
    ),
    (e: unknown) => e instanceof ConverterError && e.code === "CONVERTER_TIMEOUT",
  );
});

test("base url이 없으면 호출 자체를 하지 않는다", async () => {
  let called = false;
  await assert.rejects(
    convertBvhToFbx(
      { bvhBytes: BVH, fileName: "pose.bvh" },
      { ...deps((async () => {
        called = true;
        return okResponse();
      }) as typeof fetch), baseUrl: "" },
    ),
    (e: unknown) => e instanceof ConverterError && e.code === "CONVERTER_DISABLED",
  );
  assert.equal(called, false);
});
