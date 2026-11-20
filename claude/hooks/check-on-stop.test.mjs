// Run with: node --test claude/hooks/check-on-stop.test.mjs
// Stop delivers the waiting [report-gate] notices to the main conversation.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { evaluate, withNotices } from "./check-on-stop.mjs";
import { archiveInvalidReport, takeNotices } from "./delegation-state.mjs";

describe("check-on-stop notices", () => {
  let stateDir;
  let cwd;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "check-on-stop-state-"));
    cwd = mkdtempSync(join(tmpdir(), "check-on-stop-cwd-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const stopInput = (extra = {}) => ({ session_id: "s1", hook_event_name: "Stop", cwd, ...extra });
  const queueNotice = (raw = "깨진 원문") =>
    archiveInvalidReport({
      input: { session_id: "s1", agent_id: "a1", agent_type: "worker" },
      stateDir,
      agentType: "worker",
      plan: "p1",
      id: "n1",
      source: "stop",
      reasons: ["status가 없다"],
      raw,
      n: 4,
      delivered: true,
    });

  describe("evaluate", () => {
    it("hands a waiting notice to the main conversation once", async () => {
      queueNotice();

      const first = await evaluate(stopInput(), { stateDir });
      const second = await evaluate(stopInput({ stop_hook_active: true }), { stateDir });

      assert.equal(first.hookSpecificOutput.hookEventName, "Stop");
      assert.match(first.hookSpecificOutput.additionalContext, /\[report-gate\]/);
      assert.match(first.hookSpecificOutput.additionalContext, /깨진 원문/);
      assert.equal(second, null);
    });

    it("delivers a notice even when stop_hook_active is true", async () => {
      queueNotice();

      const result = await evaluate(stopInput({ stop_hook_active: true }), { stateDir });

      assert.match(result.hookSpecificOutput.additionalContext, /\[report-gate\]/);
    });

    it("is null without notices and without check results", async () => {
      assert.equal(await evaluate(stopInput(), { stateDir }), null);
    });

    it("leaves the notices alone for a Stop with an agent_id", async () => {
      queueNotice();

      const sub = await evaluate(stopInput({ agent_id: "a2" }), { stateDir });

      assert.equal(sub, null);
      assert.equal(takeNotices(stopInput(), stateDir).length, 1);
    });

    it("does not give a notice a Stop consumed to takeNotices again", async () => {
      queueNotice();

      await evaluate(stopInput(), { stateDir });

      assert.deepEqual(takeNotices(stopInput(), stateDir), []);
    });
  });

  describe("withNotices", () => {
    const notices = ["[report-gate] a", "[report-gate] b"];

    it("returns the output as it is without notices", () => {
      const output = { decision: "block", reason: "r" };
      assert.equal(withNotices(output, []), output);
      assert.equal(withNotices(null, []), null);
    });

    it("makes an additionalContext output from null", () => {
      assert.deepEqual(withNotices(null, notices), {
        hookSpecificOutput: { hookEventName: "Stop", additionalContext: "[report-gate] a\n[report-gate] b" },
      });
    });

    it("appends to an additionalContext after a blank line", () => {
      const output = { hookSpecificOutput: { hookEventName: "Stop", additionalContext: "문맥" } };
      assert.equal(withNotices(output, notices).hookSpecificOutput.additionalContext, "문맥\n\n[report-gate] a\n[report-gate] b");
    });

    it("appends to a block reason after a blank line", () => {
      assert.deepEqual(withNotices({ decision: "block", reason: "사유" }, notices), {
        decision: "block",
        reason: "사유\n\n[report-gate] a\n[report-gate] b",
      });
    });
  });
});
