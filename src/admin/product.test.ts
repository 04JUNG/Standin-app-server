import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { COHORT_SQL } from "./productStore.js";
import { DAILY_AGGREGATES_SQL } from "./qualityStore.js";
import { toAccuracy } from "./quality.js";
import {
  WINDOW_DAYS_DEFAULT,
  WINDOW_DAYS_MAX,
  parseWindowDays,
  rate,
  toCohorts,
  toDropoff,
  toFunnel,
  type FunnelRow,
} from "./product.js";

function funnelRow(overrides: Partial<FunnelRow> = {}): FunnelRow {
  return {
    active_installations: 100,
    jobs_started: 160,
    installations_started: 80,
    jobs_completed: 140,
    installations_completed: 70,
    jobs_failed: 20,
    jobs_selected: 84,
    installations_selected: 42,
    jobs_exported: 40,
    installations_exported: 20,
    ...overrides,
  };
}

test("기간은 1~90일 정수만 받는다", () => {
  const fallback = parseWindowDays(undefined);
  assert.equal(fallback.ok && fallback.days, WINDOW_DAYS_DEFAULT);
  assert.equal(parseWindowDays("0").ok, false);
  assert.equal(parseWindowDays("7.5").ok, false);
  assert.equal(parseWindowDays(String(WINDOW_DAYS_MAX + 1)).ok, false);
  const ok = parseWindowDays("30");
  assert.equal(ok.ok && ok.days, 30);
});

test("분모가 0이면 0%가 아니라 null이다", () => {
  // "아무도 없었다"와 "전부 이탈했다"를 같은 값으로 보여 주면 판단이 뒤집힌다.
  assert.equal(rate(0, 0), null);
  assert.equal(rate(0, 10), 0);
  assert.equal(rate(1, 3), 33.3);
});

test("퍼널은 직전 대비와 투입 대비를 함께 낸다", () => {
  const stages = toFunnel(funnelRow());
  assert.deepEqual(stages.map((s) => s.key), ["active", "started", "completed", "selected", "exported"]);
  // 첫 단계는 비교 대상이 없다
  assert.equal(stages[0].fromPrevious, null);
  assert.equal(stages[0].jobs, null);
  // 러프 투입 80명 → 분석 성공 70명
  assert.equal(stages[2].fromPrevious, 87.5);
  assert.equal(stages[2].fromStarted, 87.5);
  // 선택 42명 / 성공 70명, 투입 80명 대비 52.5%
  assert.equal(stages[3].fromPrevious, 60);
  assert.equal(stages[3].fromStarted, 52.5);
  assert.equal(stages[4].fromStarted, 25);
});

test("활동이 없으면 비율이 전부 null이다", () => {
  const stages = toFunnel(funnelRow({
    active_installations: 0, jobs_started: 0, installations_started: 0,
    jobs_completed: 0, installations_completed: 0, jobs_selected: 0,
    installations_selected: 0, jobs_exported: 0, installations_exported: 0,
  }));
  assert.equal(stages[2].fromPrevious, null);
  assert.equal(stages[3].fromStarted, null);
});

test("코호트는 비중을 내고 문제 그룹을 표시한다", () => {
  const items = toCohorts({
    installed_only: 10, failed_only: 5, completed_no_selection: 25,
    selected_no_export: 10, exported: 50, total: 100,
  });
  assert.equal(items.length, 6);
  const problem = items.find((i) => i.key === "completedNoSelection");
  assert.equal(problem?.share, 25);
  assert.equal(problem?.highlight, true);
  assert.equal(items.find((i) => i.key === "exported")?.share, 50);
});

test("작업 전환율과 설치 전환율을 서로 다른 분모로 제공한다", () => {
  const stages = toFunnel(funnelRow({jobs_started: 15, jobs_completed: 15, jobs_selected: 5,
    installations_started: 5, installations_completed: 5, installations_selected: 2}));
  assert.equal(stages[3].rateBasis, "installations");
  assert.equal(stages[3].fromPrevious, 40);
  assert.equal(stages[3].jobFromPrevious, 33.3);
  assert.equal(stages[3].jobFromStarted, 33.3);
  assert.equal(stages[1].jobFromPrevious, null);
  assert.equal(stages[4].label, "서버 내보내기 기록");
});

test("거리 평균에는 유효 작업 표본과 기록 비율을 함께 제공한다", () => {
  const result = toDropoff([{selected:false, jobs:10, zero_people_jobs:0, shortfall_jobs:0,
    avg_best_distance:0.2,avg_people:1,distance_samples:2}],[],[],0);
  assert.equal(result.notSelected.distanceSamples, 2);
  assert.equal(result.notSelected.distanceCoverageRate, 20);
  assert.equal(result.selected.distanceCoverageRate, null);
});

test("실제 SQL은 진행 중 작업을 실패로 세지 않고 선택 작업과 인물 순위 표본을 분리한다", async () => {
  const db = new PGlite();
  try {
    const {rows:[{today}]} = await db.query<{today:string}>("SELECT current_date::text AS today");
    const at = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString();
    const from = new Date(Date.parse(at) - 86400000).toISOString();
    await db.exec(`CREATE TABLE quality_review_installations(id text,last_seen_at text);
      CREATE TABLE quality_review_jobs(id text,installation_id text,created_at text,status text);
      CREATE TABLE quality_review_confirmed_selections(job_id text,rank int);
      CREATE TABLE quality_review_export_events(job_id text,status text);
      CREATE TABLE quality_review_job_feedback(job_id text,reason text);`);
    for (const id of ["only","failed","pending","complete","selected","exported"])
      await db.query("INSERT INTO quality_review_installations VALUES ($1,$2)",[id,at]);
    for (const [id,inst,status] of [["f","failed","failed"],["p","pending","queued"],["p2","pending","failed"],
      ["c","complete","completed"],["s","selected","completed"],["e","exported","completed"]])
      await db.query("INSERT INTO quality_review_jobs VALUES ($1,$2,$3,$4)",[id,inst,at,status]);
    await db.exec(`INSERT INTO quality_review_confirmed_selections VALUES ('s',1),('e',1);
      INSERT INTO quality_review_export_events VALUES ('e','completed'),('e','completed');`);
    const cohort = (await db.query<Record<string,number>>(COHORT_SQL,[from])).rows[0];
    assert.deepEqual(cohort,{installed_only:1,failed_only:1,pending:1,completed_no_selection:1,
      selected_no_export:1,exported:1,total:6});
    // Isolated three-job cohort: one job has three selected people, two valid ranks,
    // two export attempts. An unselected job's export must not inflate the conversion.
    await db.exec(`DELETE FROM quality_review_jobs; DELETE FROM quality_review_confirmed_selections;
      DELETE FROM quality_review_export_events;`);
    for (const [id,status] of [["selectedjob","completed"],["emptyjob","completed"],["failedjob","failed"]])
      await db.query("INSERT INTO quality_review_jobs VALUES ($1,'inst',$2,$3)",[id,at,status]);
    await db.exec(`INSERT INTO quality_review_confirmed_selections VALUES ('selectedjob',1),('selectedjob',3),('selectedjob',null);
      INSERT INTO quality_review_export_events VALUES ('selectedjob','completed'),('selectedjob','completed'),('emptyjob','completed');`);
    const daily = (await db.query(DAILY_AGGREGATES_SQL,[7])).rows as unknown as Parameters<typeof toAccuracy>[0];
    const accuracy = toAccuracy(daily);
    assert.equal(accuracy.selections,1);
    assert.equal(accuracy.selectionRate,50);
    assert.equal(accuracy.rankSamples,2);
    assert.equal(accuracy.rankSelectionSamples,3);
    assert.equal(accuracy.rankCoverageRate,66.7);
    assert.equal(accuracy.top1Rate,50);
    assert.equal(accuracy.meanReciprocalRank,0.667);
    assert.equal(accuracy.exportRate,100);
  } finally { await db.close(); }
});

test("이탈 신호는 선택 여부로 갈라 비교한다", () => {
  const dropoff = toDropoff(
    [
      // 거리는 낮을수록 좋다 — 고른 쪽이 더 가깝다.
      { selected: true, jobs: 40, zero_people_jobs: 0, shortfall_jobs: 2, avg_best_distance: 0.1823, avg_people: 1.5 },
      { selected: false, jobs: 60, zero_people_jobs: 12, shortfall_jobs: 18, avg_best_distance: 0.4567, avg_people: 0.9 },
    ],
    [
      { selected: true, match_level: "exact", count: 30 },
      { selected: true, match_level: "near", count: 10 },
      { selected: false, match_level: "near", count: 45 },
      { selected: false, match_level: "far", count: 15 },
    ],
    [{ reason: "포즈가 달라요", count: 7 }],
    9,
  );

  assert.equal(dropoff.selected.avgBestDistance, 0.182);
  assert.equal(dropoff.notSelected.avgBestDistance, 0.457);
  // 인물 0명이 이탈 쪽에만 쏠린다 — 화면에서 바로 눈에 띄어야 하는 차이
  assert.equal(dropoff.selected.zeroPeopleRate, 0);
  assert.equal(dropoff.notSelected.zeroPeopleRate, 20);
  assert.equal(dropoff.notSelected.shortfallRate, 30);
  // match_level은 자기 집단 안에서의 비중으로 낸다
  assert.deepEqual(dropoff.selected.matchLevels[0], { level: "exact", count: 30, share: 75 });
  assert.equal(dropoff.notSelected.matchLevels[0].level, "near");
  assert.equal(dropoff.rerunJobs, 9);
  assert.equal(dropoff.feedback[0].count, 7);
});

test("한쪽 집단이 비어 있어도 깨지지 않는다", () => {
  // 기간 내 선택이 하나도 없으면 SQL이 그 행을 내지 않는다.
  const dropoff = toDropoff(
    [{ selected: false, jobs: 3, zero_people_jobs: 1, shortfall_jobs: 0, avg_best_distance: null, avg_people: null }],
    [],
    [],
    0,
  );
  assert.equal(dropoff.selected.jobs, 0);
  assert.equal(dropoff.selected.avgBestDistance, null);
  assert.deepEqual(dropoff.selected.matchLevels, []);
  assert.equal(dropoff.notSelected.zeroPeopleRate, 33.3);
});
