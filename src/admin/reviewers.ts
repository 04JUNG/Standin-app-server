// 관리자 토큰을 사람 단위로 가른다.
//
// 검토 화면은 사용자가 올린 실제 사진과 그 결과를 보여 준다. 토큰 하나를 여럿이
// 나눠 쓰면 `admin_access_audit`에 전원이 같은 이름으로 남아 **누가 누구의 사진을
// 열어 봤는지 복원할 수 없고**, 한 명이 팀을 떠날 때 전원의 토큰을 갈아야 한다.
//
// 시크릿 값을 `{"이름":"토큰"}` JSON으로 두면 그 둘이 풀린다. 값이 JSON이 아니면
// 예전처럼 단일 토큰으로 읽으므로, 앱을 먼저 배포하고 시크릿을 나중에 바꿔도 된다.
import { createHash, timingSafeEqual } from "node:crypto";

export interface Reviewer {
  name: string;
  token: string;
}

/** JSON 이전에 쓰던 단일 토큰의 이름. 기존 감사 로그와 이어지도록 값을 유지한다. */
export const DEFAULT_REVIEWER = "beta-reviewer";

/**
 * 감사 로그에 남는 이름이라 사람을 특정할 수 있어야 하고, 로그를 읽을 때 눈에
 * 걸리지 않아야 한다. 공백과 제어문자를 막는 선에서 넉넉히 허용한다.
 */
const NAME = /^[A-Za-z0-9_.@-]{1,40}$/;

/**
 * 시크릿 값을 검토자 목록으로 바꾼다.
 *
 * - `{"jung":"...","kim":"..."}` → 사람별 토큰
 * - 그 밖의 문자열 → 단일 토큰(`DEFAULT_REVIEWER`)
 * - 빈 값 → 빈 목록. 관리자 경로 전체가 닫힌다(토큰 미설정과 같다).
 *
 * 이름이나 값이 규칙에 맞지 않는 항목은 **조용히 버린다.** 오타 하나로 관리자
 * 경로 전체가 닫히면 장애 중에 대시보드를 못 여는 쪽이 더 위험하다.
 */
export function parseReviewers(raw: string | undefined | null): Reviewer[] {
  const value = (raw ?? "").trim();
  if (!value) return [];
  if (value.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      // 깨진 JSON은 통째로 하나의 토큰처럼 다룬다. 아무도 그 문자열을 모르므로
      // 사실상 닫히지만, 앱이 죽지는 않는다.
      return [{ name: DEFAULT_REVIEWER, token: value }];
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>)
        .filter(([name, token]) => NAME.test(name) && typeof token === "string" && token.length > 0)
        .map(([name, token]) => ({ name, token: token as string }));
    }
  }
  return [{ name: DEFAULT_REVIEWER, token: value }];
}

/**
 * 토큰에 해당하는 검토자 이름. 없으면 null.
 *
 * 원문 길이가 달라도 비교가 성립하도록 sha256 다이제스트끼리 상수시간 비교한다.
 * 일치한 뒤에도 순회를 멈추지 않는다 — 몇 번째에서 멈췄는지가 타이밍으로 새면
 * 토큰 자체는 아니어도 목록의 위치가 드러난다.
 */
export function matchReviewer(reviewers: Reviewer[], supplied: string): string | null {
  if (!supplied) return null;
  const actual = createHash("sha256").update(supplied).digest();
  let matched: string | null = null;
  for (const reviewer of reviewers) {
    const expected = createHash("sha256").update(reviewer.token).digest();
    if (timingSafeEqual(actual, expected) && matched === null) matched = reviewer.name;
  }
  return matched;
}
