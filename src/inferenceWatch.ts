// 추론 서버 헬스 감시. 상태가 **바뀔 때만** 알린다.
//
// 왜 필요한가: 추론 서버는 ALB에 붙어 있지 않아(무인증·내부 전용) 밖에서 아무도 보지
// 않는다. BFF의 /healthz가 추론 상태를 실어 나르지만, 그건 누군가 물어볼 때만 답한다.
// 추론이 조용히 죽으면 첫 분석 요청이 실패할 때까지 아무도 모른다.
//
// ⚠ 이 감시자는 BFF 프로세스 안에서 돈다. BFF 자체가 죽으면 같이 죽는다.
//   그 경우는 프로세스 밖 감시자(계획 4단계)가 담당한다.
import { config } from "./config.js";
import { health } from "./inference.js";
import { log } from "./log.js";
import { notify } from "./notify.js";

let consecutiveFailures = 0;
/** 이미 P1을 보낸 상태인지. 30초마다 같은 알림을 반복하지 않기 위해 상태 전이만 알린다. */
let reportedDown = false;

async function checkOnce(): Promise<void> {
  const ok = await health();

  if (ok) {
    if (reportedDown) {
      log.info({ type: "inference_health", status: 200, msg: "추론 서버 복구" });
      notify({
        severity: "P1",
        code: "INFERENCE_RECOVERED",
        message: "추론 서버가 헬스체크에 다시 응답합니다.",
        context: { 연속실패: consecutiveFailures },
      });
    }
    consecutiveFailures = 0;
    reportedDown = false;
    return;
  }

  consecutiveFailures += 1;
  log.warn({
    type: "inference_health",
    errorCode: "INFERENCE_UNHEALTHY",
    consecutiveFailures,
  });

  if (consecutiveFailures >= config.inferenceWatchFailureThreshold && !reportedDown) {
    reportedDown = true;
    notify({
      severity: "P1",
      code: "INFERENCE_DOWN",
      message: `추론 서버 헬스체크가 ${consecutiveFailures}회 연속 실패했습니다. 분석 요청이 전부 실패합니다.`,
      context: { url: config.inferenceBaseUrl },
    });
  }
}

/** 감시를 시작한다. 반환값은 정지 함수(테스트·종료용). */
export function startInferenceWatch(): () => void {
  const timer = setInterval(() => {
    void checkOnce().catch((error) => {
      // 감시자가 던지면 감시가 멈춘다. 여기서 끊는다.
      log.error({ type: "inference_health", errorCode: "WATCH_FAILED", errorName: String(error) });
    });
  }, config.inferenceWatchIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
