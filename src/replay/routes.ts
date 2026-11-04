import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { ReplayError, parse, identifier, sha } from "./policy.js";
import type { ReplayService } from "./service.js";
import { z } from "zod";
const replayId = z.uuid();
export function createReplayRoutes(service: ReplayService) {
  const r = new Hono<AppEnv>();
  r.onError((e, c) => {
    if (e instanceof ReplayError)
      return c.json(
        errorEnvelope(
          e.code,
          "Replay request could not be completed.",
          c.get("requestId"),
        ),
        e.status,
      );
    return c.json(
      errorEnvelope(
        "REPLAY_STORAGE_UNAVAILABLE",
        "Replay storage unavailable.",
        c.get("requestId"),
      ),
      503,
    );
  });
  r.use(
    "*",
    bodyLimit({
      maxSize: 12000000,
      onError: (c) =>
        c.json(
          errorEnvelope(
            "REPLAY_TOO_LARGE",
            "Replay request too large.",
            c.get("requestId"),
          ),
          413,
        ),
    }),
  );
  const json = async (req: { json: () => Promise<unknown> }) => {
    try {
      return await req.json();
    } catch {
      throw new ReplayError("REPLAY_INVALID");
    }
  };
  r.use(
    "/:id/streams/*",
    bodyLimit({
      maxSize: 1600000,
      onError: (c) =>
        c.json(
          errorEnvelope(
            "REPLAY_TOO_LARGE",
            "Replay chunk too large.",
            c.get("requestId"),
          ),
          413,
        ),
    }),
  );
  r.post("/", async (c) =>
    c.json(
      await service.create(c.get("installationId")!, await json(c.req)),
      201,
    ),
  );
  r.put("/:id/streams/:window/chunks/:sequence", async (c) =>
    c.json(
      await service.chunk(
        c.get("installationId")!,
        parse(replayId, c.req.param("id")),
        parse(identifier, c.req.param("window")),
        Number(c.req.param("sequence")),
        await json(c.req),
      ),
    ),
  );
  r.put("/:id/assets/:hash", async (c) =>
    c.json(
      await service.asset(
        c.get("installationId")!,
        parse(replayId, c.req.param("id")),
        parse(sha, c.req.param("hash")),
        await json(c.req),
      ),
    ),
  );
  r.post("/:id/finish", async (c) =>
    c.json(
      await service.finish(
        c.get("installationId")!,
        parse(replayId, c.req.param("id")),
        await json(c.req),
      ),
    ),
  );
  r.delete("/:id", async (c) =>
    c.json(
      await service.remove(
        c.get("installationId")!,
        parse(replayId, c.req.param("id")),
      ),
    ),
  );
  r.delete("/", async (c) =>
    c.json(await service.remove(c.get("installationId")!)),
  );
  return r;
}
export function createAdminReplayRoutes(
  service: ReplayService,
  audit: (
    reviewer: string,
    replayId?: string,
    requestId?: string,
  ) => Promise<void>,
) {
  const r = new Hono<AppEnv>();
  r.onError((e, c) =>
    e instanceof ReplayError
      ? c.json(
          errorEnvelope(e.code, "Replay unavailable.", c.get("requestId")),
          e.status,
        )
      : c.json(
          errorEnvelope(
            "REPLAY_STORAGE_UNAVAILABLE",
            "Replay storage unavailable.",
            c.get("requestId"),
          ),
          503,
        ),
  );
  r.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  r.get("/", async (c) => {
    const result = await service.list(c.req.query());
    await audit(c.get("reviewer")!, undefined, c.get("requestId"));
    return c.json(result);
  });
  r.get("/:id/manifest", async (c) => {
    const id = parse(replayId, c.req.param("id"));
    const data = await service.manifest(id);
    await audit(c.get("reviewer")!, id, c.get("requestId"));
    return c.json(data);
  });
  r.get("/:id/streams/:window/chunks/:sequence", async (c) => {
    const id = parse(replayId, c.req.param("id"));
    const data = await service.read(
      id,
      "chunk",
      parse(identifier, c.req.param("window")),
      Number(c.req.param("sequence")),
    );
    await audit(c.get("reviewer")!, id, c.get("requestId"));
    return c.json({
      events: JSON.parse(Buffer.from(data.bytes).toString("utf8")),
    });
  });
  r.get("/:id/assets/:hash", async (c) => {
    const id = parse(replayId, c.req.param("id"));
    const data = await service.read(
      id,
      "asset",
      parse(sha, c.req.param("hash")),
    );
    await audit(c.get("reviewer")!, id, c.get("requestId"));
    c.header("Content-Type", data.mime);
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    return c.body(data.bytes as Uint8Array<ArrayBuffer>);
  });
  return r;
}
