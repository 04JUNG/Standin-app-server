import Player from "rrweb-player";
import playerCss from "rrweb-player/dist/style.css";
import { sanitizeReplay } from "./sanitize.ts";
/** Trusted engine runs in the admin realm. Both display frames forbid scripts and requests. */
export function createReplayPlayer(frame, data) {
  const doc = frame.contentDocument;
  if (!doc) throw Error("Replay sandbox not accessible");
  const css = doc.createElement("style");
  css.textContent =
    playerCss +
    "body{margin:0;background:#f4f4f4;color:#222;font:14px system-ui}#status{padding:8px}#capture{position:relative;width:100%;overflow:hidden}#capture img{width:100%;display:block}#selection{position:absolute;border:2px solid #f72;pointer-events:none}#cursor{position:absolute;background:red;width:8px;height:8px;border-radius:50%}";
  doc.head.appendChild(css);
  const status = doc.createElement("div");
  status.id = "status";
  doc.body.appendChild(status);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const capture = doc.createElement("div");
  capture.id = "capture";
  capture.innerHTML =
    '<img alt="캡처 배경"><div id="selection"></div><div id="cursor"></div>';
  doc.body.appendChild(capture);
  capture.hidden = true;
  const canvasFrame = doc.createElement("img");
  canvasFrame.alt = "기록된 3D 프레임";
  canvasFrame.style.maxWidth = "50%";
  doc.body.appendChild(canvasFrame);
  canvasFrame.hidden = true;
  let player;
  const assets = data.assets,
    base = data.startedAt;
  const events = data.events.filter(
    (e) => e.type !== 6 && !(e.type === 3 && [9, 10].includes(e.data?.source)),
  );
  function overlay(time) {
    data.onTime?.(time);
    const custom = events.filter(
      (e) => e.type === 5 && e.timestamp <= base + time,
    );
    const c = custom.filter((e) => e.data?.tag === "capture_overlay").at(-1)
      ?.data?.payload;
    capture.hidden = !c || !assets[c.backgroundAssetHash];
    if (c) {
      const url = assets[c.backgroundAssetHash];
      if (url) {
        capture.querySelector("img").src = url;
        const width = c.width || 1,
          height = c.height || 1,
          s = c.selection;
        const sel = capture.querySelector("#selection");
        sel.hidden = !s;
        if (s)
          Object.assign(sel.style, {
            left: (s.x / width) * 100 + "%",
            top: (s.y / height) * 100 + "%",
            width: (s.width / width) * 100 + "%",
            height: (s.height / height) * 100 + "%",
          });
        const cursor = capture.querySelector("#cursor");
        cursor.hidden = !c.cursor;
        if (c.cursor)
          Object.assign(cursor.style, {
            left: (c.cursor.x / width) * 100 + "%",
            top: (c.cursor.y / height) * 100 + "%",
          });
      } else status.textContent = "캡처 배경 미수집 · 좌표 이벤트만 기록됨";
    }
    const f = custom.filter((e) => e.data?.tag === "canvas_frame").at(-1)
      ?.data?.payload;
    canvasFrame.hidden = !f || !assets[f.assetHash];
    if (!canvasFrame.hidden) canvasFrame.src = assets[f.assetHash];
  }
  const clean = sanitizeReplay(events, assets),
    snapshots = clean.filter((e) => e.type === 2);
  status.textContent = snapshots.length
    ? "창 기록 재생 · " + data.surface
    : "DOM 기록 없음 · 캡처/프레임과 타임라인만 사용 가능";
  let delta = 0;
  if (snapshots.length && clean.length >= 2) {
    const first = clean[0].timestamp;
    delta = first - base;
    const shifted = clean.map((e) => ({
      ...e,
      timestamp: e.timestamp - first,
    }));
    player = new Player({
      target: root,
      props: {
        events: shifted,
        width: Math.max(400, frame.clientWidth - 16),
        height: 440,
        autoPlay: false,
        skipInactive: true,
        UNSAFE_replayCanvas: false,
        showWarning: false,
        showDebug: false,
        mouseTail: false,
      },
    });
    player.addEventListener("ui-update-current-time", (e) =>
      overlay(Number(e.detail?.payload ?? e.payload ?? 0) + delta),
    );
  }
  let time = data.seekMs ?? 0,
    playing = false,
    timer,
    speed = 1,
    range,
    label,
    lastTick = 0;
  const duration = Math.max(0, ...events.map((e) => e.timestamp - base));
  function seek(offset) {
    time = Math.max(0, Math.min(duration, offset));
    player?.goto(Math.max(0, time - delta), false);
    overlay(time);
    if (range) range.value = String(time);
    if (label)
      label.textContent =
        (time / 1000).toFixed(1) + " / " + (duration / 1000).toFixed(1) + "s";
  }
  if (!player) {
    const controls = doc.createElement("div");
    controls.style.padding = "12px";
    const toggle = doc.createElement("button");
    toggle.textContent = "재생";
    controls.appendChild(toggle);
    const rates = doc.createElement("select");
    for (const n of [1, 2, 4, 8]) {
      const o = doc.createElement("option");
      o.value = n;
      o.textContent = n + "x";
      rates.appendChild(o);
    }
    rates.onchange = () => (speed = Number(rates.value));
    controls.appendChild(rates);
    range = doc.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = String(duration);
    range.step = "1";
    range.style.width = "60%";
    range.oninput = () => seek(Number(range.value));
    controls.appendChild(range);
    label = doc.createElement("span");
    controls.appendChild(label);
    doc.body.insertBefore(controls, capture);
    toggle.onclick = () => {
      playing = !playing;
      toggle.textContent = playing ? "일시정지" : "재생";
      if (playing) {
        if (time >= duration) seek(0);
        if (time < events[0]?.timestamp - base)
          seek(events[0].timestamp - base);
        lastTick = performance.now();
      }
    };
    timer = setInterval(() => {
      if (!playing) return;
      const now = performance.now();
      const next = time + (now - lastTick) * speed;
      lastTick = now;
      seek(next);
      if (time >= duration) {
        playing = false;
        toggle.textContent = "재생";
      }
    }, 50);
  }
  seek(data.seekMs ?? 0);
  return {
    seek,
    destroy() {
      clearInterval(timer);
      player?.$destroy();
      doc.body.replaceChildren();
    },
  };
}
