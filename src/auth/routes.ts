// /v1/auth — 인증(공개 라우트).
//   POST /register            : local 계정 생성(argon2) → 인증 메일 발송(토큰은 미발급)
//   POST /login               : local 검증 + 이메일 인증 확인 → access(JWT) + refresh
//   POST /refresh             : refresh 회전(이전 무효화)
//   POST /logout              : refresh 폐기
//   GET  /verify-email        : 이메일 인증 링크 처리
//   POST /resend-verification : 인증 메일 재발송
//   /oauth/:provider/...      : 소셜 로그인(google·kakao·naver)
// ⚠ 비밀번호·토큰을 로그에 남기지 않는다.
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { config } from "../config.js";
import { errorEnvelope } from "../mapping.js";
import {
  EmailTakenError,
  createUser,
  findByEmail,
  publicUser,
  setEmailVerified,
  verifyPassword,
} from "./users.js";
import {
  issueTokens,
  revokeRefresh,
  rotateRefresh,
  signEmailVerifyToken,
  verifyEmailVerifyToken,
} from "./tokens.js";
import { sendVerificationEmail } from "./mailer.js";
import { oauthRoutes } from "./oauth/routes.js";

export const authRoutes = new Hono<AppEnv>();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface Creds {
  email: string;
  password: string;
}

function parseCreds(body: unknown): Creds | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b["email"] !== "string" || typeof b["password"] !== "string") return null;
  const email = b["email"].trim();
  if (!EMAIL_RE.test(email) || b["password"].length < 8) return null;
  return { email, password: b["password"] };
}

function readString(body: unknown, key: string): string {
  if (body && typeof body === "object") {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return "";
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  return c.req.json().catch(() => null);
}

async function sendVerify(email: string, userId: string): Promise<void> {
  const token = await signEmailVerifyToken(userId);
  const link = `${config.publicUrl}/v1/auth/verify-email?token=${encodeURIComponent(token)}`;
  await sendVerificationEmail(email, link);
}

authRoutes.post("/register", async (c) => {
  const body = await readJson(c);
  const creds = parseCreds(body);
  if (!creds) {
    return c.json(
      errorEnvelope("INVALID_INPUT", "이메일 형식·비밀번호(8자 이상)를 확인하세요.", c.get("requestId")),
      400,
    );
  }
  const displayName = readString(body, "displayName") || creds.email.split("@")[0]!;
  try {
    const user = await createUser(creds.email, creds.password, displayName);
    await sendVerify(user.email, user.id);
    // ⚠ 이메일 인증 전이라 토큰은 발급하지 않는다.
    return c.json(
      {
        user: publicUser(user),
        requiresEmailVerification: true,
        message: "인증 메일을 보냈습니다. 이메일을 확인해 인증을 완료하세요.",
      },
      201,
    );
  } catch (e) {
    if (e instanceof EmailTakenError) {
      return c.json(errorEnvelope("EMAIL_TAKEN", "이미 등록된 이메일입니다.", c.get("requestId")), 409);
    }
    throw e;
  }
});

authRoutes.post("/login", async (c) => {
  const creds = parseCreds(await readJson(c));
  if (!creds) {
    return c.json(errorEnvelope("INVALID_INPUT", "이메일·비밀번호를 확인하세요.", c.get("requestId")), 400);
  }
  const user = findByEmail(creds.email);
  // local 계정이 아니거나(=소셜) 비번 불일치 → 동일 응답(계정 존재·가입방식 비노출)
  if (!user || user.provider !== "local" || !(await verifyPassword(user, creds.password))) {
    return c.json(
      errorEnvelope("INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다.", c.get("requestId")),
      401,
    );
  }
  if (!user.emailVerified) {
    return c.json(
      errorEnvelope("EMAIL_NOT_VERIFIED", "이메일 인증이 필요합니다. 메일함을 확인하거나 인증 메일을 다시 요청하세요.", c.get("requestId")),
      403,
    );
  }
  const tokens = await issueTokens(user.id);
  return c.json({ user: publicUser(user), ...tokens });
});

authRoutes.get("/verify-email", async (c) => {
  const token = c.req.query("token") ?? "";
  const page = (title: string, msg: string) =>
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px">
     <h2>${title}</h2><p>${msg}</p></body>`;
  try {
    const userId = await verifyEmailVerifyToken(token);
    setEmailVerified(userId);
    return c.html(page("이메일 인증 완료 ✅", "이제 로그인할 수 있습니다."));
  } catch {
    return c.html(page("인증 실패", "링크가 만료되었거나 올바르지 않습니다. 인증 메일을 다시 요청하세요."), 400);
  }
});

authRoutes.post("/resend-verification", async (c) => {
  const email = readString(await readJson(c), "email").trim();
  if (email) {
    const user = findByEmail(email);
    if (user && user.provider === "local" && !user.emailVerified) {
      await sendVerify(user.email, user.id);
    }
  }
  // 계정 존재 여부 비노출: 항상 동일 응답
  return c.json({ ok: true, message: "미인증 계정이라면 인증 메일을 다시 보냈습니다." });
});

authRoutes.post("/refresh", async (c) => {
  const token = readString(await readJson(c), "refreshToken");
  if (!token) {
    return c.json(errorEnvelope("INVALID_INPUT", "refreshToken이 필요합니다.", c.get("requestId")), 400);
  }
  try {
    return c.json(await rotateRefresh(token));
  } catch {
    return c.json(errorEnvelope("INVALID_TOKEN", "refresh 토큰이 유효하지 않습니다.", c.get("requestId")), 401);
  }
});

authRoutes.post("/logout", async (c) => {
  const token = readString(await readJson(c), "refreshToken");
  if (token) await revokeRefresh(token);
  return c.json({ ok: true });
});

// 소셜 로그인
authRoutes.route("/oauth", oauthRoutes);
