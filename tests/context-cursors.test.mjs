import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgeContextDelivery, applyContextCursorUpdates, bindContextCursorToThread, discardPendingContextDelivery } from "../src/lib/contextCursors.js";

function cursor(agentId, sequence, threadId = null, messageId = `m-${sequence}`) {
  return {
    initialized: true,
    agentId,
    threadId,
    deliverySequence: sequence,
    messageFingerprints: { [messageId]: `fp-${sequence}` },
    knowledgeFingerprints: {},
  };
}

test("a stale browser ACK cannot overwrite a newer durable cursor", () => {
  const current = applyContextCursorUpdates({}, { "agent:developer": cursor("developer", 2) }, { developer: "thread-developer" });
  const stale = applyContextCursorUpdates(current, { "agent:developer": cursor("developer", 1) }, { developer: "thread-developer" });

  assert.deepEqual(stale["thread:thread-developer"].messageFingerprints, current["thread:thread-developer"].messageFingerprints);
  assert.equal(stale["thread:thread-developer"].deliverySequence, 2);
});

test("an unbound cursor migrates to its first real thread, but never to a different known thread", () => {
  const initial = { "agent:developer": cursor("developer", 1) };
  const bound = bindContextCursorToThread(initial, "developer", "thread-developer");
  assert.equal(bound["thread:thread-developer"].threadId, "thread-developer");
  assert.equal(bound["agent:developer"], undefined);

  const changed = bindContextCursorToThread({ "agent:developer": cursor("developer", 1, "thread-old") }, "developer", "thread-new");
  assert.equal(changed["thread:thread-new"], undefined);
  assert.equal(changed["agent:developer"].threadId, "thread-old");
});

test("remote turnStarted acknowledgements advance one member at a time", () => {
  const pendingUpdates = {
    "agent:developer": cursor("developer", 7),
    "agent:reviewer": cursor("reviewer", 7),
  };
  const pending = [{ taskId: "task-7", messageId: "message-7", updates: pendingUpdates }];
  const notYetAcknowledged = acknowledgeContextDelivery({ cursors: {}, pending, taskId: "wrong-task", messageId: "wrong-message", agentId: "developer", threadId: "thread-developer" });
  assert.deepEqual(notYetAcknowledged.cursors, {});
  assert.equal(notYetAcknowledged.pending.length, 1);

  const developerAck = acknowledgeContextDelivery({ cursors: {}, pending, taskId: "task-7", agentId: "developer", threadId: "thread-developer" });
  assert.equal(developerAck.cursors["thread:thread-developer"].deliverySequence, 7);
  assert.equal(developerAck.pending[0].updates["agent:reviewer"].agentId, "reviewer");
  assert.equal(developerAck.pending[0].updates["agent:developer"], undefined);

  const reviewerAck = acknowledgeContextDelivery({ cursors: developerAck.cursors, pending: developerAck.pending, taskId: "task-7", agentId: "reviewer", threadId: "thread-reviewer" });
  assert.equal(reviewerAck.cursors["thread:thread-reviewer"].deliverySequence, 7);
  assert.deepEqual(reviewerAck.pending, []);
});

test("silent members do not advance, a later delegated turn ACKs them, and task terminal cleanup drops unused updates", () => {
  const pending = [{
    taskId: "task-delegated",
    messageId: "message-delegated",
    updates: {
      "agent:coordinator": cursor("coordinator", 8),
      "agent:developer": cursor("developer", 8),
      "agent:reviewer": cursor("reviewer", 8),
    },
  }];
  const initial = acknowledgeContextDelivery({ cursors: {}, pending, taskId: "task-delegated", agentId: "coordinator", threadId: "thread-coordinator" });
  assert.equal(initial.cursors["thread:thread-developer"], undefined);
  assert.equal(initial.pending[0].updates["agent:developer"].agentId, "developer");

  const delegated = acknowledgeContextDelivery({ cursors: initial.cursors, pending: initial.pending, taskId: "task-delegated", agentId: "developer", threadId: "thread-developer" });
  assert.equal(delegated.cursors["thread:thread-developer"].deliverySequence, 8);
  assert.equal(delegated.pending[0].updates["agent:reviewer"].agentId, "reviewer");

  const cleaned = discardPendingContextDelivery(delegated.pending, { taskId: "task-delegated" });
  assert.deepEqual(cleaned, []);
  assert.equal(delegated.cursors["thread:thread-reviewer"], undefined);
});
