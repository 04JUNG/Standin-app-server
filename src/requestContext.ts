// 요청 컨텍스트(requestId·jobId·installationId)를 호출 스택 전체에 들고 다닌다.
//
// 왜 AsyncLocalStorage인가: 로그 한 줄과 추론 서버 호출에 requestId를 실으려면 원래는
// 모든 함수 시그니처에 requestId를 끼워 넣어야 한다(라우트 → 스토어 → 추론 클라이언트).
// 그 변경은 크고, 한 곳만 빠뜨려도 로그 계보가 조용히 끊긴다. ALS를 쓰면 미들웨어가
// 한 번 설정하고 로거·추론 클라이언트가 알아서 읽는다.
//
// ⚠ 컨텍스트는 비어 있을 수 있다(기동·타이머·백그라운드 잡). 읽는 쪽은 항상 undefined를
//   허용해야 한다 — 컨텍스트가 없다고 실패시키면 로깅이 장애 원인이 된다.
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
  jobId?: string;
  installationId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** fn 실행 동안(그 안에서 await하는 모든 것 포함) 컨텍스트를 유지한다. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * 진행 중인 컨텍스트에 값을 덧붙인다.
 *
 * jobId·installationId는 요청 시작 시점에는 없고 인증·Job 생성 뒤에 정해진다.
 * 컨텍스트가 없으면 조용히 무시한다(백그라운드 경로).
 */
export function amendContext(patch: Partial<RequestContext>): void {
  const context = storage.getStore();
  if (context) Object.assign(context, patch);
}
