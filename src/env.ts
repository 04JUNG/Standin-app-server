// Hono 컨텍스트 변수 타입(요청 전역).
// requestId: 오류봉투·로깅. userId: requireAuth가 주입(인증된 요청).
export type AppEnv = {
  Variables: {
    requestId: string;
    userId?: string;
    installationId?: string;
  };
};
