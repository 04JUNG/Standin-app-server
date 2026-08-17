import { strict as assert } from "node:assert";
import test from "node:test";
import {
  dailyWindow,
  fixedWindow,
  isDisabled,
  kstDayKey,
  kstIsoString,
  nextKstMidnightMs,
  secondsUntil,
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
