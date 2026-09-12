// Hono 컨텍스트 변수 타입(요청 전역).
// requestId: 오류봉투·로깅. userId: requireAuth가 주입(인증된 요청).
export type AppEnv = {
  Variables: {
    requestId: string;
    userId?: string;
    installationId?: string;
    /** 관리자 경로에서 토큰으로 식별한 검토자 이름. 감사 로그에 그대로 남는다. */
    reviewer?: string;
  };
};
