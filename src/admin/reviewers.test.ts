import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_REVIEWER, matchReviewer, parseReviewers } from "./reviewers.js";

test("JSON이 아니면 단일 토큰으로 읽는다", () => {
  const reviewers = parseReviewers("plain-token-48");
  assert.deepEqual(reviewers, [{ name: DEFAULT_REVIEWER, token: "plain-token-48" }]);
});

test("JSON이면 사람별로 가른다", () => {
  const reviewers = parseReviewers('{"jung":"aaa","kim":"bbb"}');
  assert.deepEqual(reviewers, [
    { name: "jung", token: "aaa" },
    { name: "kim", token: "bbb" },
  ]);
});

test("빈 값이면 아무도 통과하지 못한다", () => {
  assert.deepEqual(parseReviewers(""), []);
  assert.deepEqual(parseReviewers(undefined), []);
  assert.equal(matchReviewer([], "무엇이든"), null);
});

test("규칙에 맞지 않는 항목만 버리고 나머지는 산다", () => {
  // 공백 이름, 빈 토큰, 문자열이 아닌 값
  const reviewers = parseReviewers('{"정 현":"aaa","kim":"","lee":123,"park":"ddd"}');
  assert.deepEqual(reviewers, [{ name: "park", token: "ddd" }]);
});

test("깨진 JSON이어도 기동을 막지 않는다", () => {
  const reviewers = parseReviewers('{"jung":"aaa"');
  assert.equal(reviewers.length, 1);
  assert.equal(reviewers[0].name, DEFAULT_REVIEWER);
  // 그 깨진 문자열 자체가 토큰이 되므로 사실상 닫힌다
  assert.equal(matchReviewer(reviewers, "aaa"), null);
});

test("토큰이 맞으면 그 사람의 이름이 나온다", () => {
  const reviewers = parseReviewers('{"jung":"aaa","kim":"bbb"}');
  assert.equal(matchReviewer(reviewers, "aaa"), "jung");
  assert.equal(matchReviewer(reviewers, "bbb"), "kim");
  assert.equal(matchReviewer(reviewers, "ccc"), null);
  assert.equal(matchReviewer(reviewers, ""), null);
});

test("길이가 다른 토큰도 비교할 수 있다", () => {
  // 원문 길이가 다르면 timingSafeEqual이 던진다 — 다이제스트로 비교해야 통과한다.
  const reviewers = parseReviewers('{"jung":"short"}');
  assert.equal(matchReviewer(reviewers, "훨씬 더 긴 토큰 문자열"), null);
  assert.equal(matchReviewer(reviewers, "short"), "jung");
});

test("같은 토큰이 두 이름에 걸리면 먼저 선언된 쪽이 이긴다", () => {
  const reviewers = parseReviewers('{"jung":"same","kim":"same"}');
  assert.equal(matchReviewer(reviewers, "same"), "jung");
});
