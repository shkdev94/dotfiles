// Run with: node --test claude/hooks/report-gate.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate as check } from "./check-on-stop.mjs";
import {
  MAX_REPORT_REJECTS,
  nextAttempt,
  readRecords,
  recordDelivered,
  recordStart,
  rejectNotice,
  resolveVerdicts,
  statePath,
  takeNotices,
} from "./delegation-state.mjs";
import { appendJsonl, statePaths } from "./project-tools.mjs";
import { evaluate as record } from "./record-edit.mjs";
import { evaluate as gate } from "./report-gate.mjs";

const HANDBACK_DENY_LIMIT =
  "반려 한도를 넘었다. 보고는 전달되지 않고 원문과 사유는 메인에 따로 전달된다. 더 고치거나 다시 제출하지 말고 종료하라";

function writeProjectFile(root, relativePath, content = "") {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function fakeScript(root, name, body) {
  chmodSync(writeProjectFile(root, `node_modules/.bin/${name}`, `#!/bin/sh\n${body}\n`), 0o755);
}

// A tsc that prints `output` and exits with `exit`; every run is appended to `log` when one is given.
function fakeTsc(root, { exit = 2, output = "src/a.ts(3,5): error TS2322: bad", log = null } = {}) {
  const logLine = log === null ? "" : `echo run >> "${log}"\n`;
  fakeScript(root, "tsc", `${logLine}cat <<'FAKE_EOF'\n${output}\nFAKE_EOF\nexit ${exit}`);
}

const editInput = (file, extra = {}) => ({
  session_id: "s1",
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: { file_path: file },
  ...extra,
});

const WORKER_REPORT = {
  agent: "worker",
  plan: null,
  id: "n1",
  summary: "s",
  status: "done",
  changed: [{ path: "src/a.ts", summary: "s" }],
  checks: [{ command: "node --test", result: "pass" }],
  issues: [],
};

const reviewerReport = (extra = {}) => ({
  agent: "reviewer",
  plan: null,
  id: "r1",
  summary: "s",
  verifies: "n1",
  verdict: "pass",
  findings: [{ claim: "c", status: "confirmed", evidence: ["src/a.ts:1"] }],
  ...extra,
});

describe("report-gate", () => {
  let root;
  let stateDir;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "gate-project-")));
    mkdirSync(join(root, ".git"));
    stateDir = mkdtempSync(join(tmpdir(), "gate-state-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  const WORKER = { agent_id: "agent-w1", agent_type: "worker" };
  const REVIEWER = { agent_id: "agent-r1", agent_type: "reviewer" };
  const recordsOf = (kind) => readRecords({ session_id: "s1" }, stateDir).filter((entry) => entry.kind === kind);

  const handback = (agent, message, extra = {}) => ({
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "SubagentHandback",
    tool_input: { message: typeof message === "string" ? message : JSON.stringify(message) },
    tool_use_id: "tu-1",
    cwd: root,
    ...agent,
    ...extra,
  });
  const delivered = (agent, message) => ({ ...handback(agent, message), hook_event_name: "PostToolUse" });
  const subagentStop = (agent, message, extra = {}) => ({
    session_id: "s1",
    hook_event_name: "SubagentStop",
    cwd: root,
    ...(message === undefined ? {} : { last_assistant_message: typeof message === "string" ? message : JSON.stringify(message) }),
    ...agent,
    ...extra,
  });

  // A project whose tsc fails, with one edited file of `agent`. Returns the tsc run log.
  function setupFailingTsc(agent = WORKER) {
    writeProjectFile(root, "tsconfig.json", "{}");
    writeProjectFile(root, "package.json", JSON.stringify({ devDependencies: { typescript: "1.0.0" } }));
    const log = join(stateDir, "tsc.log");
    fakeTsc(root, { log });
    record(editInput(writeProjectFile(root, "src/a.ts", "x"), agent), { stateDir });
    return log;
  }

  const tscRuns = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0);

  describe("SubagentStop of the four agents (the report is last_assistant_message)", () => {
    it("blocks a report that is not JSON without running any check, and does not record the stop", async () => {
      const log = setupFailingTsc();

      const result = await gate(subagentStop(WORKER, "NODE n1: done"), { stateDir });

      assert.equal(result.decision, "block");
      assert.equal(result.hookSpecificOutput, undefined);
      assert.ok(result.reason.startsWith("보고 형식이 맞지 않는다."));
      assert.ok(result.reason.includes("올바른 JSON이 아니다"));
      assert.ok(result.reason.includes("형식 정의: ~/.claude/agents/worker.md의 보고 방식 절"));
      assert.ok(result.reason.includes(rejectNotice(1, "stop")));
      assert.ok(result.reason.endsWith("고친 뒤 다시 보고하라"));
      assert.equal(tscRuns(log), 0);
      assert.equal(recordsOf("stop").length, 0);
      const [reject] = recordsOf("reject");
      assert.deepEqual({ source: reject.source, n: reject.n, agentId: reject.agentId }, { source: "stop", n: 1, agentId: "agent-w1" });
    });

    it("lists every format problem in one reason and points planner to its output section", async () => {
      const result = await gate(subagentStop({ agent_id: "agent-p1", agent_type: "planner" }, { agent: "worker", plan: null }), {
        stateDir,
      });

      assert.equal(result.decision, "block");
      assert.ok(result.reason.includes('- agent는 "planner"이어야 한다'));
      assert.ok(result.reason.includes("- summary는 비어 있지 않은 문자열이어야 한다"));
      assert.ok(result.reason.includes("형식 정의: ~/.claude/agents/planner.md의 출력 형식 절"));
    });

    it("runs the checks once the format is valid and blocks on their result without the kind limit text", async () => {
      const log = setupFailingTsc();

      const result = await gate(subagentStop(WORKER, WORKER_REPORT), { stateDir });

      assert.equal(result.decision, "block");
      assert.ok(result.reason.startsWith("[타입 검사]"));
      assert.ok(result.reason.includes("TS2322"));
      assert.ok(result.reason.includes("이번 변경으로 생긴 오류는 고친다."));
      assert.ok(!result.reason.includes("보고 전에"));
      assert.ok(result.reason.includes(rejectNotice(1, "stop")));
      assert.equal(tscRuns(log), 1);
      assert.equal(existsSync(statePaths(subagentStop(WORKER), stateDir).typecheckBlocksPath), false);
      assert.equal(recordsOf("stop").length, 0);
    });

    it("counts the rejects of one agent across format and check failures", async () => {
      setupFailingTsc();

      const first = await gate(subagentStop(WORKER, "not json"), { stateDir });
      const second = await gate(subagentStop(WORKER, WORKER_REPORT), { stateDir });
      const third = await gate(subagentStop(WORKER, WORKER_REPORT), { stateDir });

      assert.ok(first.reason.includes(rejectNotice(1, "stop")));
      assert.ok(second.reason.includes(rejectNotice(2, "stop")));
      assert.ok(third.reason.includes(rejectNotice(3, "stop")));
      assert.ok(!third.reason.includes("이번이 마지막 확인이다."));
      assert.equal(nextAttempt({ session_id: "s1" }, "agent-w1", stateDir), 4);
    });

    it("allows a valid report whose checks pass, records the worker stop and clears the edited files", async () => {
      writeProjectFile(root, "tsconfig.json", "{}");
      writeProjectFile(root, "package.json", JSON.stringify({ devDependencies: { typescript: "1.0.0" } }));
      fakeTsc(root, { exit: 0, output: "" });
      record(editInput(writeProjectFile(root, "src/a.ts", "x"), WORKER), { stateDir });

      assert.equal(await gate(subagentStop(WORKER, WORKER_REPORT), { stateDir }), null);

      assert.deepEqual(recordsOf("stop").map((entry) => entry.agentId), ["agent-w1"]);
      assert.equal(recordsOf("reject").length, 0);
      assert.equal(existsSync(statePaths(subagentStop(WORKER), stateDir).filesPath), false);
    });

    it("allows a valid report of an agent that edited nothing", async () => {
      const researcher = { agent: "researcher", plan: null, id: "q1", summary: "s", evidence: [{ claim: "c", status: "confirmed", source: "a.ts:1" }], unverified: [] };
      assert.equal(await gate(subagentStop({ agent_id: "agent-x", agent_type: "researcher" }, researcher), { stateDir }), null);
    });

    it("compares the report with the request the agent was started with", async () => {
      appendJsonl(statePath({ session_id: "s1" }, stateDir), {
        kind: "launch",
        toolUseId: "t1",
        agentType: "worker",
        plan: "p1",
        id: "n1",
        request: { plan: "p1", id: "n1" },
      });
      appendJsonl(statePath({ session_id: "s1" }, stateDir), { kind: "bind", toolUseId: "t1", agentId: "agent-w1", status: "async_launched" });

      const result = await gate(subagentStop(WORKER, WORKER_REPORT), { stateDir });

      assert.equal(result.decision, "block");
      assert.ok(result.reason.includes('plan은 요청의 plan("p1")과 같아야 한다'));
      assert.equal(await gate(subagentStop(WORKER, { ...WORKER_REPORT, plan: "p1" }), { stateDir }), null);
    });

    it("lets the fourth bad report through as invalid: archive, notice and stop, no block", async () => {
      for (let attempt = 1; attempt <= MAX_REPORT_REJECTS; attempt += 1) {
        assert.equal((await gate(subagentStop(WORKER, "NODE n1: done"), { stateDir })).decision, "block");
      }

      const result = await gate(subagentStop(WORKER, "NODE n1: done"), { stateDir });

      assert.equal(result, null);
      const [invalid] = recordsOf("invalid");
      assert.equal(invalid.delivered, true);
      assert.equal(invalid.source, "stop");
      assert.equal(invalid.agentType, "worker");
      assert.equal(readFileSync(invalid.rawPath, "utf8"), "NODE n1: done");
      assert.equal(recordsOf("stop").length, 1);
      assert.equal(recordsOf("reject").length, 3);
      const notices = takeNotices({ session_id: "s1" }, stateDir);
      assert.equal(notices.length, 1);
      assert.ok(notices[0].includes("무효로 전달"));
      assert.ok(notices[0].includes("NODE n1: done"));
    });

    it("sends the fourth report that fails a check through as invalid too", async () => {
      const log = setupFailingTsc();
      for (let attempt = 1; attempt <= MAX_REPORT_REJECTS; attempt += 1) {
        assert.equal((await gate(subagentStop(WORKER, WORKER_REPORT), { stateDir })).decision, "block");
      }

      assert.equal(await gate(subagentStop(WORKER, WORKER_REPORT), { stateDir }), null);

      assert.equal(tscRuns(log), 4);
      const [invalid] = recordsOf("invalid");
      assert.deepEqual(invalid.reasons, ["[타입 검사]"]);
      assert.equal(recordsOf("stop").length, 1);
    });

    it("records the verdict of a valid reviewer report and counts an invalid one as fail", async () => {
      assert.equal(await gate(subagentStop(REVIEWER, reviewerReport()), { stateDir }), null);
      const [verdict] = recordsOf("verdict");
      assert.deepEqual(
        { agentId: verdict.agentId, node: verdict.node, verdict: verdict.verdict, source: verdict.source },
        { agentId: "agent-r1", node: "n1", verdict: "pass", source: "stop" },
      );
      assert.equal(recordsOf("stop").length, 0);

      const other = { agent_id: "agent-r2", agent_type: "reviewer" };
      for (let attempt = 1; attempt <= MAX_REPORT_REJECTS; attempt += 1) {
        assert.equal((await gate(subagentStop(other, "no json"), { stateDir })).decision, "block");
      }
      assert.equal(await gate(subagentStop(other, "no json"), { stateDir }), null);
      const fails = recordsOf("verdict").filter((entry) => entry.agentId === "agent-r2");
      assert.deepEqual(fails.map((entry) => [entry.verdict, entry.source]), [["fail", "stop"]]);
      assert.equal(recordsOf("notice").length, 1);
      assert.ok(recordsOf("notice")[0].text.includes("fail로 집계했다."));
    });

    it("does not check an agent that went through SubagentHandback since its last start, but records the stop", async () => {
      const log = setupFailingTsc();
      recordStart({ session_id: "s1", ...WORKER }, stateDir);
      recordDelivered({ session_id: "s1", ...WORKER }, stateDir);

      assert.equal(await gate(subagentStop(WORKER, "NODE n1: done"), { stateDir }), null);

      assert.equal(tscRuns(log), 0);
      assert.equal(recordsOf("stop").length, 1);
      assert.equal(recordsOf("reject").length, 0);
    });

    it("treats a refused SubagentHandback as a trace too, and a later start as a fresh run", async () => {
      const log = setupFailingTsc();
      assert.equal((await gate(handback(WORKER, "not json"), { stateDir })).hookSpecificOutput.permissionDecision, "deny");

      assert.equal(await gate(subagentStop(WORKER, "NODE n1: done"), { stateDir }), null);
      assert.equal(recordsOf("stop").length, 1);
      assert.equal(tscRuns(log), 0);

      recordStart({ session_id: "s1", ...WORKER }, stateDir);
      const result = await gate(subagentStop(WORKER, WORKER_REPORT), { stateDir });
      assert.equal(result.decision, "block");
      assert.equal(tscRuns(log), 1);
      assert.equal(recordsOf("stop").length, 1);
    });

    it("only records the stop when there is no final message", async () => {
      const log = setupFailingTsc();

      assert.equal(await gate(subagentStop(WORKER), { stateDir }), null);
      assert.equal(await gate(subagentStop(WORKER, undefined, { last_assistant_message: 12 }), { stateDir }), null);

      assert.equal(tscRuns(log), 0);
      assert.equal(recordsOf("stop").length, 2);
    });
  });

  describe("a reviewer that ends at SubagentStop without a report to check", () => {
    const launchReviewer = (verifies = "n9") => {
      appendJsonl(statePath({ session_id: "s1" }, stateDir), {
        kind: "launch",
        toolUseId: "t9",
        agentType: "reviewer",
        plan: null,
        id: "r1",
        verifies,
        request: { plan: null, id: "r1", verifies },
      });
      appendJsonl(statePath({ session_id: "s1" }, stateDir), { kind: "bind", toolUseId: "t9", agentId: "agent-r1", status: "async_launched" });
    };
    const resolved = () => resolveVerdicts(readRecords({ session_id: "s1" }, stateDir)).map((entry) => entry.verdict);

    for (const [label, message] of [
      ["with text", "NODE n9: done"],
      ["without text", undefined],
    ]) {
      it(`counts as fail after a refused handback was never fixed (${label})`, async () => {
        launchReviewer();
        recordStart({ session_id: "s1", ...REVIEWER }, stateDir);
        assert.equal((await gate(handback(REVIEWER, "bad"), { stateDir })).hookSpecificOutput.permissionDecision, "deny");
        assert.equal(recordsOf("verdict").length, 0);

        assert.equal(await gate(subagentStop(REVIEWER, message), { stateDir }), null);

        const verdicts = recordsOf("verdict");
        assert.deepEqual(verdicts.map((entry) => [entry.agentId, entry.node, entry.verdict, entry.source]), [["agent-r1", "n9", "fail", "stop"]]);
        assert.deepEqual(resolved(), ["fail"]);
      });
    }

    it("adds no verdict after a delivered report or a handback verdict, and does not override a pass", async () => {
      launchReviewer("n1");
      recordStart({ session_id: "s1", ...REVIEWER }, stateDir);
      await gate(delivered(REVIEWER, reviewerReport()), { stateDir });
      assert.equal(recordsOf("verdict").length, 1);

      assert.equal(await gate(subagentStop(REVIEWER, "NODE n1: pass"), { stateDir }), null);
      assert.equal(await gate(subagentStop(REVIEWER), { stateDir }), null);

      assert.deepEqual(recordsOf("verdict").map((entry) => [entry.verdict, entry.source]), [["pass", "handback"]]);
      assert.deepEqual(resolved(), ["pass"]);
    });

    it("keeps the handback pass when a stop without text arrives before PostToolUse(SubagentHandback)", async () => {
      launchReviewer("n1");
      recordStart({ session_id: "s1", ...REVIEWER }, stateDir);
      await gate(handback(REVIEWER, "bad"), { stateDir });

      assert.equal(await gate(subagentStop(REVIEWER), { stateDir }), null);
      assert.deepEqual(resolved(), ["fail"]);
      await gate(delivered(REVIEWER, reviewerReport()), { stateDir });

      assert.deepEqual(recordsOf("verdict").map((entry) => [entry.verdict, entry.source]), [["fail", "stop"], ["pass", "handback"]]);
      assert.deepEqual(resolved(), ["pass"]);
    });

    it("counts a verdict before the last start as no report of the new run", async () => {
      launchReviewer("n1");
      recordStart({ session_id: "s1", ...REVIEWER }, stateDir);
      await gate(delivered(REVIEWER, reviewerReport()), { stateDir });
      recordStart({ session_id: "s1", ...REVIEWER }, stateDir);

      assert.equal(await gate(subagentStop(REVIEWER), { stateDir }), null);

      assert.deepEqual(recordsOf("verdict").map((entry) => entry.verdict), ["pass", "fail"]);
    });

    it("leaves planner and researcher without records and the worker with its stop", async () => {
      recordStart({ session_id: "s1", ...WORKER }, stateDir);
      for (const agent of [{ agent_id: "agent-p1", agent_type: "planner" }, { agent_id: "agent-q1", agent_type: "researcher" }, WORKER]) {
        assert.equal(await gate(subagentStop(agent), { stateDir }), null);
      }
      assert.equal(recordsOf("verdict").length, 0);
      assert.deepEqual(recordsOf("stop").map((entry) => entry.agentId), ["agent-w1"]);
    });

    it("still records the end when the gate throws: the worker stop and the reviewer fail", async () => {
      launchReviewer();
      const checkReport = async () => {
        throw new Error("boom");
      };
      const options = { stateDir, checkReport };

      assert.equal(await gate(subagentStop(WORKER, WORKER_REPORT), options), null);
      assert.equal(await gate(subagentStop(REVIEWER, reviewerReport({ verifies: "n9" })), options), null);

      assert.deepEqual(recordsOf("stop").map((entry) => entry.agentId), ["agent-w1"]);
      assert.deepEqual(recordsOf("verdict").map((entry) => [entry.agentId, entry.node, entry.verdict, entry.source]), [["agent-r1", "n9", "fail", "stop"]]);
      assert.equal(recordsOf("reject").length, 0);
    });

    it("lets the exception of a handback through as before (the agent can retry)", async () => {
      const checkReport = async () => {
        throw new Error("boom");
      };
      await assert.rejects(gate(handback(WORKER, WORKER_REPORT), { stateDir, checkReport }), /boom/);
    });
  });

  describe("PreToolUse on SubagentHandback of the four agents", () => {
    it("denies a report that is not valid without running any check", async () => {
      const log = setupFailingTsc();

      const result = await gate(handback(WORKER, "NODE n1: done"), { stateDir });

      assert.deepEqual(Object.keys(result), ["hookSpecificOutput"]);
      assert.equal(result.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
      const reason = result.hookSpecificOutput.permissionDecisionReason;
      assert.ok(reason.startsWith("보고 형식이 맞지 않는다."));
      assert.ok(reason.includes("형식 정의: ~/.claude/agents/worker.md의 보고 방식 절"));
      assert.ok(reason.includes(rejectNotice(1, "handback")));
      assert.ok(reason.endsWith("고친 뒤 SubagentHandback을 다시 호출하라"));
      assert.equal(tscRuns(log), 0);
      const [reject] = recordsOf("reject");
      assert.deepEqual({ source: reject.source, n: reject.n, toolUseId: reject.toolUseId }, { source: "handback", n: 1, toolUseId: "tu-1" });
    });

    it("denies a valid report whose checks fail, with the before-report wording", async () => {
      const log = setupFailingTsc();

      const result = await gate(handback(WORKER, WORKER_REPORT), { stateDir });

      const reason = result.hookSpecificOutput.permissionDecisionReason;
      assert.ok(reason.startsWith("[타입 검사]"));
      assert.ok(reason.includes("보고 전에 이번 변경으로 생긴 오류는 고친다."));
      assert.ok(reason.includes(rejectNotice(1, "handback")));
      assert.equal(tscRuns(log), 1);
    });

    it("denies a text-only notice once with the notice and the retry request, then lets the report through", async () => {
      writeProjectFile(root, "tsconfig.json", "{}");
      writeProjectFile(root, "package.json", JSON.stringify({ devDependencies: { typescript: "1.0.0" } }));
      fakeScript(root, "tsc", "sleep 5");
      record(editInput(writeProjectFile(root, "src/a.ts", "x"), WORKER), { stateDir });
      const options = { stateDir, timeouts: { tsc: 1000 } };

      const first = await gate(handback(WORKER, WORKER_REPORT), options);

      const reason = first.hookSpecificOutput.permissionDecisionReason;
      assert.ok(reason.includes("[검증하지 못한 항목]"));
      assert.ok(reason.includes("- tsc가 1초 안에 끝나지 않아 검증하지 못했다."));
      assert.ok(reason.includes(rejectNotice(1, "handback")));
      assert.equal(await gate(handback(WORKER, WORKER_REPORT), options), null);
    });

    it("allows a valid report whose checks pass", async () => {
      assert.equal(await gate(handback(WORKER, WORKER_REPORT), { stateDir }), null);
      assert.equal(recordsOf("reject").length, 0);
      assert.equal(recordsOf("delivered").length, 0);
    });

    it("denies the first three attempts with the notice, then every further attempt with the stop reason", async () => {
      for (let attempt = 1; attempt <= MAX_REPORT_REJECTS; attempt += 1) {
        const result = await gate(handback(REVIEWER, `bad ${attempt}`), { stateDir });
        assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes(rejectNotice(attempt, "handback")));
      }
      assert.equal(recordsOf("invalid").length, 0);

      for (const attempt of [4, 5, 6]) {
        const result = await gate(handback(REVIEWER, `bad ${attempt}`), { stateDir });
        assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
        assert.equal(result.hookSpecificOutput.permissionDecisionReason, HANDBACK_DENY_LIMIT);
      }

      const invalid = recordsOf("invalid");
      assert.deepEqual(invalid.map((entry) => entry.delivered), [false, false, false]);
      assert.deepEqual(invalid.map((entry) => readFileSync(entry.rawPath, "utf8")), ["bad 4", "bad 5", "bad 6"]);
      assert.equal(recordsOf("reject").length, 6);
      const fails = recordsOf("verdict");
      assert.equal(fails.length, 3);
      assert.ok(fails.every((entry) => entry.verdict === "fail" && entry.source === "handback"));
      // Only the latest notice of the agent reaches the main conversation.
      const notices = takeNotices({ session_id: "s1" }, stateDir);
      assert.equal(notices.length, 1);
      assert.ok(notices[0].includes("bad 6"));
      assert.ok(notices[0].includes("미전달"));
    });

    it("does not archive anything for a report denied within the limit, and uses the request node for the verdict", async () => {
      appendJsonl(statePath({ session_id: "s1" }, stateDir), {
        kind: "launch",
        toolUseId: "t9",
        agentType: "reviewer",
        plan: null,
        id: "r1",
        verifies: "n9",
        request: { plan: null, id: "r1", verifies: "n9" },
      });
      appendJsonl(statePath({ session_id: "s1" }, stateDir), { kind: "bind", toolUseId: "t9", agentId: "agent-r1", status: "async_launched" });
      for (let attempt = 1; attempt <= MAX_REPORT_REJECTS + 1; attempt += 1) {
        await gate(handback(REVIEWER, "bad"), { stateDir });
      }

      const [verdict] = recordsOf("verdict");
      assert.equal(verdict.node, "n9");
      assert.deepEqual(resolveVerdicts(readRecords({ session_id: "s1" }, stateDir)).map((entry) => entry.verdict), ["fail"]);
    });

    it("does nothing for other tools", async () => {
      setupFailingTsc();
      assert.equal(await gate(handback(WORKER, "x", { tool_name: "Bash" }), { stateDir }), null);
      assert.equal(await gate(handback(WORKER, "x", { tool_name: "Read" }), { stateDir }), null);
      assert.equal(recordsOf("reject").length, 0);
    });
  });

  describe("PostToolUse on SubagentHandback", () => {
    it("records the delivery, which resets the attempt count", async () => {
      await gate(handback(WORKER, "bad"), { stateDir });
      assert.equal(nextAttempt({ session_id: "s1" }, "agent-w1", stateDir), 2);

      assert.equal(await gate(delivered(WORKER, WORKER_REPORT), { stateDir }), null);

      assert.equal(recordsOf("delivered").length, 1);
      assert.equal(nextAttempt({ session_id: "s1" }, "agent-w1", stateDir), 1);
      assert.equal(recordsOf("verdict").length, 0);
    });

    it("records a reviewer verdict from the handback, fail for a report that is not valid", async () => {
      await gate(delivered(REVIEWER, reviewerReport()), { stateDir });
      await gate(delivered({ agent_id: "agent-r2", agent_type: "reviewer" }, reviewerReport({ verdict: "maybe" })), { stateDir });

      const verdicts = recordsOf("verdict");
      assert.deepEqual(
        verdicts.map((entry) => [entry.agentId, entry.node, entry.verdict, entry.source]),
        [
          ["agent-r1", "n1", "pass", "handback"],
          ["agent-r2", "n1", "fail", "handback"],
        ],
      );
    });

    it("does not check the files at the later SubagentStop of an agent whose report was delivered", async () => {
      await gate(delivered(WORKER, WORKER_REPORT), { stateDir });
      const log = setupFailingTsc();

      assert.equal(await gate(subagentStop(WORKER, WORKER_REPORT), { stateDir }), null);

      assert.equal(tscRuns(log), 0);
      assert.equal(recordsOf("stop").length, 1);
    });
  });

  describe("other agents and the main conversation", () => {
    it("keeps the check-on-stop output for another agent without checking the report format", async () => {
      setupFailingTsc({ agent_id: "agent-g1", agent_type: "general-purpose" });
      const agent = { agent_id: "agent-g1", agent_type: "general-purpose" };

      const stop = await gate(subagentStop(agent, "free text"), { stateDir });
      assert.equal(stop.decision, "block");
      assert.ok(stop.reason.startsWith("[타입 검사]"));
      assert.ok(!stop.reason.includes("보고 반려"));
      assert.equal(recordsOf("reject").length, 0);
    });

    it("lets another agent report anything when it edited nothing", async () => {
      const agent = { agent_id: "agent-g1", agent_type: "Explore" };
      assert.equal(await gate(handback(agent, "free text"), { stateDir }), null);
      assert.equal(await gate(subagentStop(agent, "free text"), { stateDir }), null);
    });

    it("leaves SubagentStop and SubagentHandback to the gate in check-on-stop", async () => {
      setupFailingTsc();
      assert.equal(await check(subagentStop(WORKER, WORKER_REPORT), { stateDir }), null);
      assert.equal(await check(handback(WORKER, WORKER_REPORT), { stateDir }), null);
      assert.equal(await check({ session_id: "s1", hook_event_name: "SubagentStop", cwd: root }, { stateDir }), null);
    });
  });

  describe("invoked as a command", () => {
    const script = fileURLToPath(new URL("report-gate.mjs", import.meta.url));

    function run(input) {
      const { stdout } = spawnSync(process.execPath, [script], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_HOOKS_STATE_DIR: stateDir },
      });
      return stdout === "" ? null : JSON.parse(stdout);
    }

    it("denies an invalid handback and blocks an invalid SubagentStop with their own output formats", () => {
      const denied = run(handback(WORKER, "bad"));
      assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
      const blocked = run(subagentStop({ agent_id: "agent-w2", agent_type: "worker" }, "bad"));
      assert.equal(blocked.decision, "block");
      assert.ok(blocked.reason.includes(rejectNotice(1, "stop")));
    });

    it("prints nothing for a valid report", () => {
      assert.equal(run(handback(WORKER, WORKER_REPORT)), null);
      assert.equal(run(delivered(WORKER, WORKER_REPORT)), null);
    });
  });
});
