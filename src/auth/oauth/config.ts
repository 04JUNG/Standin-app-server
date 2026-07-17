// 소셜 로그인 provider 레지스트리(구글·카카오·네이버). 키는 env(config.oauth)에서 주입.
import { config } from "../../config.js";

export type OAuthProviderName = "google" | "kakao" | "naver";

export interface OAuthUserInfo {
  providerId: string;
  email?: string;
  name?: string;
}

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  extractProfile: (raw: unknown) => OAuthUserInfo;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

type Registry = Record<OAuthProviderName, Omit<OAuthProviderConfig, "clientId" | "clientSecret">>;

const REGISTRY: Registry = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
    extractProfile: (raw) => {
      const u = rec(raw);
      return { providerId: str(u["sub"]) ?? "", email: str(u["email"]), name: str(u["name"]) };
    },
  },
  kakao: {
    authorizeUrl: "https://kauth.kakao.com/oauth/authorize",
    tokenUrl: "https://kauth.kakao.com/oauth/token",
    userinfoUrl: "https://kapi.kakao.com/v2/user/me",
    scope: "account_email profile_nickname",
    extractProfile: (raw) => {
      const u = rec(raw);
      const account = rec(u["kakao_account"]);
      const profile = rec(account["profile"]);
      return {
        providerId: str(u["id"]) ?? "",
        email: str(account["email"]),
        name: str(profile["nickname"]),
      };
    },
  },
  naver: {
    authorizeUrl: "https://nid.naver.com/oauth2.0/authorize",
    tokenUrl: "https://nid.naver.com/oauth2.0/token",
    userinfoUrl: "https://openapi.naver.com/v1/nid/me",
    scope: "",
    extractProfile: (raw) => {
      const response = rec(rec(raw)["response"]);
      return {
        providerId: str(response["id"]) ?? "",
        email: str(response["email"]),
        name: str(response["name"]) ?? str(response["nickname"]),
      };
    },
  },
};

export function isProviderName(name: string): name is OAuthProviderName {
  return name === "google" || name === "kakao" || name === "naver";
}

// 설정된(키가 있는) provider만 반환. 미설정이면 null.
export function getProvider(name: string): OAuthProviderConfig | null {
  if (!isProviderName(name)) return null;
  const keys = config.oauth[name];
  if (!keys.clientId) return null;
  return { ...REGISTRY[name], clientId: keys.clientId, clientSecret: keys.clientSecret };
}

export function redirectUri(name: OAuthProviderName): string {
  return `${config.publicUrl}/v1/auth/oauth/${name}/callback`;
}
