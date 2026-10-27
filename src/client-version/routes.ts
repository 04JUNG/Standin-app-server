import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import {
  CLIENT_VERSION_HEADER,
  MINIMUM_CLIENT_VERSION,
  isSupportedClientVersion,
} from "./policy.js";
import { updateRequired } from "./response.js";

export const clientPolicyRoutes = new Hono<AppEnv>();
clientPolicyRoutes.get("/", (c) => {
  c.header("Cache-Control", "no-store");
  if (!isSupportedClientVersion(c.req.header(CLIENT_VERSION_HEADER))) return updateRequired(c);
  return c.json({ minimumVersion: MINIMUM_CLIENT_VERSION });
});
