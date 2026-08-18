import assert from "node:assert/strict";
import test from "node:test";
import { parseQueueMessage } from "./queue.js";

test("queue message에는 version과 jobId만 허용한다", () => {
  assert.deepEqual(parseQueueMessage('{"version":1,"jobId":"job_123e4567-e89b"}'), {
    version: 1,
    jobId: "job_123e4567-e89b",
  });
  assert.equal(parseQueueMessage('{"version":2,"jobId":"job_123"}'), null);
  assert.equal(parseQueueMessage('{"version":1,"jobId":"../../secret"}'), null);
  assert.equal(parseQueueMessage("not-json"), null);
});
