// 라이브러리 버전별 공백 측정(러프 데이터 선순환 P8).
//
// 라이브러리에 포즈를 더한 뒤 맞는 포즈가 없던 인물이 실제로 줄었는지 본다. 집계는 SQL
// (뷰 library_observations_v1, libraryStore.ts)이 하고, 여기서는 응답 모양과 비율만 만든다.
// DB를 import하지 않는다 — db.ts가 아래 경계값을 집계에 쓴다.
import { rate } from "./product.js";

/**
 * Standin-server `config/pose_gaps.json`과 같은 경계다. 바꾸면 두 곳을 함께 고친다.
 * - weak(τ_soft): Top-1 거리가 이보다 멀면 약한 공백
 * - strong(τ_strong): 이보다 멀면 강한 공백
 * - extractionCap: 이보다 멀면 라이브러리 공백보다 관절 추출 실패를 먼저 의심한다
 */
export const GAP_THRESHOLDS = { weak: 0.25, strong: 0.35, extractionCap: 0.6 } as const;

export interface LibraryWeekRow {
  week: string;
  pose_library_version: string;
  coverage_class: string;
  people: number;
  eligible: number;
  weak_gap: number;
  strong_gap: number;
  extraction_suspect: number;
  selected: number;
  irrelevant: number;
  top1_median: number | null;
}

export interface LibraryWeek {
  week: string;
  libraryVersion: string;
  coverageClass: string;
  people: number;
  /** 공백 분석 대상. 관절 추출이 성립하고 전신 검색을 한 VLM 인물 슬롯이다. */
  eligible: number;
  weakGap: number;
  strongGap: number;
  extractionSuspect: number;
  /** (약한 + 강한 공백) / 적격, %. 추출 실패 의심은 넣지 않는다. */
  gapRate: number | null;
  strongGapRate: number | null;
  top1Median: number | null;
  selectionRate: number | null;
  /** "후보가 엉뚱함" 피드백이 달린 적격 인물 비율, %. */
  irrelevantRate: number | null;
}

export function toLibraryWeeks(rows: LibraryWeekRow[]): LibraryWeek[] {
  return rows.map((row) => ({
    week: row.week,
    libraryVersion: row.pose_library_version,
    coverageClass: row.coverage_class,
    people: row.people,
    eligible: row.eligible,
    weakGap: row.weak_gap,
    strongGap: row.strong_gap,
    extractionSuspect: row.extraction_suspect,
    gapRate: rate(row.weak_gap + row.strong_gap, row.eligible),
    strongGapRate: rate(row.strong_gap, row.eligible),
    top1Median: row.top1_median === null ? null : Math.round(row.top1_median * 1000) / 1000,
    selectionRate: rate(row.selected, row.eligible),
    irrelevantRate: rate(row.irrelevant, row.eligible),
  }));
}

export interface VlmPromptRow {
  prompt_version: string;
  jobs: number;
  core: number;
  bust: number;
  skip: number;
  unrecorded_route: number;
  count_high: number;
  count_known: number;
  people: number;
  tagged: number;
  vlm_person: number;
  legacy_cut: number;
}

export interface VlmPrompt {
  /** `unrecorded`는 프롬프트 버전을 저장하기 전의 분석이다. */
  promptVersion: string;
  jobs: number;
  routes: { core: number; bust: number; skip: number; unrecorded: number };
  /** 검출기와 VLM의 인원수가 같았던 비율, %. route가 기록된 Job만 센다. */
  countConfidenceHighRate: number | null;
  people: number;
  /** action이나 view가 하나라도 있는 인물 비율, %. */
  personTagFillRate: number | null;
  personTagSources: { vlmPerson: number; legacyCut: number };
}

export function toVlmPrompts(rows: VlmPromptRow[]): VlmPrompt[] {
  return rows.map((row) => ({
    promptVersion: row.prompt_version,
    jobs: row.jobs,
    routes: { core: row.core, bust: row.bust, skip: row.skip, unrecorded: row.unrecorded_route },
    countConfidenceHighRate: rate(row.count_high, row.count_known),
    people: row.people,
    personTagFillRate: rate(row.tagged, row.people),
    personTagSources: { vlmPerson: row.vlm_person, legacyCut: row.legacy_cut },
  }));
}
