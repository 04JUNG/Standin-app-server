// 계측 건강도 — "지표를 믿어도 되는가"에 답하는 블록.
//
// 2026-09-13에 제품 지표를 처음 켜 보니 `rerank_score`가 전부 비어 있었다. 버그가
// 아니라 추론이 `knn_geometric`을 직접 부르면서 rerank 경로를 쓰지 않기 때문인데,
// **그 사실이 화면 어디에도 드러나지 않아 "점수 평균 null"만 보고 한참 뒤졌다.**
//
// 비어 있는 컬럼과, 서버 기록과 클라이언트 이벤트의 어긋남을 먼저 보여 준다.
// 지표가 틀렸는지 모르는 채로 지표를 쌓으면 판단이 쌓인 만큼 틀린다.

export interface ColumnHealthRow {
  label: string;
  rows: number;
  nulls: number;
  applicability?: "used" | "unused";
  note?: string;
}

export interface ColumnHealth {
  label: string;
  rows: number;
  nulls: number;
  nullRate: number | null;
  /** 전부 비어 있는 컬럼. 그 컬럼에 기대는 지표는 지금 의미가 없다. */
  empty: boolean;
  applicability: "used" | "unused";
  note: string;
}

export function toColumnHealth(rows: ColumnHealthRow[]): ColumnHealth[] {
  return rows.map((row) => ({
    label: row.label,
    rows: row.rows,
    nulls: row.nulls,
    nullRate: row.rows ? Math.round((row.nulls / row.rows) * 1000) / 10 : null,
    empty: row.rows > 0 && row.nulls === row.rows,
    applicability: row.applicability ?? "used",
    note: row.note ?? "수집 대상 필드 · 누락 사유는 원본 계약과 상세 기록 확인",
  }));
}

export interface StageGap {
  stage: string;
  /** 서버 기록. 클라이언트 이벤트와 행동·기간·단위가 같다는 보장은 없다. */
  server: number;
  /** 클라이언트가 보낸 이벤트 수. */
  client: number;
  /** 클라 − 서버의 산술 차이. 부호만으로 원인을 판정하지 않는다. */
  gap: number;
  note: string;
  serverUnit: "jobs";
  clientUnit: "events";
  comparable: false;
}

export function toStageGaps(
  server: Record<string, number>,
  client: Record<string, number>,
): StageGap[] {
  const pairs: Array<{ stage: string; serverKey: string; clientKey: string; note: string }> = [
    { stage: "분석 요청 / 입력 확정", serverKey: "jobs", clientKey: "input_confirmed", note: "서버 접수와 입력 확정은 서로 다른 행동" },
    { stage: "분석 실패", serverKey: "failed", clientKey: "analysis_failed", note: "서버 작업 실패와 앱이 관찰한 실패는 범위가 다를 수 있음" },
    { stage: "포즈 사용 확정", serverKey: "selections", clientKey: "selection_confirmed", note: "서버 작업 수와 클라이언트 확정 이벤트 수의 비교" },
    { stage: "서버 내보내기 / 앱 저장", serverKey: "exports", clientKey: "export_completed", note: "서버 파일 제공 기록과 앱 저장 완료는 서로 다른 행동 · 실제 저장은 v2 nativeDiskWrite 기록 확인" },
  ];
  return pairs.map((pair) => {
    const serverCount = server[pair.serverKey] ?? 0;
    const clientCount = client[pair.clientKey] ?? 0;
    return {
      stage: pair.stage,
      server: serverCount,
      client: clientCount,
      gap: clientCount - serverCount,
      note: `${pair.note}. 기간 기준·동의 범위·앱 버전·집계 단위가 달라 원인은 미확정`,
      serverUnit: "jobs",
      clientUnit: "events",
      comparable: false,
    };
  });
}

// ── 거리 구간별 선택률 ───────────────────────────────────────
//
// `match_level`의 임계값(0.25 / 0.45)은 SEARCH_EVAL 시드값이고 코드에도 "실데이터로
// 반드시 보정할 것"이라 적혀 있다. 구간별 선택률이 곧 그 보정 근거다.

export interface DistanceBucketRow {
  bucket: string;
  jobs: number;
  selected: number;
}

export interface DistanceBucket {
  bucket: string;
  jobs: number;
  selected: number;
  selectionRate: number | null;
  usableDistance: boolean;
}

/** 구간 순서는 SQL의 CASE 순서와 맞춘다 — 화면에서 거리순으로 읽혀야 한다. */
export const DISTANCE_BUCKETS = ["≤0.15", "≤0.25", "≤0.35", "≤0.45", ">0.45", "없음"];

export function toDistanceBuckets(rows: DistanceBucketRow[]): DistanceBucket[] {
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  return DISTANCE_BUCKETS.map((bucket) => {
    const row = byBucket.get(bucket);
    const jobs = row?.jobs ?? 0;
    const selected = row?.selected ?? 0;
    return {
      bucket,
      jobs,
      selected,
      selectionRate: jobs ? Math.round((selected / jobs) * 1000) / 10 : null,
      usableDistance: bucket !== "없음",
    };
  }).filter((bucket) => bucket.jobs > 0);
}
