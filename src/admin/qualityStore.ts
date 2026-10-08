// 정확도·사용률 지표가 읽는 SQL. 순수 변환은 `quality.ts`에 있다.
import { query } from "../db.js";
import type { DailyAggregateRow } from "./quality.js";

/**
 * 창 안의 일별 집계. 원본 테이블이 아니라 `daily_analytics_aggregates`를 읽는다.
 *
 * 이 표는 `refreshAggregatesAndRetention`이 기동과 유지보수 때 다시 계산하고, **오늘은
 * 넣지 않는다**(`day < current_date`). 그래서 여기 결과도 어제까지다. 하루가 끝나기
 * 전에 숫자가 오르내리는 것을 지표로 착각하지 않게 하려는 기존 규칙을 그대로 따른다.
 */
export async function dailyAggregates(days: number): Promise<DailyAggregateRow[]> {
  return query<DailyAggregateRow>(
    `SELECT day, jobs_started, jobs_completed, jobs_failed, confirmed_selections,
            top1_selections, mean_reciprocal_rank, exports_completed, feedback_json
       FROM daily_analytics_aggregates
      WHERE day >= to_char(current_date - $1::int, 'YYYY-MM-DD')
      ORDER BY day`,
    [days],
  );
}
