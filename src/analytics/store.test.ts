import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeEventProperties } from "./store.js";

test("event properties use an allow-list and drop paths or arbitrary text", () => {
  assert.deepEqual(
    sanitizeEventProperties("candidate_selected", {
      personIndex: 0,
      candidateId: "pose-1",
      previousCandidateId: null,
      rank: 1,
      surface: "app",
      localPath: "C:/secret/storyboard.png",
      note: "private dialogue",
    }),
    {
      personIndex: 0,
      candidateId: "pose-1",
      previousCandidateId: null,
      rank: 1,
      surface: "app",
    },
  );
});

test("unknown event names are rejected", () => {
  assert.equal(sanitizeEventProperties("raw_text", { value: "secret" }), null);
});

test("selection confirmation exposes only the selection count", () => {
  assert.deepEqual(
    sanitizeEventProperties("selection_confirmed", {
      selectionCount: 2,
      candidateIds: ["private-candidate"],
    }),
    { selectionCount: 2 },
  );
});

// 실패 계열 이벤트가 허용목록에 없으면 배치 전체가 400으로 거절되고,
// 클라이언트는 그 배치를 버린다. 이름 하나만 어긋나도 로그가 조용히 사라진다.
test("failure events are accepted with their code-only properties", () => {
  assert.deepEqual(
    sanitizeEventProperties("analysis_failed", {
      reason: "TIMEOUT",
      surface: "bar",
      elapsedMs: 42000,
    }),
    { reason: "TIMEOUT", surface: "bar", elapsedMs: 42000 },
  );
  assert.deepEqual(
    sanitizeEventProperties("rerun_requested", {
      surface: "app",
      selectedCount: 1,
      peopleCount: 2,
    }),
    { surface: "app", selectedCount: 1, peopleCount: 2 },
  );
  assert.deepEqual(
    sanitizeEventProperties("export_completed", { fileCount: 2, surface: "app" }),
    { fileCount: 2, surface: "app" },
  );
  assert.deepEqual(
    sanitizeEventProperties("export_failed", { code: "FOLDER_MISSING", surface: "bar" }),
    { code: "FOLDER_MISSING", surface: "bar" },
  );
  assert.deepEqual(
    sanitizeEventProperties("capture_failed", { code: "PERMISSION_DENIED", surface: "app" }),
    { code: "PERMISSION_DENIED", surface: "app" },
  );
});

test("input confirmation records which surface started the flow", () => {
  assert.deepEqual(
    sanitizeEventProperties("input_confirmed", {
      source: "capture",
      width: 800,
      height: 600,
      size: 1024,
      mime: "image/png",
      surface: "bar",
      originalName: "storyboard.png",
    }),
    {
      source: "capture",
      width: 800,
      height: 600,
      size: 1024,
      mime: "image/png",
      surface: "bar",
    },
  );
});
