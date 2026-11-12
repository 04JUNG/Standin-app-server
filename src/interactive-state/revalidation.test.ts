import test from "node:test";
import assert from "node:assert/strict";
import { recoverValidation } from "./revalidation.js";
import { InteractiveError } from "./model.js";
import { ConverterError } from "../converter/client.js";

test("51-second runtime outage retains validation work; permanent outage stops at 120 seconds", async () => {
  for (const outage of [51_000, Infinity]) {
    let now = 0, retries = 0;
    const signal = new AbortController().signal;
    const pending = recoverValidation(async () => {
      if (now < outage) throw new ConverterError("BODY_PREVIEW_UNAVAILABLE", "unavailable");
      return "verified";
    }, signal, new Date(3600_000).toISOString(), () => retries++,
    { now: () => now, sleep: async ms => { now += ms; } });
    if (Number.isFinite(outage)) assert.equal(await pending, "verified");
    else await assert.rejects(pending, /BODY_PREVIEW_UNAVAILABLE/);
    assert.ok(now >= Math.min(outage, 120_000) && now <= 120_000);
    assert.ok(retries > 0 && retries < 20);
  }
});

test("validation never retries changed selection, integrity, disabled policy or unknown failures", async () => {
  for (const error of [new InteractiveError("INTERACTIVE_SUPERSEDED"), new InteractiveError("CONVERTER_INTEGRITY"),
    new InteractiveError("SKIN_NOT_CSP_CERTIFIED", 503), new Error("unknown")]) {
    let calls = 0;
    await assert.rejects(recoverValidation(async () => { calls++; throw error; }, new AbortController().signal,
      new Date(Date.now() + 3600_000).toISOString(), () => assert.fail("unexpected retry")), e => e === error);
    assert.equal(calls, 1);
  }
});

test("cancellation during recovery prevents another validation or publication", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(recoverValidation(async () => { calls++; throw new InteractiveError("BODY_PREVIEW_UNAVAILABLE", 503); },
    controller.signal, new Date(3600_000).toISOString(), () => {}, {
      now: () => 0, sleep: async () => { controller.abort(new Error("cancelled")); },
    }), /cancelled/);
  assert.equal(calls, 1);
});
