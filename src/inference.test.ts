import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InferenceError,
  InferenceTimeoutError,
  analysisFailureCode,
  shouldRefundQuota,
} from "./inference.js";

// 2026-08-21(master-docs #6): Gemini 과부하로 추론이 실패하는 동안 분석 4건이 죽었다.
// 그때 사유가 전부 INFERENCE_FAILED로 접혀서, 사용자는 "다른 이미지로 다시 시도해
// 주세요"라는 안내를 받았다 — 상류가 붐비는 동안에는 어떤 이미지도 실패한다.
test("추론의 503(상류 혼잡)은 재시도 가능한 사유로 분류한다", () => {
  const error = new InferenceError(503, JSON.stringify({ detail: { code: "VLM_UNAVAILABLE" } }));
  assert.equal(analysisFailureCode(error), "ANALYSIS_UNAVAILABLE");
});

test("timeout은 상류 혼잡과 구분한다", () => {
  assert.equal(analysisFailureCode(new InferenceTimeoutError(120_000)), "ANALYSIS_TIMEOUT");
});

test("그 밖의 추론 실패는 INFERENCE_FAILED로 남는다", () => {
  // 500은 추론 서버 자신의 버그다. 재시도 안내 뒤에 숨기면 안 된다.
  assert.equal(analysisFailureCode(new InferenceError(500, "internal error")), "INFERENCE_FAILED");
  assert.equal(analysisFailureCode(new InferenceError(400, "bad request")), "INFERENCE_FAILED");
  assert.equal(analysisFailureCode(new Error("boom")), "INFERENCE_FAILED");
});

// 쿼터는 "우리가 한 일"에 매기는 값이다. 상류가 요청을 받아주지도 않아 아무 일도 일어나지
// 않았다면 사용자의 하루 10회에서 깎을 근거가 없다.
test("상류가 요청을 받아주지 않은 실패는 하루 쿼터를 돌려준다", () => {
  assert.equal(shouldRefundQuota("ANALYSIS_UNAVAILABLE"), true);
});

test("추론이 실제로 돌다 실패한 경우는 환불하지 않는다", () => {
  // 늦어졌거나 거절당한 것은 "아무 일도 없었다"가 아니다.
  assert.equal(shouldRefundQuota("ANALYSIS_TIMEOUT"), false);
  assert.equal(shouldRefundQuota("INFERENCE_FAILED"), false);
});
