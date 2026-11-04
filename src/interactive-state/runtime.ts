/** Activation intentionally gated on an agreed, implemented Converter transport. */
import { config } from "../config.js";
import { renderFinalPreview } from "../converter/finalPreview.js";
import { log } from "../log.js";
import { createSelectionResolver } from "./selection.js";
import { OperationStore } from "./store.js";
import { InteractiveService } from "./service.js";
import { PrivatePosters } from "./posters.js";
import { InteractiveError } from "./model.js";
import type { InteractiveWorker } from "./worker.js";
// No guessed upstream routes: Converter's current contract is a local snapshot
// adapter. Fail closed until its HTTP transport and camera contract are frozen.
export const converterTransportAvailable = false;
const unavailable = async (): Promise<never> => {
  throw new InteractiveError("INTERACTIVE_CONVERTER_TRANSPORT_PENDING", 503);
};
const worker: InteractiveWorker = {
  solve: unavailable,
  model: unavailable,
  export: unavailable,
  file: unavailable,
  cancel: async () => {},
};
export const interactiveService = new InteractiveService({
  store: new OperationStore(),
  resolve: createSelectionResolver(),
  worker,
  posters: new PrivatePosters(),
  renderPoster: (op, fbx, signal) =>
    renderFinalPreview(
      { fbx, artifactSha256: String(op.receipt!.artifactSha256) },
      false,
      {},
      false,
      signal,
    ),
  metric: (event, stage, elapsedMs, code) =>
    log.info({
      type: "interactive_artifact",
      event,
      stage,
      durationMs: elapsedMs,
      ...(code ? { errorCode: code } : {}),
    }),
});
export const interactiveEnabled = () =>
  config.interactiveStateEnabled && converterTransportAvailable;
