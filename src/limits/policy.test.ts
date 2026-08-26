import { strict as assert } from "node:assert";
import test from "node:test";
import {
  dailyWindow,
  fixedWindow,
  isDisabled,
  isQuotaExempt,
  kstDayKey,
  kstIsoString,
  kstWeekKey,
  nextKstMidnightMs,
  nextKstWeekStartMs,
  parseExemptList,
  secondsUntil,
  weeklyWindow,
} from "./policy.js";

const utc = (iso: string) => Date.parse(iso);

test("일일 창은 UTC가 아니라 KST 자정에 바뀐다", () => {
  // UTC로는 아직 8/10이지만 KST로는 이미 8/11이다.
  assert.equal(kstDayKey(utc("2026-08-10T15:00:00Z")), "2026-08-11");
  assert.equal(kstDayKey(utc("2026-08-10T14:59:59Z")), "2026-08-10");
  // UTC 자정을 넘어도 KST 같은 날이면 같은 창이어야 한다(자정에 쿼터가 두 번 리셋되지 않는다).
  assert.equal(kstDayKey(utc("2026-08-10T23:30:00Z")), kstDayKey(utc("2026-08-11T00:30:00Z")));
});

test("다음 KST 자정과 재시도 시각", () => {
  const now = utc("2026-08-11T01:00:00Z"); // KST 10:00
  const reset = nextKstMidnightMs(now);
  assert.equal(new Date(reset).toISOString(), "2026-08-11T15:00:00.000Z"); // KST 8/12 00:00
  assert.equal(secondsUntil(reset, now), 14 * 3600);
  assert.equal(kstIsoString(reset), "2026-08-12T00:00:00.000+09:00");
});

test("KST 자정 직전·직후 창이 실제로 갈린다", () => {
  const before = utc("2026-08-11T14:59:59Z");
  const after = utc("2026-08-11T15:00:00Z");
  assert.notEqual(dailyWindow(before).key, dailyWindow(after).key);
  assert.equal(dailyWindow(before).resetAtMs, after);
});

test("고정 창은 windowSeconds 경계로 잘린다", () => {
  const a = fixedWindow(utc("2026-08-11T01:00:10Z"), 60);
  const b = fixedWindow(utc("2026-08-11T01:00:59Z"), 60);
  const c = fixedWindow(utc("2026-08-11T01:01:00Z"), 60);
  assert.equal(a.key, b.key);
  assert.notEqual(b.key, c.key);
  assert.equal(a.resetAtMs, utc("2026-08-11T01:01:00Z"));
  assert.equal(secondsUntil(a.resetAtMs, utc("2026-08-11T01:00:10Z")), 50);
});

test("0 이하 한도는 비활성으로 읽는다", () => {
  assert.equal(isDisabled(0), true);
  assert.equal(isDisabled(-1), true);
  assert.equal(isDisabled(Number.NaN), true);
  assert.equal(isDisabled(1), false);
  assert.equal(isDisabled(10), false);
});

test("Retry-After는 0이 되지 않는다", () => {
  const now = utc("2026-08-11T01:00:00Z");
  assert.equal(secondsUntil(now, now), 1);
  assert.equal(secondsUntil(now - 5000, now), 1);
});

// 2026-08-22(토)이 속한 주는 2026-08-17(월)에 시작한다.
test("주간 창은 KST 월요일 자정에 바뀐다", () => {
  assert.equal(kstWeekKey(utc("2026-08-22T03:00:00Z")), "2026-08-17"); // KST 토 12:00
  assert.equal(kstWeekKey(utc("2026-08-17T00:00:00Z")), "2026-08-17"); // KST 월 09:00
  // 일요일 늦은 밤(KST)까지는 같은 주다.
  assert.equal(kstWeekKey(utc("2026-08-23T14:59:59Z")), "2026-08-17"); // KST 일 23:59:59
  // KST 월요일 0시를 넘기면 다음 주 창이다.
  assert.equal(kstWeekKey(utc("2026-08-23T15:00:00Z")), "2026-08-24"); // KST 월 00:00
});

test("주간 창 경계는 UTC가 아니라 KST를 따른다", () => {
  // UTC로는 아직 일요일이지만 KST로는 이미 월요일 → 새 창이어야 한다.
  const beforeReset = utc("2026-08-23T14:59:59Z");
  const afterReset = utc("2026-08-23T15:00:00Z");
  assert.notEqual(weeklyWindow(beforeReset).key, weeklyWindow(afterReset).key);
  assert.equal(weeklyWindow(beforeReset).resetAtMs, afterReset);
});

test("주간 리셋 시각은 다음 KST 월요일 자정이다", () => {
  const now = utc("2026-08-22T03:00:00Z"); // KST 토 12:00
  const reset = nextKstWeekStartMs(now);
  assert.equal(kstIsoString(reset), "2026-08-24T00:00:00.000+09:00");
  // 하루 단위 창과 달리 며칠 뒤일 수 있다 — 클라가 "내일"로 단정하면 안 되는 이유다.
  assert.ok(secondsUntil(reset, now) > 24 * 3600);
});

test("일일 창(전체 상한)과 주간 창(설치별)은 서로 독립이다", () => {
  const now = utc("2026-08-22T03:00:00Z");
  assert.notEqual(dailyWindow(now).key, weeklyWindow(now).key);
  assert.ok(weeklyWindow(now).resetAtMs > dailyWindow(now).resetAtMs);
});

test("쿼터 예외 목록은 콤마 구분에 공백을 허용한다", () => {
  const exempt = parseExemptList(" inst_dev1 , inst_dev2 ,, ");
  assert.equal(exempt.size, 2);
  assert.equal(isQuotaExempt("inst_dev1", exempt), true);
  assert.equal(isQuotaExempt("inst_dev2", exempt), true);
  assert.equal(isQuotaExempt("inst_other", exempt), false);
});

test("빈 설정이면 아무도 예외가 아니다", () => {
  // 실수로 빈 문자열이 들어왔을 때 전원 무제한이 되면 안 된다.
  const exempt = parseExemptList("");
  assert.equal(exempt.size, 0);
  assert.equal(isQuotaExempt("", exempt), false);
  assert.equal(isQuotaExempt("inst_dev1", exempt), false);
});
