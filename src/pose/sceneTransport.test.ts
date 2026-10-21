/** Private worker transport fixtures, not a deployed-worker integration test. */
import assert from "node:assert/strict";
import test from "node:test";
import { sceneRefinementRequest } from "../inference.js";

test("scene transport maps only observed status/domain evidence and never forwards private messages", async (t) => {
  const deps = { baseUrl: "https://private.test", token: "private-test-only", timeoutMs: 1000, fetch: globalThis.fetch };
  for (const [status, body, code] of [
    [429, "private", "SCENE_BUSY"],
    [503, JSON.stringify({ detail: "scene worker busy" }), "SCENE_BUSY"],
    [503, JSON.stringify({ detail: "unavailable" }), "SCENE_UNAVAILABLE"],
    [503, "not json", "SCENE_UNAVAILABLE"],
    [504, "private", "SCENE_TIMEOUT"],
    [422, JSON.stringify({ detail: "scene evidence or artifact was rejected" }), "SCENE_FAILED"],
    [500, JSON.stringify({ detail: "scene worker busy" }), "SCENE_FAILED"],
    [200, "not json", "SCENE_INTEGRITY"],
    [200, "[]", "SCENE_INTEGRITY"],
  ] as const) await t.test(`${status} / ${code}`, async () => {
    deps.fetch = async (url, options) => {
      assert.equal(url, "https://private.test/scene/plan");
      assert.equal(options?.redirect, "error");
      assert.ok(options?.signal);
      return new Response(body, { status });
    };
    await assert.rejects(sceneRefinementRequest("plan", {}, deps), (error: unknown) => {
      assert.equal((error as { code: string }).code, code);
      assert.ok(!(error as Error).message.includes("private"));
      return true;
    });
  });
  deps.fetch = async () => { throw new Error("network private URL"); };
  await assert.rejects(sceneRefinementRequest("plan", {}, deps), { code: "SCENE_UNAVAILABLE" });
  deps.timeoutMs = 5;
  deps.fetch = async (_url, options) => new Promise<Response>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture watchdog")), 100);
    options!.signal!.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(options!.signal!.reason);
    }, { once: true });
  });
  await assert.rejects(sceneRefinementRequest("plan", {}, deps), { code: "SCENE_TIMEOUT" });
});
