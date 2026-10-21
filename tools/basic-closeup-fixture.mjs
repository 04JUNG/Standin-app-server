// Loopback-only visual fixture. No analysis, cloud write, DB mutation or Converter.
// Build first; BASIC_CLOSEUP_TEMPLATE_DIR must point to an approved local snapshot.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createHumanReferenceRoutes } from "../dist/human-reference.js";
import { withBasicCloseupPreview } from "../dist/pose-presentation.js";
const dir = process.env.BASIC_CLOSEUP_TEMPLATE_DIR;
if (!dir) throw Error("BASIC_CLOSEUP_TEMPLATE_DIR is required");
const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8"));
const app = new Hono();
app.use("*", async (c, next) => { c.set("installationId", "local-closeup-fixture"); await next(); });
app.get("/fixture/result/:scope", c => {
  const scope = c.req.param("scope");
  if (!["head", "shoulder_head"].includes(scope)) return c.notFound();
  return c.json(withBasicCloseupPreview({
    version: "dynamic-pose-presentation-v1", person_index: 0,
    route: "basic_model", status: "basic_reference", search_status: "ok",
    search_reason: "explicit_closeup_basic_model", generation_status: "not_requested",
    generation_reason: "basic_model_not_pose_generation", output_scope: scope,
    unobserved_body_is_default: true, library_candidates: [], review_candidates: [], generated_candidates: [],
    basic_model: { status: "planned", output_scope: scope }, issues: [], preview_status: "not_requested",
    auto_apply_allowed: false, refine_allowed: false, export_allowed: false,
  }));
});
app.route("/v1/pose-candidates", createHumanReferenceRoutes({
  getDefaultBodyTemplate: async scope => {
    const item = manifest.scopes[scope];
    if (!item) return new Response(null, { status: 404 });
    return new Response(await readFile(resolve(dir, item.file)), { headers: {
      "Content-Type": "application/gzip", "X-Standin-Template-Version": "default-body-template-v1",
      "X-Standin-Preview-Only": "true", "X-Standin-Character-Id": manifest.character_id,
      "X-Standin-Character-SHA256": manifest.character_sha256, "X-Standin-Output-Scope": scope,
      "X-Standin-Preview-Method": "reference-skinning-v1",
      "X-Standin-Template-JSON-SHA256": item.json_sha256, "X-Standin-Artifact-SHA256": item.sha256,
    } });
  },
}));
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 18467 }, () => console.log("Local fixture http://127.0.0.1:18467"));
