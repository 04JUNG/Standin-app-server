import { pool, transaction } from "../db.js";
import { config } from "../config.js";
import { ReplayError } from "./policy.js";
import { ReplayService, type ReplayDb } from "./service.js";
import { LocalReplayStorage, S3ReplayStorage } from "./storage.js";
export const replayService = new ReplayService(
  pool as ReplayDb,
  (fn) => transaction((db) => fn(db as ReplayDb)),
  config.replayBucket
    ? new S3ReplayStorage(config.replayBucket)
    : config.replayEnvironment === "production"
      ? {
          async put() {
            throw new ReplayError("REPLAY_STORAGE_UNAVAILABLE", 503);
          },
          async get() {
            throw new ReplayError("REPLAY_STORAGE_UNAVAILABLE", 503);
          },
          async deletePrefix() {
            throw new ReplayError("REPLAY_STORAGE_UNAVAILABLE", 503);
          },
        }
      : new LocalReplayStorage(config.replayLocalDir),
  {
    enabled: config.replayEnabled,
    captureEnabled: config.captureReplayEnabled,
    cspEnabled: config.cspResultCaptureEnabled,
    consentMode: config.replayConsentMode,
    environment: config.replayEnvironment,
  },
);
