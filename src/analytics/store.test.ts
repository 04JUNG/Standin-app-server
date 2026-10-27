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

test("update events are accepted so a client release does not poison the batch", () => {
  // 이 세 이름이 허용 목록에 없으면 routes.ts가 배치 전체를 400으로 거절하고,
  // 클라이언트가 그 배치를 통째로 버린다. 같이 실린 분석·저장 이벤트까지 사라진다.
  assert.deepEqual(
    sanitizeEventProperties("update_check", { trigger: "startup", result: "available" }),
    { trigger: "startup", result: "available" },
  );
  assert.deepEqual(
    sanitizeEventProperties("update_installed", { fromVersion: "0.1.1-beta.4", toVersion: "0.1.2" }),
    { fromVersion: "0.1.1-beta.4", toVersion: "0.1.2" },
  );
  assert.deepEqual(
    sanitizeEventProperties("update_failed", { phase: "download", reason: "NETWORK" }),
    { phase: "download", reason: "NETWORK" },
  );
});

test("unknown event names are still rejected", () => {
  // 허용 목록이 열려버리면 자유 텍스트가 그대로 쌓인다.
  assert.equal(sanitizeEventProperties("update_whatever", { trigger: "startup" }), null);
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

test("journey metadata is bounded and private payloads are discarded", () => {
  assert.deepEqual(sanitizeEventProperties("export_completed", {
    telemetryVersion:2, sessionId:"session-123", attemptId:"attempt-456", appVersion:"0.2.5",
    nativeDiskWrite:true,elapsedMs:1400,surface:"bar",localPath:"/private/user.fbx",error:"private details",
  }), {surface:"bar",telemetryVersion:2,sessionId:"session-123",appVersion:"0.2.5",attemptId:"attempt-456",nativeDiskWrite:true,elapsedMs:1400});
  const value=sanitizeEventProperties("preparation_failed",{telemetryVersion:2,sessionId:"/private/file",elapsedMs:Infinity,code:"raw error with private path",surface:"app"});
  assert.deepEqual(value,{telemetryVersion:2,surface:"app"});
  for(const name of ["input_started","input_cancelled","input_failed","review_viewed","preparation_started","preparation_ready","preparation_failed","export_requested","export_cancelled","thumbnail_failed"]) {
    assert.notEqual(sanitizeEventProperties(name,{telemetryVersion:2,sessionId:"session-123"}),null);
  }
});

test('feature contract validates bounded categories, actions, attribution and error metadata',()=>{
 const props=sanitizeEventProperties('feature_action',{telemetryVersion:2,sessionId:'s1',feature:'semantic_search',action:'upload_completed',searchOrdinal:2,source:'semantic',osName:'windows',httpStatus:503,errorCategory:'server',resultCount:0,inputId:'local-1',privateSearch:'raw user words'});
 assert.equal(props?.feature,'semantic_search');assert.equal(props?.searchOrdinal,2);assert.equal(props?.httpStatus,503);assert.equal(props?.resultCount,0);assert.equal(props?.privateSearch,undefined);
 const bad=sanitizeEventProperties('feature_action',{feature:'private feature name',action:'raw words',searchOrdinal:-1,resultCount:Infinity,errorCategory:'PII',httpStatus:600,osName:'user computer name'});
 assert.deepEqual(bad,{});
 assert.equal(sanitizeEventProperties('export_completed',{usedHandLibrary:true,usedBodyCustom:true,fromSemanticSearch:true})?.usedHandLibrary,true);
 assert.equal(sanitizeEventProperties('selection_failed',{code:'INVALID_INPUT',selectionCount:1})?.code,'INVALID_INPUT');
 assert.deepEqual(sanitizeEventProperties('journey_exit',{reason:'private details',phase:'review',feature:'export'}),{feature:'export',phase:'review'});
});
