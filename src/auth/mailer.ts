// 이메일 발송(인증 메일). SMTP 설정이 있으면 nodemailer로 발송, 없으면 콘솔에 링크 출력(dev).
import nodemailer from "nodemailer";
import { config } from "../config.js";
import { errorFields, log } from "../log.js";
import { notify } from "../notify.js";

export async function sendVerificationEmail(to: string, verifyLink: string): Promise<void> {
  if (!config.smtp.host) {
    if (process.env.NODE_ENV === "production") {
      log.error({ type: "mailer", errorCode: "SMTP_NOT_CONFIGURED" });
      notify({
        severity: "P2",
        code: "SMTP_NOT_CONFIGURED",
        message: "SMTP가 설정되지 않아 이메일 인증 메일을 보낼 수 없습니다. 가입이 막힙니다.",
      });
      throw new Error("SMTP is not configured");
    }
    // dev: SMTP 미설정 → 링크를 콘솔에 출력(실제 발송 없음).
    // ⚠ 이 줄에는 주소와 인증 토큰이 들어간다. 위 가드 때문에 production에서는
    //   절대 실행되지 않는다 — 구조화 로그가 아니라 개발자용 출력이다.
    console.log(`[mailer] SMTP 미설정. ${to} 인증 링크:\n  ${verifyLink}`);
    return;
  }
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  try {
    await transport.sendMail({
      from: config.smtp.from,
      to,
      subject: "[Standin] 이메일 인증",
      text: `Standin 이메일 인증을 완료하려면 아래 링크를 여세요:\n${verifyLink}\n\n본인이 요청하지 않았다면 무시하세요.`,
      html: `<p>Standin 이메일 인증을 완료하려면 아래 버튼을 누르세요.</p>
           <p><a href="${verifyLink}">이메일 인증하기</a></p>
           <p>본인이 요청하지 않았다면 무시하세요.</p>`,
    });
  } catch (error) {
    // 발송 실패는 사용자가 가입을 끝내지 못한다는 뜻이다. 로그만 남기면 아무도 모른다.
    // ⚠ 수신 주소는 남기지 않는다(PII). 사건이 일어났다는 사실만 알린다.
    log.error({ type: "mailer", errorCode: "SMTP_SEND_FAILED", ...errorFields(error) });
    notify({
      severity: "P2",
      code: "SMTP_SEND_FAILED",
      message: "이메일 인증 메일 발송에 실패했습니다. 신규 가입이 완료되지 않습니다.",
      context: { host: config.smtp.host },
    });
    throw error;
  }
}
