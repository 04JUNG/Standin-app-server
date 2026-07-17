// 이메일 발송(인증 메일). SMTP 설정이 있으면 nodemailer로 발송, 없으면 콘솔에 링크 출력(dev).
import nodemailer from "nodemailer";
import { config } from "../config.js";

export async function sendVerificationEmail(to: string, verifyLink: string): Promise<void> {
  if (!config.smtp.host) {
    // dev: SMTP 미설정 → 링크를 콘솔에 출력(실제 발송 없음)
    console.log(`[mailer] SMTP 미설정. ${to} 인증 링크:\n  ${verifyLink}`);
    return;
  }
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  await transport.sendMail({
    from: config.smtp.from,
    to,
    subject: "[Standin] 이메일 인증",
    text: `Standin 이메일 인증을 완료하려면 아래 링크를 여세요:\n${verifyLink}\n\n본인이 요청하지 않았다면 무시하세요.`,
    html: `<p>Standin 이메일 인증을 완료하려면 아래 버튼을 누르세요.</p>
           <p><a href="${verifyLink}">이메일 인증하기</a></p>
           <p>본인이 요청하지 않았다면 무시하세요.</p>`,
  });
}
