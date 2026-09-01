import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "../src/server/agent/session.js";

describe("AgentSession — stale approval handling", () => {
  it("auto-denies pending approvals from an abandoned turn when a new turn starts", async () => {
    const session = new AgentSession("s1", "/tmp/ws");
    session.resume();

    const approvalPromise = session.awaitApproval("call-1");

    // A new user message comes in before the pending approval is resolved —
    // resume() is called again for the new turn.
    session.resume();

    const approved = await approvalPromise;
    assert.equal(approved, false, "stale approval should be auto-denied");
  });

  it("does not affect approvals resolved before the next turn starts", async () => {
    const session = new AgentSession("s1", "/tmp/ws");
    session.resume();

    const approvalPromise = session.awaitApproval("call-1");
    session.resolveApproval("call-1", true);

    const approved = await approvalPromise;
    assert.equal(approved, true);

    // No pending approvals left, so a subsequent resume() should be a no-op.
    session.resume();
    assert.equal(session.status, "running");
  });

  it("cancel() still rejects all pending approvals", async () => {
    const session = new AgentSession("s1", "/tmp/ws");
    session.resume();
    const approvalPromise = session.awaitApproval("call-1");
    session.cancel();
    const approved = await approvalPromise;
    assert.equal(approved, false);
  });
});
