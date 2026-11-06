import { SelectionPreviewService } from "./selectionPreview.js";
import { createOutlineArtifacts } from "../converter/outline.js";
/** Activation intentionally gated on an agreed, implemented Converter transport. */
import { config } from "../config.js";
import { renderFinalPreview } from "../converter/finalPreview.js";
import { log } from "../log.js";
import { createSelectionResolver } from "./selection.js";
import { OperationStore } from "./store.js";
import { InteractiveService } from "./service.js";
import { PrivatePosters } from "./posters.js";
import { createInteractiveWorker } from "../converter/interactive.js";
// Explicit flags plus a private Converter credential are required at both ends.
export const converterTransportAvailable =
  config.converterBaseUrl.trim() !== "" &&
  config.interactiveConverterToken.length >= 32;
const worker = createInteractiveWorker();
export const interactiveService = new InteractiveService({
  store: new OperationStore(),
  outline: createOutlineArtifacts(),
  resolve: createSelectionResolver(),
  worker,
  posters: new PrivatePosters(),
  renderPoster: (op, fbx, signal) =>
    renderFinalPreview(
      { fbx, artifactSha256: String(op.appearance ? op.outlineReceipt!.artifactSha256 : op.receipt!.artifactSha256) },
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

export const selectionPreviewService = new SelectionPreviewService(
  createSelectionResolver({}, "preview"),
  worker,
);
