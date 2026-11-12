/** Runs the existing geometry, identity, hash and skin gates off the HTTP event loop. */
import { parentPort, workerData } from "node:worker_threads";
import { parsePacket } from "./packet.js";
import { parseBinaryState } from "./packetV2.js";
import { checkSkinPreviewBinaryModel, checkSkinPreviewModel } from "../appearance/skin-preview.js";
import { InteractiveError } from "./model.js";

try {
  if (workerData.kind === "v2") {
    const validated = await parseBinaryState(workerData.meta, workerData.bytes, workerData.op, workerData.selection);
    checkSkinPreviewBinaryModel(workerData.op.skinPreview, validated.state.model);
    parentPort!.postMessage({ stateHash: validated.meta.stateHash, snapshotProof: validated.snapshotProof });
  } else {
    const validated = parsePacket(workerData.raw, workerData.op, workerData.selection);
    checkSkinPreviewModel(workerData.op.skinPreview, validated.payload.model);
    // Never clone decoded geometry back into the HTTP process.
    parentPort!.postMessage({ stateHash: validated.packet.stateHash, snapshotProof: validated.snapshotProof });
  }
} catch (error) {
  parentPort!.postMessage({ errorCode: error instanceof InteractiveError ? error.code : "CONVERTER_INTEGRITY" });
}
