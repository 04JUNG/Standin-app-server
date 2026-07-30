// /v1/auth/oauth/:provider/{start,callback} — 소셜 로그인(authorization code flow).
// start: provider authorize로 302 리디렉트. callback: code 교환 → 프로필 조회 → 유저 upsert → 토큰 발급.
// state는 httpOnly 쿠키로 CSRF 방지.
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import type { AppEnv } from "../../env.js";
import { config } from "../../config.js";
import { errorEnvelope } from "../../mapping.js";
import {
  getProvider,
  redirectUri,
  type OAuthProviderConfig,
  type OAuthProviderName,
  type OAuthUserInfo,
} from "./config.js";
import { createOAuthUser, findByEmail, findByProvider } from "../users.js";
import { issueTokens } from "../tokens.js";
import { issueOAuthCode } from "../oauthCodes.js";

export const oauthRoutes = new Hono<AppEnv>();

const STATE_COOKIE = "oauth_state";

// GET /v1/auth/oauth/:provider/start
oauthRoutes.get("/:provider/start", (c) => {
  const name = c.req.param("provider");
  const provider = getProvider(name);
  if (!provider) {
    return c.json(
      errorEnvelope("PROVIDER_UNAVAILABLE", `'${name}' 소셜 로그인이 설정되지 않았습니다.`, c.get("requestId")),
      400,
    );
  }
  const state = randomUUID();
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, sameSite: "Lax", maxAge: 600, path: "/" });

  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", redirectUri(name as OAuthProviderName));
  if (provider.scope) url.searchParams.set("scope", provider.scope);
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
});

// GET /v1/auth/oauth/:provider/callback?code=&state=
oauthRoutes.get("/:provider/callback", async (c) => {
  const name = c.req.param("provider");
  const provider = getProvider(name);
  if (!provider) {
    return c.json(errorEnvelope("PROVIDER_UNAVAILABLE", "설정되지 않은 provider", c.get("requestId")), 400);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieState = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/" });
  if (!code || !state || !cookieState || state !== cookieState) {
    return c.json(errorEnvelope("OAUTH_STATE_MISMATCH", "state 불일치(CSRF 방지).", c.get("requestId")), 400);
  }

  let info: OAuthUserInfo;
  try {
    const accessToken = await exchangeCode(provider, name as OAuthProviderName, code, state);
    info = provider.extractProfile(await fetchProfile(provider, accessToken));
  } catch {
    return c.json(errorEnvelope("OAUTH_FAILED", "소셜 로그인 처리에 실패했습니다.", c.get("requestId")), 502);
  }

  if (!info.providerId) {
    return c.json(errorEnvelope("OAUTH_FAILED", "provider 프로필을 읽지 못했습니다.", c.get("requestId")), 502);
  }
  if (!info.email) {
    return c.json(
      errorEnvelope("EMAIL_REQUIRED", "소셜 계정에서 이메일을 받지 못했습니다. 이메일 제공에 동의해주세요.", c.get("requestId")),
      400,
    );
  }

  let user = await findByProvider(name as OAuthProviderName, info.providerId);
  if (!user) {
    // 같은 이메일이 다른 방식으로 이미 가입됨 → 자동 링크는 하지 않고 안내(보안)
    if (await findByEmail(info.email)) {
      return c.json(
        errorEnvelope("EMAIL_TAKEN", "이미 다른 방법으로 가입된 이메일입니다. 기존 방식으로 로그인하세요.", c.get("requestId")),
        409,
      );
    }
    const displayName = info.name ?? info.email.split("@")[0]!;
    user = await createOAuthUser(name as OAuthProviderName, info.providerId, info.email, displayName);
  }

  // 데스크톱 클라: 딥링크로 1회용 코드만 전달(OAUTH_SUCCESS_REDIRECT).
  // 토큰은 클라가 POST /v1/auth/oauth/exchange로 받아간다 — URL에 장기 자격증명을 남기지 않는다.
  if (config.oauthSuccessRedirect) {
    const r = new URL(config.oauthSuccessRedirect);
    r.searchParams.set("code", await issueOAuthCode(user.id));
    return c.redirect(r.toString());
  }
  // 미설정(dev/curl)이면 토큰을 그대로 돌려준다.
  return c.json(await issueTokens(user.id));
});

async function exchangeCode(
  provider: OAuthProviderConfig,
  name: OAuthProviderName,
  code: string,
  state: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    redirect_uri: redirectUri(name),
    code,
    state, // naver는 token 요청에 state 필요(google·kakao는 무시)
  });
  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("no access_token");
  return json.access_token;
}

async function fetchProfile(provider: OAuthProviderConfig, accessToken: string): Promise<unknown> {
  const res = await fetch(provider.userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`userinfo ${res.status}`);
  return res.json();
}
