import { bodyUxAvailable } from "./availability.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { CutResult } from "../inference.js";
import type { AnalysisResult } from "../types.js";
import { mapCutResult } from "../mapping.js";
import { config } from "../config.js";
import { parseCatalog } from "./catalog.js";
import { mapBodyRecommendations } from "./recommendation.js";
import {
  bodyRef,
  defaultPreferences,
  resolveBody,
  snapshot,
  type BodyCatalog,
} from "./model.js";
import {
  createBodySelectionRoutes,
  createBodyPreferenceRoutes,
  parsePreferenceChange,
  parseSelectionChange,
} from "./routes.js";
import { BodyError, bodyStore } from "./store.js";
import { catalog, fixture, result } from "./fixtures.js";
const recommendation = () =>
  mapBodyRecommendations(fixture(), catalog()).get(0)!;
test("automatic default, manual priority, fixed default and per-person auto exception", () => {
  const c = catalog(),
    policy = snapshot(
      { ...defaultPreferences(), defaultCharacterId: "character-0" },
      c,
    );
  const rec = recommendation();
  assert.equal(
    resolveBody(0, policy, rec, c, ["pose-a"]).resolvedBody?.characterId,
    "character-1",
  );
  policy.preferences.mode = "fixed_default";
  assert.equal(
    resolveBody(0, policy, rec, c, ["pose-a"]).resolvedSource,
    "fixed_default",
  );
  assert.equal(
    resolveBody(0, policy, rec, c, ["pose-a"], "auto").resolvedBody
      ?.characterId,
    "character-1",
  );
  assert.equal(
    resolveBody(0, policy, rec, c, ["pose-a"], "manual", bodyRef(c.assets[2]))
      .resolvedBody?.characterId,
    "character-2",
  );
  assert.equal(policy.preferences.mode, "fixed_default");
});
test("defaults never impersonate detection and snapshots survive preference changes", () => {
  const c = catalog(),
    p = { ...defaultPreferences(), defaultCharacterId: "character-2" };
  const policy = snapshot(p, c);
  p.defaultCharacterId = "character-0";
  const rec = {
    status: "unavailable" as const,
    body: null,
    reasonCodes: ["provider_error"],
  };
  assert.equal(
    resolveBody(0, policy, rec, c, ["pose-a"]).resolvedSource,
    "user_default_fallback",
  );
  assert.equal(policy.userDefault?.characterId, "character-2");
  assert.equal(
    resolveBody(0, policy, rec, c, ["pose-a"], "auto").resolutionStatus,
    "unavailable",
  );
  assert.equal(
    resolveBody(0, policy, rec, c, []).resolutionStatus,
    "not_applicable",
  );
});
test("changed or unsupported assets do not silently replace manual/fixed choices", () => {
  const c = catalog(),
    policy = snapshot(
      {
        ...defaultPreferences(),
        mode: "fixed_default",
        defaultCharacterId: "character-0",
      },
      c,
    );
  const chosen = bodyRef(c.assets[0]);
  c.assets[0].assetSha256 = "f".repeat(64);
  const fixed = resolveBody(0, policy, recommendation(), c, ["pose-a"]);
  assert.equal(fixed.resolutionStatus, "unavailable");
  assert.deepEqual(fixed.resolvedBody, chosen);
  assert.equal(
    resolveBody(
      0,
      policy,
      recommendation(),
      c,
      ["not-supported"],
      "manual",
      chosen,
    ).resolutionStatus,
    "unavailable",
  );
});
test("catalog supports arbitrary 1/9/12 model counts and IDs; rejects duplicate/malformed references", () => {
  for (const count of [1, 9, 12])
    assert.equal(parseCatalog(catalog(count)).assets.length, count);
  const c = catalog();
  c.assets.push(c.assets[0]);
  assert.throws(() => parseCatalog(c));
  assert.throws(() =>
    parseCatalog({ version: "bad", defaultCharacterId: null, assets: [{}] }),
  );
});
test("sidecar accepts valid joins; legacy, shadow, wrong person/order/hash are isolated", () => {
  assert.equal(recommendation().body?.bodyId, "shape-1");
  const c = fixture();
  delete c.body_matching;
  assert.equal(mapBodyRecommendations(c, catalog()).get(0)?.status, "disabled");
  for (const mutate of [
    (r: Record<string, unknown>) => {
      r.mode = "shadow";
    },
    (r: Record<string, unknown>) => {
      r.input_sha256 = "wrong";
    },
    (r: Record<string, unknown>) => {
      r.people = [];
    },
  ]) {
    const x = fixture();
    mutate(x.body_matching as Record<string, unknown>);
    assert.notEqual(
      mapBodyRecommendations(x, catalog()).get(0)?.status,
      "available",
    );
  }
  const changed = catalog();
  changed.assets[1].assetSha256 = "f".repeat(64);
  assert.equal(
    mapBodyRecommendations(fixture(), changed).get(0)?.status,
    "unavailable",
  );
});
test("partial bad person does not lose good person's recommendation; auto_default is not a recommendation", () => {
  const c = fixture(),
    raw = c.body_matching as { people: Array<Record<string, unknown>> };
  raw.people[0].selection_source = "auto_default";
  assert.equal(
    mapBodyRecommendations(c, catalog()).get(0)?.status,
    "unavailable",
  );
  assert.equal(
    mapBodyRecommendations(c, catalog()).get(1)?.status,
    "available",
  );
  raw.people[0].person_id = "wrong";
  assert.equal(
    mapBodyRecommendations(c, catalog()).get(0)?.reasonCodes[0],
    "body_contract_invalid",
  );
});
test("recommendation mapping leaves every pose and quality field intact", () => {
  const old = config.bodySelectionEnabled;
  try {
    Reflect.set(config, "bodySelectionEnabled", false);
    const off = result();
    Reflect.set(config, "bodySelectionEnabled", true);
    const on = result();
    const strip = (r: AnalysisResult) => ({
      ...r,
      candidatesByPerson: r.candidatesByPerson.map(
        ({ bodyRecommendation, ...p }) => p,
      ),
    });
    assert.deepEqual(strip(on), off);
    assert.ok(on.candidatesByPerson[0].bodyRecommendation);
  } finally {
    Reflect.set(config, "bodySelectionEnabled", old);
  }
});
test("mutations reject ambiguous modes, unknown fields and missing revision/idempotency keys", () => {
  const common = { expectedRevision: 0, mutationId: "mutation-123" };
  assert.equal(
    parseSelectionChange({ ...common, intent: "auto" }).intent,
    "auto",
  );
  for (const value of [
    { ...common, intent: "auto", characterId: "x" },
    { ...common, intent: "manual" },
    { ...common, intent: "manual", characterId: "x", resolvedBody: {} },
    { intent: "inherit" },
  ])
    assert.throws(() => parseSelectionChange(value));
  assert.throws(() =>
    parsePreferenceChange({
      ...common,
      mode: "fixed_default",
      defaultCharacterId: null,
    }),
  );
});
test("HTTP routes forward authenticated owner, wrap conflicts and do not gate unrelated job routes", async () => {
  const fake = {
    ...bodyStore,
    selection: async (owner: string) => {
      assert.equal(owner, "inst_owner");
      throw new BodyError("BODY_SELECTION_CONFLICT", 409, {
        currentRevision: 3,
      });
    },
    preferences: async () => defaultPreferences(),
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => {
    c.set("installationId", "inst_owner");
    c.set("requestId", "req_test");
    await n();
  });
  app.route(
    "/jobs",
    createBodySelectionRoutes(fake, () => true),
  );
  app.route(
    "/preferences",
    createBodyPreferenceRoutes(fake, () => true),
  );
  assert.equal(
    (await app.request("/jobs/job_test/people/0/body-selection")).status,
    409,
  );
  assert.equal(
    (await app.request("/jobs/job_test/people/NaN/body-selection")).status,
    400,
  );
  const off = new Hono<AppEnv>();
  off.route(
    "/jobs",
    createBodySelectionRoutes(fake, () => false),
  );
  off.get("/jobs/legacy", (c) => c.json({ ok: true }));
  assert.equal((await off.request("/jobs/legacy")).status, 200);
  assert.equal(
    (await off.request("/jobs/job_test/people/0/body-selection")).status,
    503,
  );
  assert.equal((await app.request("/preferences")).status, 200);
});

function presentationFixture(style = "feminine") {
  const c = fixture();
  const raw = c.body_matching as Record<string, unknown> & {
    people: Array<Record<string, unknown>>;
  };
  raw.is_mock = false;
  const row = raw.people[0];
  row.selection_source = "auto_presentation_default";
  row.presentation_selection = {
    mode: "compatible_candidates",
    visibility: "visible",
    observed: style,
  };
  row.observations = {
    ownership_ambiguous: false,
    provider_error: null,
    presentation: {
      value: style,
      visibility: "visible",
      cues: ["face_design"],
      evidence: "owned design cue",
    },
  };
  return { c, raw, row };
}
test("presentation-only female/male default survives BFF fallback while explicit user choices win", () => {
  for (const style of ["feminine", "masculine"]) {
    const { c } = presentationFixture(style);
    const lib = catalog(),
      rec = mapBodyRecommendations(c, lib).get(0)!;
    assert.equal(rec.status, "available");
    const policy = snapshot(
      { ...defaultPreferences(), defaultCharacterId: "character-0" },
      lib,
    );
    const selected = resolveBody(0, policy, rec, lib, ["pose-a"]);
    assert.equal(selected.resolvedBody?.characterId, "character-1");
    assert.deepEqual(rec.reasonCodes, ["presentation_supported_shape_default"]);
    assert.equal(
      resolveBody(
        0,
        policy,
        rec,
        lib,
        ["pose-a"],
        "manual",
        bodyRef(lib.assets[2]),
      ).resolvedBody?.characterId,
      "character-2",
    );
    policy.preferences.mode = "fixed_default";
    assert.equal(
      resolveBody(0, policy, rec, lib, ["pose-a"]).resolvedBody?.characterId,
      "character-0",
    );
    assert.equal(
      resolveBody(0, policy, rec, lib, ["pose-a"], "auto").resolvedBody
        ?.characterId,
      "character-1",
    );
  }
});
test("unowned, weak, mock, unsupported or missing presentation cannot promote a default", () => {
  const changes = [
    (f: ReturnType<typeof presentationFixture>) => {
      f.raw.is_mock = true;
    },
    (f: ReturnType<typeof presentationFixture>) => {
      f.row.observations = null;
    },
    (f: ReturnType<typeof presentationFixture>) => {
      f.row.presentation_selection = { mode: "matching_style_unavailable" };
    },
    ...[
      { ownership_ambiguous: true },
      { provider_error: "timeout" },
      {
        presentation: {
          value: "feminine",
          visibility: "uncertain",
          cues: ["face_design"],
          evidence: "weak",
        },
      },
      {
        presentation: {
          value: "feminine",
          visibility: "visible",
          cues: ["hair_design"],
          evidence: "hair only",
        },
      },
      {
        presentation: {
          value: "masculine",
          visibility: "visible",
          cues: ["face_design"],
          evidence: "mismatch",
        },
      },
    ].map((patch) => (f: ReturnType<typeof presentationFixture>) => {
      f.row.observations = { ...(f.row.observations as object), ...patch };
    }),
  ];
  for (const change of changes) {
    const f = presentationFixture();
    change(f);
    assert.equal(
      mapBodyRecommendations(f.c, catalog()).get(0)?.status,
      "unavailable",
    );
  }
  const f = presentationFixture(),
    lib = catalog();
  lib.assets[1].supportedPoseIds = [];
  assert.equal(mapBodyRecommendations(f.c, lib).get(0)?.status, "unavailable");
});
test("preference reads and writes use the same UX gate for every flag combination", async () => {
  const previous = {
    bodySelectionEnabled: config.bodySelectionEnabled,
    bodyUxEnabled: config.bodyUxEnabled,
    fbxExportEnabled: config.fbxExportEnabled,
    converterBaseUrl: config.converterBaseUrl,
  };
  let reads = 0,
    writes = 0;
  const fake = {
    ...bodyStore,
    preferences: async () => {
      reads++;
      return defaultPreferences();
    },
    savePreferences: async () => {
      writes++;
      return defaultPreferences();
    },
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", "owner");
    await next();
  });
  app.route("/preferences", createBodyPreferenceRoutes(fake));
  try {
    for (const selection of [false, true])
      for (const ux of [false, true])
        for (const fbx of [false, true])
          for (const url of ["", "http://fixture.invalid"]) {
            Object.assign(config, {
              bodySelectionEnabled: selection,
              bodyUxEnabled: ux,
              fbxExportEnabled: fbx,
              converterBaseUrl: url,
            });
            const enabled = selection && ux && fbx && !!url;
            assert.equal(bodyUxAvailable(), enabled);
            for (const method of ["GET", "PUT"]) {
              const response = await app.request("/preferences", {
                method,
                ...(method === "PUT"
                  ? {
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        mode: "auto",
                        defaultCharacterId: null,
                        expectedRevision: 0,
                        mutationId: "test-mutation",
                      }),
                    }
                  : {}),
              });
              assert.equal(response.status, enabled ? 200 : 503);
              if (!enabled)
                assert.equal(
                  ((await response.json()) as { error: { code: string } }).error
                    .code,
                  "BODY_SELECTION_DISABLED",
                );
            }
          }
    assert.equal(reads, 1);
    assert.equal(writes, 1);
  } finally {
    Object.assign(config, previous);
  }
});
