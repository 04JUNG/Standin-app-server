import { clientPolicyRoutes } from "./routes.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { createRequireInstallation } from "../installations/middleware.js";
import { installationRoutes } from "../installations/routes.js";
import { isSupportedClientVersion } from "./policy.js";

for (const value of [
  undefined,
  null,
  "",
  "garbage",
  "0.1.99",
  "0.1.1-beta.8",
  "0.2.0-beta.1",
  "0.2.0-rc.1+build",
  "0.02.0",
  "0.2",
  "0.2.0-01",
  "0.2.0+",
  "0.2.0,1.0.0",
]) {
  test(`rejects unsupported or invalid version ${String(value)}`, () => {
    assert.equal(isSupportedClientVersion(value), false);
  });
}
for (const value of ["0.2.0", "0.2.0+build.7", "0.2.1", "0.10.0", "1.0.0", "0.3.0-beta.1"]) {
  test(`accepts supported version ${value}`, () => {
    assert.equal(isSupportedClientVersion(value), true);
  });
}

function app(storedVersion: string) {
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => {
    c.set("requestId", "req_test");
    return next();
  });
  app.use(
    "*",
    createRequireInstallation(async (_id, token) =>
      token === "valid"
        ? {
            id: "inst_test",
            consentVersion: "2026-08-02",
            appVersion: storedVersion,
          }
        : null,
    ),
  );
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}
function headers(version?: string, token = "valid") {
  return {
    "X-Installation-Id": "inst_test",
    "X-Device-Token": token,
    ...(version === undefined ? {} : { "X-App-Version": version }),
  };
}

for (const path of [
  "/v1/analysis/jobs",
  "/v1/analysis/jobs/job_old",
  "/v1/pose-candidates/pose_a/export",
  "/v1/models",
  "/v1/semantic-search",
  "/v1/hands/poses",
  "/v1/events/batch",
  "/v1/installations/current/body-preferences",
]) {
  test(`existing headerless old installation cannot use ${path}`, async () => {
    const response = await app("0.1.1-beta.8").request(path, {
      headers: headers(),
    });
    assert.equal(response.status, 426);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: {
        code: "UPDATE_REQUIRED",
        message: "Standin 0.2.0 이상으로 업데이트해야 사용할 수 있습니다.",
        details: { minimumVersion: "0.2.0" },
        requestId: "req_test",
      },
    });
  });
}

test("upgrading an old installation works without re-registration", async () => {
  assert.equal(
    (
      await app("0.1.1-beta.8").request("/v1/models", {
        headers: headers("0.2.0"),
      })
    ).status,
    200,
  );
});
test("headerless supported installations remain supported", async () => {
  assert.equal((await app("0.2.0").request("/v1/models", { headers: headers() })).status, 200);
});
test("a downgrade or malformed explicit header cannot use the stored version", async () => {
  for (const version of ["0.1.9", "0.2.0-beta.1", "garbage", ""]) {
    assert.equal(
      (await app("0.2.0").request("/v1/models", { headers: headers(version) })).status,
      426,
    );
  }
});
test("invalid installation credentials still fail authentication", async () => {
  assert.equal(
    (
      await app("0.2.0").request("/v1/models", {
        headers: headers("0.2.0", "wrong"),
      })
    ).status,
    401,
  );
});
test("unsupported releases can withdraw data but cannot read body preferences", async () => {
  const old = app("0.1.1-beta.8");
  assert.equal(
    (
      await old.request("/v1/installations/current/data", {
        method: "DELETE",
        headers: headers(),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await old.request("/v1/installations/current/data", {
        method: "GET",
        headers: headers(),
      })
    ).status,
    426,
  );
});
test("old and invalid new registrations are rejected before creating an installation", async () => {
  const router = new Hono<AppEnv>().route("/v1/installations", installationRoutes);
  for (const appVersion of ["0.1.1-beta.8", "0.2.0-beta.1", "invalid", null]) {
    const response = await router.request("/v1/installations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appVersion }),
    });
    assert.equal(response.status, 426);
  }
});

test("startup policy endpoint checks versions without installation credentials", async () => {
  const router = new Hono<AppEnv>().route("/v1/client-policy", clientPolicyRoutes);
  for (const version of [undefined, "invalid", "0.1.9", "0.2.0-beta.1"]) {
    const response = await router.request("/v1/client-policy", {
      headers: version ? { "X-App-Version": version } : {},
    });
    assert.equal(response.status, 426);
  }
  const response = await router.request("/v1/client-policy", {
    headers: { "X-App-Version": "0.2.0" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { minimumVersion: "0.2.0" });
});
