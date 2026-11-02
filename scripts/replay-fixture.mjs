/** Synthetic local UI used to exercise the real recorder and HTTP ingestion, never user artwork. */
import { record } from "@rrweb/record";
let credentials,
  replayId,
  startedAt,
  buffer = [],
  sequence = 0,
  stopped;
const out = document.querySelector("#status");
const sha = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const send = async (path, body, method = "POST") => {
  const r = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(credentials
        ? {
            "X-Installation-Id": credentials.installationId,
            "X-Device-Token": credentials.deviceToken,
            "X-App-Version": "0.2.0",
          }
        : {}),
    },
    body: JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error?.code || r.status);
  return result;
};
async function start() {
  credentials = await send("/v1/installations", {
    consentVersion: "2026-08-02",
    consentedAt: new Date().toISOString(),
    appVersion: "0.2.0",
    osName: "macos",
    osVersion: "synthetic",
    architecture: "arm64",
    locale: "ko",
  });
  startedAt = Date.now();
  replayId = crypto.randomUUID();
  await send("/v1/replays", {
    protocolVersion: "session-replay.v1",
    replayId,
    appSessionId: replayId,
    startedAt,
    appVersion: "0.2.0",
    os: "macos",
    authorizationMode: "assumed",
    policyVersion: "2026-10-28",
  });
  stopped = record({
    emit: (e) => buffer.push(e),
    maskAllInputs: true,
    inlineStylesheet: true,
    recordCanvas: false,
    blockClass: "rr-block",
  });
  out.textContent = "녹화 중 · " + replayId;
  document.querySelector("#start").disabled = true;
}
async function flush() {
  const events = buffer;
  buffer = [];
  const bytes = new TextEncoder().encode(JSON.stringify(events));
  await send(
    `/v1/replays/${replayId}/streams/fixture_app/chunks/${sequence}`,
    {
      protocolVersion: "session-replay.v1",
      surface: "app",
      encoding: "json",
      events,
      contentHash: await sha(bytes),
      startedOffsetMs: Math.max(0, events[0].timestamp - startedAt),
      endedOffsetMs: Math.max(0, events.at(-1).timestamp - startedAt),
      clock: { epochMs: Date.now(), monotonicOffsetMs: Date.now() - startedAt },
    },
    "PUT",
  );
  sequence++;
}
document.querySelector("#start").onclick = () =>
  start().catch((e) => (out.textContent = e.message));
document.querySelector("#choose").onclick = () => {
  document.querySelector("#pose").style.transform = "rotate(20deg)";
  document.querySelector("#label").textContent = "후보 B 선택 · 체형 0.6";
  record.addCustomEvent("feature_action", {
    feature: "candidate_selection",
    action: "selected",
  });
};
document.querySelector("#capture").onclick = async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 600;
  canvas.height = 350;
  const c = canvas.getContext("2d");
  c.fillStyle = "#16243b";
  c.fillRect(0, 0, 600, 350);
  c.strokeStyle = "#f9b45b";
  c.lineWidth = 8;
  c.beginPath();
  c.moveTo(200, 60);
  c.lineTo(300, 240);
  c.lineTo(420, 100);
  c.stroke();
  const data = canvas.toDataURL("image/png").split(",")[1];
  const bytes = Uint8Array.from(atob(data), (v) => v.charCodeAt(0));
  const h = await sha(bytes);
  await send(
    `/v1/replays/${replayId}/assets/${h}`,
    {
      contentType: "image/png",
      dataBase64: data,
      kind: "capture_background",
      snapshotVersion: "fixture-1",
    },
    "PUT",
  );
  record.addCustomEvent("capture_overlay", {
    width: 600,
    height: 350,
    backgroundAssetHash: h,
    cursor: { x: 320, y: 220 },
    selection: { x: 160, y: 30, width: 300, height: 250 },
    phase: "confirm",
  });
  document.querySelector("#label").textContent = "캡처 선택 완료";
};
document.querySelector("#finish").onclick = async () => {
  stopped?.();
  await flush();
  await send(`/v1/replays/${replayId}/finish`, {
    streams: [{ windowInstanceId: "fixture_app", lastSequence: sequence - 1 }],
    reason: "completed",
  });
  out.textContent = "업로드 완료 · " + replayId;
};
