/** Runs the unchanged approved-UV structure check off the HTTP event loop. */
import { parentPort, workerData } from "node:worker_threads";
import { checkSkinUv, type SkinUvPin } from "./skin-uv.js";

const { bytes, pin } = workerData as { bytes: Uint8Array; pin: SkinUvPin };
let ok = false;
try { checkSkinUv(bytes, pin); ok = true; } catch { /* reported as a plain integrity verdict */ }
// Never clone decoded geometry back into the HTTP process.
parentPort!.postMessage({ ok });
