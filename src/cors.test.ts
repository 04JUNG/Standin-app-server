import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { appCors } from "./cors.js";

// Use the production middleware: route tests alone can read headers a webview cannot.
for (const origin of ["tauri://localhost", "http://tauri.localhost", "http://localhost:1420"]) {
  test(`preview integrity headers are readable from ${origin}`, async () => {
    const headers = {
      "X-Standin-Poster-Variant": "rough-yaw8-v1",
      "X-Standin-Poster-Yaw": "45",
      "X-Standin-Poster-Fallback": "none",
      "X-Standin-Poster-Camera-Source": "fixed_117",
      "X-Standin-Poster-Requested-Yaw": "30",
      "X-Standin-Projection-Matches-Search": "false",
      "X-Standin-Poster-Asset-Version": "scope8-v1",
      "X-Standin-Asset-Library-Version": "lib-20261021-12345678",
      "X-Standin-Preview-View": "yaw_315",
      "Content-Type": "image/png",
      "X-Standin-Body-Revision": "4",
      "X-Standin-Character-SHA256": "a".repeat(64),
      "X-Standin-Shape-SHA256": "b".repeat(64),
      "X-Standin-Source-BVH-SHA256": "c".repeat(64),
      "X-Standin-Review-Key": "f".repeat(64),
      "X-Standin-Preview-Artifact-SHA256": "e".repeat(64),
      "X-Standin-Artifact-SHA256": "d".repeat(64),
      "X-Standin-Scene-Contract": "scene-save-v1",
      "X-Standin-Scene-Save-Mode": "original-selection",
      "X-Standin-Scene-Version": "rough-layout-v1",
      "X-Standin-Person-Count": "3",
      "X-Standin-Scene-Manifest-Version": "csp-scene-manifest-v1",
      "X-Standin-Scene-Snapshot-SHA256": "a".repeat(64),
      "X-Standin-File-Count": "1",
      "X-Standin-Output-Scope": "half",
      "X-Standin-Preview-Projection": "orthographic",
      "X-Standin-Preview-Only": "true",
    };
    const app = new Hono().use("*", appCors([origin])).get("/preview", () =>
      new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers }),
    );
    const response = await app.request("/preview", { headers: { Origin: origin } });
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
    const exposed = new Set((response.headers.get("Access-Control-Expose-Headers") ?? "")
      .toLowerCase().split(",").map((h) => h.trim()));
    for (const name of Object.keys(headers).filter((h) => h.startsWith("X-Standin-"))) {
      assert.ok(response.headers.has(name), name);
      assert.ok(exposed.has(name.toLowerCase()), `webview cannot read ${name}`);
    }
    assert.ok(!exposed.has("*"));
    assert.ok(!exposed.has("authorization"));
    assert.ok(!exposed.has("x-device-token"));
  });
}

test("unknown origins remain outside the edge allowlist", async () => {
  const app = new Hono().use("*", appCors(["tauri://localhost"])).get("/preview", (c) => c.text("ok"));
  const response = await app.request("/preview", { headers: { Origin: "https://untrusted.invalid" } });
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

for (const origin of ["tauri://localhost", "http://tauri.localhost", "http://localhost:1420"]) {
  test(`version header passes production preflight from ${origin}`, async () => {
    const app = new Hono().use("*", appCors([origin]));
    const response = await app.request("/v1/models", { method: "OPTIONS", headers: {
      Origin: origin, "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "x-app-version,x-installation-id,x-device-token",
    } });
    assert.equal(response.status, 204);
    assert.ok(response.headers.get("Access-Control-Allow-Headers")?.toLowerCase().includes("x-app-version"));
  });
}
