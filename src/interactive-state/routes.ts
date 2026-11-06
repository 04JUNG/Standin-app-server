import { z } from "zod";
import type { SelectionPreviewService } from "./selectionPreview.js";
import { appearanceSchema, outlineMessage } from "../appearance/model.js";
import { clientFrameSchema } from "./clientFrame.js";
import { staticFile } from "./static.js";
import { sha256Hex } from "../converter/client.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { BodyError } from "../body-selection/store.js";
import { HandError } from "../hands/model.js";
import { ConverterError } from "../converter/client.js";
import { InteractiveError, prepareSchema, publicOperation } from "./model.js";
import type { InteractiveService } from "./service.js";
export const INTERACTIVE_PATH = "/:jobId/people/:personIndex/interactive-state";
export function createInteractiveRoutes(
  service: InteractiveService,
  enabled: () => boolean,
  previewService?: SelectionPreviewService,
) {
  const r = new Hono<AppEnv>();
  r.onError((e, c) => {
    const known =
      e instanceof InteractiveError ||
      e instanceof BodyError ||
      e instanceof HandError;
    const code =
      known || e instanceof ConverterError ? e.code : "INTERACTIVE_UNAVAILABLE";
    const status = known ? e.status : 503;
    return c.json(
      errorEnvelope(
        code,
        code.startsWith("OUTLINE_") ? outlineMessage(code) : "선택한 결과를 다시 확인해 주세요.",
        c.get("requestId"),
      ),
      status,
    );
  });
  // Bound streamed JSON before parsing, including chunked requests.
  r.use(
    `${INTERACTIVE_PATH}/*`,
    bodyLimit({
      maxSize: 1500000,
      onError: (c) =>
        c.json(
          errorEnvelope(
            "PAYLOAD_TOO_LARGE",
            "요청이 너무 큽니다.",
            c.get("requestId"),
          ),
          413,
        ),
    }),
  );
  r.use(
    INTERACTIVE_PATH,
    bodyLimit({
      maxSize: 4096,
      onError: (c) =>
        c.json(
          errorEnvelope(
            "PAYLOAD_TOO_LARGE",
            "요청이 너무 큽니다.",
            c.get("requestId"),
          ),
          413,
        ),
    }),
  );
  const l = (c: {
    req: { param(name: string): string; query(): Record<string, string> };
    get(name: "installationId"): string | undefined;
  }) => {
    if (!enabled()) throw new InteractiveError("INTERACTIVE_DISABLED", 503);
    const installationId = c.get("installationId");
    if (!installationId) throw new InteractiveError("NOT_FOUND", 404);
    const raw = c.req.param("personIndex"),
      personIndex = Number(raw),
      jobId = c.req.param("jobId");
    if (
      !/^(0|[1-9][0-9]*)$/.test(raw) ||
      !Number.isSafeInteger(personIndex) ||
      personIndex > 1000 ||
      !/^job_[A-Za-z0-9_-]{1,100}$/.test(jobId)
    )
      throw new InteractiveError("INVALID_INPUT", 400);
    return { installationId, jobId, personIndex };
  };
  const previewPath = "/:jobId/people/:personIndex/selection-preview";
  r.use(
    previewPath,
    bodyLimit({
      maxSize: 4096,
      onError: (c) =>
        c.json(
          errorEnvelope(
            "PAYLOAD_TOO_LARGE",
            "요청이 너무 큽니다.",
            c.get("requestId"),
          ),
          413,
        ),
    }),
  );
  r.post(previewPath, async (c) => {
    const location = l(c);
    if (!previewService)
      throw new InteractiveError("INTERACTIVE_DISABLED", 503);
    const parsed = z
      .object({
        candidateId: z.string().min(1).max(200),
        bodyRevision: z.number().int().nonnegative(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new InteractiveError("INVALID_INPUT", 400);
    return c.json(
      await previewService.preview(
        location,
        parsed.data.candidateId,
        parsed.data.bodyRevision,
        c.req.raw.signal,
      ),
      200,
      { "Cache-Control": "private, no-store" },
    );
  });
  r.get("/:jobId/people/:personIndex/interactive-frame", async (c) => {
    const { op, bytes } = await service.historyFrame(l(c));
    return new Response(bytes, {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
        "X-Standin-State-Hash": op.stateHash!,
        "X-Standin-Revision": String(op.revision),
      },
    });
  });
  r.get(INTERACTIVE_PATH, async (c) => {
    const location = l(c),
      candidateId = c.req.query("candidateId");
    if (!candidateId || candidateId.length > 200)
      throw new InteractiveError("INVALID_INPUT", 400);
    const raw = c.req.queries("appearance");
    if (raw && raw.length !== 1) throw new InteractiveError("INVALID_INPUT", 400);
    let appearance;
    if (raw) {
      const value = appearanceSchema.safeParse(await Promise.resolve().then(() => JSON.parse(raw[0])).catch(() => null));
      if (!value.success) throw new InteractiveError("INVALID_INPUT", 400);
      appearance = value.data;
    }
    return c.json(await service.head(location, candidateId, appearance), 200, {
      "Cache-Control": "private, no-store",
    });
  });
  r.get(
    "/:jobId/people/:personIndex/interactive-static/:candidateId/:sha",
    async (c) => {
      const bytes = await staticFile(
        l(c),
        c.req.param("candidateId"),
        c.req.param("sha"),
        c.req.raw.signal,
      );
      return new Response(bytes, {
        headers: {
          "Content-Type": "model/gltf-binary",
          "Content-Length": String(bytes.length),
          "Cache-Control": "private, no-store",
        },
      });
    },
  );
  r.post(INTERACTIVE_PATH, async (c) => {
    const location = l(c),
      parsed = prepareSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new InteractiveError("INVALID_INPUT", 400);
    const result = await service.prepare(location, parsed.data);
    return c.json(publicOperation(result.op), result.replay ? 200 : 202, {
      "Cache-Control": "private, no-store",
      "Retry-After": "1",
    });
  });
  const op = async (c: Parameters<typeof l>[0]) => {
    const location = l(c),
      id = c.req.param("operationId");
    if (!/^op_[a-f0-9-]{36}$/.test(id))
      throw new InteractiveError("NOT_FOUND", 404);
    // Settings are immutable on prepare; do not silently ignore appearance on a file/export URL.
    if (Object.keys(c.req.query()).some(k => /^(outline|appearance)/i.test(k)))
      throw new InteractiveError("INVALID_INPUT", 400);
    return service.current(location, id);
  };
  r.get(`${INTERACTIVE_PATH}/:operationId`, async (c) =>
    c.json(publicOperation(await op(c)), 200, {
      "Cache-Control": "private, no-store",
      "Retry-After": "1",
    }),
  );
  r.delete(`${INTERACTIVE_PATH}/:operationId`, async (c) =>
    c.json(publicOperation(await service.cancel(await op(c))), 200, {
      "Cache-Control": "private, no-store",
    }),
  );
  r.post(`${INTERACTIVE_PATH}/:operationId/client-frame`, async (c) => {
    const operation = await op(c),
      parsed = clientFrameSchema.safeParse(
        await c.req.json().catch(() => null),
      );
    if (!parsed.success) throw new InteractiveError("INVALID_INPUT", 400);
    return c.json(await service.clientFrame(operation, parsed.data), 201, {
      "Cache-Control": "private, no-store",
    });
  });
  r.post(`${INTERACTIVE_PATH}/:operationId/export`, async (c) => {
    const operation = await op(c), raw = await c.req.text();
    // Old clients send no body; current clients bind the expected immutable snapshot.
    if (raw.length) {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new InteractiveError("INVALID_INPUT", 400); }
      const parsed = z.object({ revision: z.number().int().positive(), stateHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(value);
      if (!parsed.success) throw new InteractiveError("INVALID_INPUT", 400);
      if (parsed.data.revision !== operation.revision || parsed.data.stateHash !== operation.stateHash)
        throw new InteractiveError("INTERACTIVE_SUPERSEDED");
    }
    return c.json(publicOperation(await service.requestExport(operation)), 202, {
      "Cache-Control": "private, no-store",
      "Retry-After": "1",
    });
  });
  r.get(`${INTERACTIVE_PATH}/:operationId/variants`, async (c) => {
    const operation = await op(c),
      bytes = await service.variants(operation, c.req.raw.signal);
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/vnd.standin.hand-variants-v1+json",
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
        "X-Standin-Atlas-SHA256": sha256Hex(bytes),
        "X-Standin-State-Hash": operation.stateHash!,
        "X-Standin-Revision": String(operation.revision),
      },
    });
  });
  for (const kind of ["model", "file", "poster"] as const)
    r.get(`${INTERACTIVE_PATH}/:operationId/${kind}`, async (c) => {
      const operation = await op(c);
      const bytes =
        kind === "model"
          ? await service.model(operation, c.req.raw.signal)
          : kind === "file"
            ? await service.file(operation, c.req.raw.signal)
            : await service.poster(operation);
      return new Response(bytes, {
        headers: {
          "Content-Type":
            kind === "model"
              ? "application/vnd.standin.solved-pose-state-v1+json"
              : kind === "poster"
                ? "image/png"
                : "application/octet-stream",
          "Content-Length": String(bytes.length),
          "Cache-Control": "private, no-store",
          "X-Standin-State-Hash": operation.stateHash!,
          "X-Standin-Revision": String(operation.revision),
          ...(kind === "file"
            ? {
                "Content-Disposition": `attachment; filename="pose-r${operation.revision}.fbx"`,
                "X-Standin-Artifact-Contract": operation.appearance ? "outlined-fbx-v1" : "interactive-fbx-receipt-v1",
                "X-Standin-Artifact-SHA256": String(
                  operation.appearance ? operation.outlineReceipt!.artifactSha256 : operation.receipt!.artifactSha256,
                ),
              }
            : {}),
        },
      });
    });
  return r;
}
