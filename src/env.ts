// Hono 컨텍스트 변수 타입(요청 전역). requestId는 오류봉투·로깅에 쓰인다.
export type AppEnv = {
  Variables: {
    requestId: string;
    // TODO(Phase 1): userId?: string;  // requireAuth가 주입
  };
};
