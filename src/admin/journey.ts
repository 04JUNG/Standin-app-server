/** Job-cohort observations, not inferred user intent or a strict ordered funnel. */
export const JOURNEY_STAGES = [
  ["requested", "분석 요청"], ["completed", "분석 완료"],
  ["results_viewed", "결과 표시"], ["candidate_selected", "후보 선택"],
  ["selection_confirmed", "사용 확정"], ["review_viewed", "저장 전 화면"],
  ["preparation_ready", "파일 준비 완료"], ["export_requested", "저장 요청"],
  ["export_completed", "실제 파일 저장"],
] as const;
export type JourneyKey = typeof JOURNEY_STAGES[number][0];
export interface JourneyEvent {
  name: string; first: string; last: string; count: number;
  version: number; native: boolean; session: boolean; appVersion?: string; surface?: string;
}
export interface JourneyRow {
  id: string; installation_id: string; audience: "internal" | "unclassified";
  created_at: string; completed_at: string | null; status: string;
  confirmed_at: string | null; events: JourneyEvent[];
  last_outcome: string | null; last_outcome_at: string | null;
}
export interface JourneyWindow { from: string; to: string; days: number; idleMinutes: number; audience: string }
const ms = (s: string | null | undefined) => s ? Date.parse(s) : NaN;
const safeTime = (s: string | null | undefined, w: JourneyWindow) =>
  Number.isFinite(ms(s)) && ms(s) >= ms(w.from) && ms(s) <= ms(w.to);
export function buildJourney(rows: JourneyRow[], window: JourneyWindow) {
  const now = ms(window.to), idle = window.idleMinutes * 60000;
  const jobs = rows.map(row => {
    const events = row.events.filter(e => safeTime(e.first, window));
    const v2 = events.filter(e => e.version === 2 && e.session);
    const times: Partial<Record<JourneyKey, number>> = { requested: ms(row.created_at) };
    if (row.status === "completed" && safeTime(row.completed_at, window)) times.completed = ms(row.completed_at);
    if (safeTime(row.confirmed_at, window)) times.selection_confirmed = ms(row.confirmed_at);
    for (const [key] of JOURNEY_STAGES) {
      const candidates = v2.filter(e => e.name === key && (key !== "export_completed" || e.native));
      for (const e of candidates) times[key] = Math.min(times[key] ?? Infinity, ms(e.first));
    }
    const last = Math.max(ms(row.created_at), ...Object.values(times), ...v2.map(e => ms(e.last)));
    const observable = v2.length > 0;
    // A terminal outcome only applies until a later preparation/request/success. SQL selects
    // the latest relevant event by occurrence time, sequence and event ID, not arrival order.
    const outcome = times.export_completed !== undefined ? "saved"
      : row.status === "failed" ? "failed"
      : row.status === "queued" || row.status === "running" ? "waiting"
      : !observable ? "unobservable"
      : row.last_outcome === "export_failed" || row.last_outcome === "preparation_failed" ? "failed"
      : row.last_outcome === "export_cancelled" ? "cancelled"
      : now - last < idle ? "waiting" : "noNextEvent";
    return { row, events, v2, times, last, observable, outcome };
  });
  const stages = JOURNEY_STAGES.map(([key,label]) => {
    const reached = jobs.filter(j => j.times[key] !== undefined);
    return {key,label,jobs:reached.length,installations:new Set(reached.map(j=>j.row.installation_id)).size};
  });
  const transitions = JOURNEY_STAGES.slice(0,-1).map(([from], index) => {
    const to = JOURNEY_STAGES[index+1][0];
    const counts = {from,to,reached:0,advanced:0,waiting:0,noNextEvent:0,unobservable:0,failed:0,cancelled:0};
    for (const j of jobs) {
      if (j.times[from] === undefined) continue;
      counts.reached++;
      if (j.times[to] !== undefined && j.times[to]! >= j.times[from]!) { counts.advanced++; continue; }
      // A later observed stage proves the intervening telemetry is missing; never label it abandonment.
      const laterSeen = JOURNEY_STAGES.slice(index+2).some(([key]) => j.times[key] !== undefined);
      if (to === "completed" && (j.row.status === "queued" || j.row.status === "running")) counts.waiting++;
      else if (laterSeen || j.times[to] !== undefined || (!j.observable && to !== "completed")) counts.unobservable++;
      else if (j.outcome === "failed") counts.failed++;
      else if (j.outcome === "cancelled") counts.cancelled++;
      else if (now - j.last < idle) counts.waiting++;
      else counts.noNextEvent++;
    }
    return counts;
  });
  const outcomes = {saved:0,failed:0,cancelled:0,waiting:0,noNextEvent:0,unobservable:0};
  for (const j of jobs) outcomes[j.outcome as keyof typeof outcomes]++;
  const percentile = (values:number[],q:number) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a,b)=>a-b);
    const position = (sorted.length-1)*q, lower = Math.floor(position), upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper]-sorted[lower])*(position-lower);
  };
  const durations = ([
    ["analysis", "분석 요청 → 완료", "requested", "completed"],
    ["firstSave", "분석 요청 → 첫 실제 저장", "requested", "export_completed"],
  ] as const).map(([key,label,start,end])=> {
    const values = jobs.flatMap(j=> j.times[start] !== undefined && j.times[end] !== undefined && j.times[end]! >= j.times[start]! ? [j.times[end]!-j.times[start]!] : []);
    return {key,label,samples:values.length,medianMs:percentile(values,.5),p90Ms:percentile(values,.9)};
  });
  const segmentMap = new Map<string,{appVersion:string;surface:string;jobs:Set<string>;installations:Set<string>;savedJobs:Set<string>}>();
  for (const j of jobs) for (const e of j.v2) {
    const appVersion = e.appVersion ?? "unknown", surface = e.surface ?? "unknown";
    const key = JSON.stringify([appVersion,surface]);
    const segment = segmentMap.get(key) ?? {appVersion,surface,jobs:new Set<string>(),installations:new Set<string>(),savedJobs:new Set<string>()};
    segment.jobs.add(j.row.id);segment.installations.add(j.row.installation_id);
    if(e.name === "export_completed" && e.native) segment.savedJobs.add(j.row.id);
    segmentMap.set(key,segment);
  }
  const segments = [...segmentMap.values()].map(s=>({appVersion:s.appVersion,surface:s.surface,jobs:s.jobs.size,installations:s.installations.size,savedJobs:s.savedJobs.size}));
  const diagnostics = ([['thumbnail_failed','썸네일 실패'],['analysis_failed','분석 실패 보고'],['preparation_failed','파일 준비 실패'],['export_failed','저장 실패'],['export_cancelled','저장 취소']] as const).map(([key,label])=>({key,label,jobs:jobs.filter(j=>j.v2.some(e=>e.name===key)).length,events:jobs.reduce((n,j)=>n+j.v2.filter(e=>e.name===key).reduce((sum,e)=>sum+e.count,0),0)}));
  return {window,segments,diagnostics,totals:{jobs:jobs.length,installations:new Set(rows.map(r=>r.installation_id)).size,
    observableJobs:jobs.filter(j=>j.observable).length,unobservableJobs:jobs.filter(j=>!j.observable).length},
    stages,transitions,outcomes,durations,
    coverage:{version2Jobs:jobs.filter(j=>j.observable).length,
      legacyEventJobs:jobs.filter(j=>!j.observable && j.events.length>0).length,
      noClientEventJobs:jobs.filter(j=>j.events.length===0).length},
    audiences:(["internal","unclassified"] as const).map(key=>{const rs=rows.filter(r=>r.audience===key);return {key,jobs:rs.length,installations:new Set(rs.map(r=>r.installation_id)).size};}),
    notes:["분석 요청 시점이 기간 안인 작업을 같은 분모로 집계합니다. 설치 수는 사람 수가 아닙니다.",
      "단계별 수는 관측된 작업 수입니다. 일부 계측이 없어 뒤 단계가 더 많을 수 있습니다.",
      "무후속 기록은 이탈 원인이 아닙니다. 대기 시간 이후 후속 이벤트가 관측되지 않은 상태입니다.",
      "새 계측 버전의 기록이 없는 작업은 관측 불가로 분리합니다. 과거 데이터는 소급 생성하지 않습니다.",
      "내부 표시가 없는 설치는 미분류입니다. 외부 사용자로 단정하지 않습니다. 기존 개발자 제외 설정을 따릅니다.",
      "실제 저장은 새 클라이언트가 nativeDiskWrite=true로 보고한 완료만 셉니다. 서버 파일 생성과 다릅니다.",
      "앱 버전·화면별 작업 수는 중복될 수 있습니다. 동일 작업을 여러 화면에서 연 경우 각각 관측됩니다.",
      "파일 준비는 병렬로 끝날 수 있어 단계 순서가 바뀌면 해당 전환은 관측 불가로 표시합니다.",
      "성공은 작업의 최초 저장 도달 여부입니다. 이후 재저장 실패가 있어도 첫 성공을 취소하지 않습니다."]};
}
