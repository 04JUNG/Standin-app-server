import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import {
  eventJobBelongsToInstallation,
  insertClientEvent,
  sanitizeEventProperties,
} from "./store.js";

export const analyticsRoutes = new Hono<AppEnv>();

analyticsRoutes.post("/batch", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { events?: unknown[] } | null;
  if (!body?.events || !Array.isArray(body.events) || body.events.length > 100) {
    return c.json(errorEnvelope("INVALID_INPUT", "events 배열이 필요합니다.", c.get("requestId")), 400);
  }
  const installationId = c.get("installationId")!;
  let accepted = 0;
  for (const raw of body.events) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return c.json(errorEnvelope("INVALID_INPUT", "이벤트 형식이 잘못되었습니다.", c.get("requestId")), 400);
    }
    const event = raw as Record<string, unknown>;
    const eventId = typeof event.eventId === "string" ? event.eventId : "";
    const name = typeof event.name === "string" ? event.name : "";
    const occurredAt = typeof event.occurredAt === "string" ? event.occurredAt : "";
    const sequence = typeof event.sequence === "number" ? event.sequence : -1;
    const jobId = typeof event.jobId === "string" ? event.jobId : null;
    const properties = sanitizeEventProperties(name, event.properties);
    if (
      !/^evt_[0-9a-f-]{36}$/i.test(eventId) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      Number.isNaN(Date.parse(occurredAt)) ||
      !properties
    ) {
      return c.json(errorEnvelope("INVALID_INPUT", "허용되지 않은 이벤트입니다.", c.get("requestId")), 400);
    }
    if (jobId && !(await eventJobBelongsToInstallation(jobId, installationId))) {
      return c.json(errorEnvelope("NOT_FOUND", "unknown jobId", c.get("requestId")), 404);
    }
    if (
      await insertClientEvent({
        eventId,
        installationId,
        sequence,
        name,
        occurredAt,
        jobId,
        properties,
      })
    ) {
      accepted += 1;
    }
  }
  return c.json({ accepted, duplicates: body.events.length - accepted });
});
