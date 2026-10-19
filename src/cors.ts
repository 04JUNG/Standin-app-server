import { cors } from "hono/cors";

/** Share the production edge policy with browser/webview regression tests. */
export function appCors(origins: string[]) {
  return cors({
    origin: origins,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "If-None-Match",
      "Authorization",
      "X-Installation-Id",
      "X-Device-Token",
      "X-Beta-Admin-Token",
    ],
    // 429 응답의 Retry-After를 웹뷰가 읽으려면 노출 목록에 있어야 한다(사용량 제한 안내).
    exposeHeaders: [
      "X-Standin-Poster-Kind",
      "X-Standin-Poster-Version",
      "Retry-After",
      "ETag",
      "X-Standin-Hand-Revision",
      "X-Standin-Preview-Only",
      "X-Standin-Character-Id",
      "X-Standin-Model-Version",
      "X-Standin-Hand-Library-SHA256",
      "X-Standin-Review-Key",
      "X-Standin-Body-Render-Key",
      "X-Standin-Body-Revision",
      "X-Standin-Body-Shape-SHA256",
      // Reference PNGs use these names when the webview checks shape and framing.
      "X-Standin-Shape-SHA256",
      "X-Standin-Preview-Projection",
      "X-Standin-Output-Scope",
      "X-Standin-Character-SHA256",
      "X-Standin-Source-BVH-SHA256",
      "X-Standin-Preview-Revision",
      "X-Standin-Model-Revision",
      "X-Standin-Artifact-SHA256",
      "X-Standin-Preview-Artifact-SHA256",
    ],
    credentials: true,
    maxAge: 600,
  });
}
