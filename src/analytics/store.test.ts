import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeEventProperties } from "./store.js";

test("event properties use an allow-list and drop paths or arbitrary text", () => {
  assert.deepEqual(
    sanitizeEventProperties("candidate_selected", {
      personIndex: 0,
      candidateId: "pose-1",
      previousCandidateId: null,
      rank: 1,
      surface: "app",
      localPath: "C:/secret/storyboard.png",
      note: "private dialogue",
    }),
    {
      personIndex: 0,
      candidateId: "pose-1",
      previousCandidateId: null,
      rank: 1,
      surface: "app",
    },
  );
});

test("unknown event names are rejected", () => {
  assert.equal(sanitizeEventProperties("raw_text", { value: "secret" }), null);
});

test("selection confirmation exposes only the selection count", () => {
  assert.deepEqual(
    sanitizeEventProperties("selection_confirmed", {
      selectionCount: 2,
      candidateIds: ["private-candidate"],
    }),
    { selectionCount: 2 },
  );
});
