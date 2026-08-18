// 알림 억제 결정표 검증(마스터독스 「관측성」 §5).
//
// 여기서 지키려는 성질은 하나다: **장애 때 알림이 유실되지 않는다.**
// 디스코드 웹훅은 분당 수십 건에서 레이트리밋에 걸리므로, 초당 수백 건의 에러를
// 그대로 흘리면 정작 첫 알림까지 같이 버려진다. 아래 표가 그걸 막는 규칙이다.
import assert from "node:assert/strict";
import test from "node:test";
import { AlertBuffer, type Alert } from "./notify.js";

const SUPPRESS_MS = 300_000; // 5분
const alert = (code: string, severity: Alert["severity"] = "P2"): Alert => ({
  severity,
  code,
  message: `${code} 발생`,
});

test("같은 배치 안의 같은 키는 한 건으로 접히고 횟수만 오른다", () => {
  const buffer = new AlertBuffer(SUPPRESS_MS);

  assert.equal(buffer.add(alert("INFERENCE_FAILED"), 1_000), true, "첫 건은 새로 대기열에 든다");
  assert.equal(buffer.add(alert("INFERENCE_FAILED"), 1_100), false, "두 번째는 예약을 다시 걸지 않는다");
  assert.equal(buffer.add(alert("INFERENCE_FAILED"), 1_200), false);

  const drained = buffer.drain(2_000);
  assert.equal(drained.length, 1);
  assert.equal(drained[0]?.count, 3);
  assert.equal(drained[0]?.firstAt, 1_000);
  assert.equal(drained[0]?.lastAt, 1_200, "마지막 발생 시각이 임베드 타임스탬프가 된다");
});

test("다른 키는 접히지 않는다", () => {
  const buffer = new AlertBuffer(SUPPRESS_MS);
  buffer.add(alert("INFERENCE_FAILED"), 0);
  buffer.add(alert("ANALYSIS_TIMEOUT"), 0);
  buffer.add({ ...alert("UNHANDLED_ERROR"), key: "P2:unhandled:/v1/users" }, 0);
  buffer.add({ ...alert("UNHANDLED_ERROR"), key: "P2:unhandled:/v1/events" }, 0);

  assert.equal(buffer.drain(1).length, 4, "라우트별로 나눈 키는 각각 남는다");
});

test("보낸 뒤 억제 창 안의 재발은 큐에 들어가지 않는다", () => {
  const buffer = new AlertBuffer(SUPPRESS_MS);
  buffer.add(alert("DB_DOWN"), 0);
  buffer.drain(1_000); // 여기서 억제 창이 걸린다

  for (let i = 0; i < 500; i += 1) {
    assert.equal(buffer.add(alert("DB_DOWN"), 1_000 + i), false);
  }
  assert.equal(buffer.size, 0, "폭주해도 웹훅으로 나가는 메시지는 늘지 않는다");
  assert.equal(buffer.drain(2_000).length, 0);
});

test("억제 창이 끝나면 삼킨 횟수를 합쳐 한 번에 보고한다", () => {
  const buffer = new AlertBuffer(SUPPRESS_MS);
  buffer.add(alert("DB_DOWN"), 0);
  buffer.drain(1_000);

  buffer.add(alert("DB_DOWN"), 2_000); // 억제됨
  buffer.add(alert("DB_DOWN"), 3_000); // 억제됨

  const afterWindow = 1_000 + SUPPRESS_MS;
  assert.equal(buffer.add(alert("DB_DOWN"), afterWindow), true, "창이 끝나면 다시 보낸다");

  const drained = buffer.drain(afterWindow);
  assert.equal(drained[0]?.count, 3, "삼킨 2건 + 이번 1건이 함께 보고된다");
});

test("억제 창은 키마다 따로 돈다", () => {
  const buffer = new AlertBuffer(SUPPRESS_MS);
  buffer.add(alert("DB_DOWN"), 0);
  buffer.drain(0);

  assert.equal(buffer.add(alert("DB_DOWN"), 10), false, "이미 보낸 키는 막힌다");
  assert.equal(buffer.add(alert("SMTP_SEND_FAILED"), 10), true, "다른 키는 즉시 나간다");
});

test("등급이 다르면 같은 코드라도 별개 사건이다", () => {
  const buffer = new AlertBuffer(SUPPRESS_MS);
  buffer.add(alert("INFERENCE_DOWN", "P1"), 0);
  buffer.add(alert("INFERENCE_DOWN", "P2"), 0);
  assert.equal(buffer.drain(1).length, 2);
});

test("requestId는 첫 건의 것을 남긴다", () => {
  const buffer = new AlertBuffer(SUPPRESS_MS);
  buffer.add(alert("INFERENCE_FAILED"), 0, "req_first");
  buffer.add(alert("INFERENCE_FAILED"), 1, "req_second");

  const drained = buffer.drain(2);
  assert.equal(drained[0]?.requestId, "req_first", "원인을 파는 실마리는 첫 건이면 충분하다");
});
