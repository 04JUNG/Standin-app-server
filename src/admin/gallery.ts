// 러프·결과 모아 보기의 순수 함수. SQL은 `galleryStore.ts`.
//
// 사용자 사진을 여러 장 한꺼번에 보여 주는 화면이라, 원래 "목록에는 서명 URL을 싣지
// 않는다"던 원칙을 이렇게 좁혀서 연다(2026-10-10 사용자 결정):
//   · 한 페이지 24장, 서명 URL은 5분
//   · 페이지를 열 때마다 그 페이지의 Job을 하나하나 열람 기록에 남긴다
//   · 동의를 철회했거나 삭제를 요청한 설치는 빼고, 원본이 남아 있는 90일 안만 본다
//   · 일괄 다운로드는 없다

import { decodeCursor, type HistoryCursor } from "../jobs/history.js";
import type { OutcomeKey } from "./activity.js";

export const GALLERY_GROUPS = ["date", "installation", "status"] as const;
export type GalleryGroup = (typeof GALLERY_GROUPS)[number];
export const GALLERY_PAGE = 24;
/** S3 원본이 90일 뒤 지워진다. 그보다 오래된 칸은 열어도 빈 그림뿐이다. */
export const GALLERY_DAYS = 90;

export const STATUS_ORDER: OutcomeKey[] = ["selected", "no_selection", "zero_people", "failed", "in_progress"];

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const INSTALLATION_KEY = /^inst_[0-9a-f-]{36}$/;

export interface GalleryQuery {
  group: GalleryGroup;
  key: string;
  cursor: HistoryCursor | null;
}

export type ParsedGalleryQuery = { ok: true; query: GalleryQuery } | { ok: false; message: string };

export function parseGroup(raw: string | undefined): GalleryGroup | null {
  const group = (raw ?? "date") as GalleryGroup;
  return GALLERY_GROUPS.includes(group) ? group : null;
}

/** 폴더 키는 묶음마다 모양이 다르다. 틀린 키로 365일치를 훑지 않게 여기서 거른다. */
export function parseGalleryQuery(raw: { group?: string; key?: string; cursor?: string }): ParsedGalleryQuery {
  const group = parseGroup(raw.group);
  if (!group) return { ok: false, message: `group은 ${GALLERY_GROUPS.join(", ")} 중 하나여야 합니다.` };
  const key = raw.key ?? "";
  const valid =
    group === "date" ? DATE_KEY.test(key)
    : group === "installation" ? INSTALLATION_KEY.test(key)
    : (STATUS_ORDER as string[]).includes(key);
  if (!valid) return { ok: false, message: "폴더 key가 올바르지 않습니다." };
  let cursor: HistoryCursor | null = null;
  if (raw.cursor) {
    cursor = decodeCursor(raw.cursor);
    if (!cursor) return { ok: false, message: "cursor가 올바르지 않습니다." };
  }
  return { ok: true, query: { group, key, cursor } };
}
