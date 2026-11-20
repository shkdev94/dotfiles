// Run with: node --test claude/hooks/delegation-state.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  MAX_REPORT_REJECTS,
  NOTICE_RAW_LIMIT,
  archiveInvalidReport,
  judgeReviewerReport,
  launchOfAgent,
  nextAttempt,
  readRecords,
  recordDelivered,
  recordReject,
  recordStart,
  recordStop,
  recordVerdict,
  rejectNotice,
  requestOfAgent,
  resolveVerdicts,
  statePath,
  takeNotices,
} from "./delegation-state.mjs";
import { appendJsonl } from "./project-tools.mjs";

describe("delegation-state", () => {
  let stateDir;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "delegation-state-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  const agent = (extra = {}) => ({ session_id: "s1", agent_id: "a1", agent_type: "worker", ...extra });
  const records = () => readRecords({ session_id: "s1" }, stateDir);

  describe("nextAttempt", () => {
    const reject = (n) => recordReject(agent(), { source: "handback", n }, stateDir);

    it("is 1 for an agent without records and counts the rejects after that", () => {
      assert.equal(nextAttempt(agent(), "a1", stateDir), 1);
      reject(1);
      assert.equal(nextAttempt(agent(), "a1", stateDir), 2);
      reject(2);
      reject(3);
      assert.equal(nextAttempt(agent(), "a1", stateDir), 4);
      assert.equal(MAX_REPORT_REJECTS, 3);
    });

    it("starts over at the last start and at the last delivered report", () => {
      reject(1);
      reject(2);
      recordStart(agent(), stateDir);
      assert.equal(nextAttempt(agent(), "a1", stateDir), 1);
      reject(1);
      reject(2);
      recordDelivered(agent(), stateDir);
      assert.equal(nextAttempt(agent(), "a1", stateDir), 1);
      reject(1);
      assert.equal(nextAttempt(agent(), "a1", stateDir), 2);
    });

    it("counts per agent and accepts a record list", () => {
      reject(1);
      recordReject(agent({ agent_id: "a2" }), { source: "stop", n: 1 }, stateDir);
      recordReject(agent({ agent_id: "a2" }), { source: "stop", n: 2 }, stateDir);
      assert.equal(nextAttempt(agent(), "a1", stateDir), 2);
      assert.equal(nextAttempt(records(), "a2"), 3);
      assert.equal(nextAttempt([], "a1"), 1);
    });

    it("records a reject with a fresh attempt id and the tool use id when there is one", () => {
      const first = recordReject(agent(), { source: "handback", n: 1, toolUseId: "tu1" }, stateDir);
      const second = recordReject(agent(), { source: "stop", n: 2 }, stateDir);
      assert.notEqual(first, second);
      const [one, two] = records();
      assert.deepEqual(
        { kind: one.kind, agentId: one.agentId, attemptId: one.attemptId, toolUseId: one.toolUseId, source: one.source, n: one.n },
        { kind: "reject", agentId: "a1", attemptId: first, toolUseId: "tu1", source: "handback", n: 1 },
      );
      assert.equal(two.toolUseId, null);
    });
  });

  describe("rejectNotice", () => {
    it("says how many chances are left and what happens after the last one", () => {
      assert.equal(
        rejectNotice(1, "handback"),
        "보고 반려 1/3회. 남은 제출 기회 3회. 마지막 제출도 반려되면 보고는 전달되지 않고, 원문과 사유가 메인에 따로 전달된다.",
      );
      assert.ok(rejectNotice(3, "stop").includes("남은 제출 기회 1회"));
      assert.ok(rejectNotice(2, "stop").includes("보고는 그대로 전달되지만 무효로 처리되고, 원문과 사유가 메인에 따로 전달된다."));
    });
  });

  describe("archiveInvalidReport", () => {
    const archive = (extra = {}) =>
      archiveInvalidReport({
        input: agent({ agent_type: "reviewer" }),
        stateDir,
        agentType: "reviewer",
        plan: "p1",
        id: "r1",
        source: "handback",
        reasons: ["verdict가 없다", "findings가 비었다"],
        raw: "원문",
        n: 4,
        delivered: false,
        ...extra,
      });

    it("stores the raw report under reports/<agent>-<n>.txt with mode 0600", () => {
      const { rawPath } = archive({ raw: "비밀 보고" });
      assert.equal(rawPath, join(dirname(statePath({ session_id: "s1" }, stateDir)), "reports", "a1-4.txt"));
      assert.equal(readFileSync(rawPath, "utf8"), "비밀 보고");
      assert.equal(statSync(rawPath).mode & 0o777, 0o600);
      archive({ raw: "다음 시도", n: 5 });
      assert.equal(statSync(join(dirname(rawPath), "a1-5.txt")).mode & 0o777, 0o600);
      assert.equal(readFileSync(rawPath, "utf8"), "비밀 보고");
    });

    it("keeps the mode 0600 when it overwrites an existing file", () => {
      const { rawPath } = archive();
      writeFileSync(rawPath, "x", { mode: 0o644 });
      archive({ raw: "다시" });
      assert.equal(statSync(rawPath).mode & 0o777, 0o600);
    });

    it("writes the invalid and notice records", () => {
      const { rawPath, noticeId } = archive({ delivered: true, source: "stop" });
      const invalid = records().find((record) => record.kind === "invalid");
      assert.deepEqual(
        { ...invalid, ts: undefined },
        {
          kind: "invalid",
          ts: undefined,
          agentId: "a1",
          agentType: "reviewer",
          plan: "p1",
          id: "r1",
          source: "stop",
          reasons: ["verdict가 없다", "findings가 비었다"],
          rawPath,
          rawLength: 2,
          delivered: true,
        },
      );
      const notice = records().find((record) => record.kind === "notice");
      assert.equal(notice.noticeId, noticeId);
      assert.equal(notice.agentId, "a1");
    });

    it("puts the reasons, the raw report and the fail count in the notice text", () => {
      const { text } = archive();
      assert.equal(
        text,
        "[report-gate] reviewer p1/r1 (agent a1) 보고가 반려 한도를 넘어 미전달됐다. 사유: verdict가 없다; findings가 비었다. 원문: 원문. fail로 집계했다.",
      );
      const worker = archive({ agentType: "worker", plan: null, id: "n1", delivered: true, n: 6 }).text;
      assert.ok(worker.includes("worker (plan 없음)/n1") && worker.includes("무효로 전달됐다") && !worker.includes("fail로 집계"), worker);
    });

    it("quotes the raw report up to 2000 characters and gives the path beyond", () => {
      const exactly = "가".repeat(NOTICE_RAW_LIMIT);
      assert.ok(archive({ raw: exactly }).text.includes(exactly));

      const over = archive({ raw: `${exactly}나`, n: 5 });
      assert.ok(!over.text.includes(exactly), over.text);
      assert.ok(over.text.includes(over.rawPath) && over.text.includes("researcher로 읽는다"), over.text);
      assert.equal(readFileSync(over.rawPath, "utf8"), `${exactly}나`);
      assert.equal(records().findLast((record) => record.kind === "invalid").rawLength, NOTICE_RAW_LIMIT + 1);
    });

    it("handles an empty or missing raw report", () => {
      assert.ok(archive({ raw: "" }).text.includes("원문: (비어 있음)"));
      assert.ok(archive({ raw: undefined, n: 5 }).text.includes("(비어 있음)"));
    });
  });

  describe("takeNotices", () => {
    const archiveFor = (agentId, n, raw) =>
      archiveInvalidReport({
        input: { session_id: "s1", agent_id: agentId, agent_type: "worker" },
        stateDir,
        agentType: "worker",
        plan: "p1",
        id: agentId,
        source: "stop",
        reasons: ["사유"],
        raw,
        n,
        delivered: true,
      });
    const take = () => takeNotices({ session_id: "s1" }, stateDir);

    it("returns each notice once", () => {
      assert.deepEqual(take(), []);
      archiveFor("a1", 4, "원문");
      assert.equal(take().length, 1);
      assert.deepEqual(take(), []);
    });

    it("keeps only the latest notice of an agent and marks the older ones taken", () => {
      archiveFor("a1", 4, "첫 시도");
      archiveFor("a1", 5, "다음 시도");
      archiveFor("a2", 4, "다른 agent");
      const texts = take();
      assert.equal(texts.length, 2);
      assert.ok(texts[0].includes("다음 시도") && !texts.join().includes("첫 시도"));
      assert.ok(texts[1].includes("다른 agent"));
      assert.deepEqual(take(), []);
      assert.equal(records().filter((record) => record.kind === "noticeTaken").length, 3);
    });

    it("delivers a notice that is written after an earlier one was taken", () => {
      archiveFor("a1", 4, "첫 시도");
      take();
      archiveFor("a1", 5, "다음 시도");
      const texts = take();
      assert.equal(texts.length, 1);
      assert.ok(texts[0].includes("다음 시도"));
    });

    it("keeps state per session", () => {
      archiveFor("a1", 4, "원문");
      assert.deepEqual(takeNotices({ session_id: "s2" }, stateDir), []);
      assert.equal(take().length, 1);
    });
  });

  describe("recording", () => {
    it("records a start for the four agent types only", () => {
      for (const type of ["planner", "researcher", "worker", "reviewer", "", "general-purpose", undefined]) {
        recordStart({ session_id: "s1", agent_id: `a-${type}`, agent_type: type }, stateDir, 5);
      }
      recordStart({ session_id: "s1", agent_type: "worker" }, stateDir, 5);
      assert.deepEqual(
        records().map((record) => [record.kind, record.agentType, record.ts]),
        ["planner", "researcher", "worker", "reviewer"].map((type) => ["start", type, 5]),
      );
    });

    it("records a stop for workers and a verdict for reviewers only", () => {
      recordStop(agent({ agent_type: "reviewer" }), stateDir);
      recordStop(agent(), stateDir, 7);
      recordVerdict(agent(), { node: "n1", verdict: "fail", source: "stop" }, stateDir);
      recordVerdict(agent({ agent_type: "reviewer", agent_id: "r1" }), { node: undefined, verdict: "pass", source: "handback" }, stateDir, 8);
      assert.deepEqual(records(), [
        { kind: "stop", ts: 7, agentId: "a1" },
        { kind: "verdict", ts: 8, agentId: "r1", node: null, verdict: "pass", source: "handback" },
      ]);
    });

    it("records a delivered report for every agent type", () => {
      for (const type of ["planner", "researcher", "worker", "reviewer", ""]) {
        recordDelivered(agent({ agent_type: type, agent_id: `a-${type}` }), stateDir);
      }
      assert.equal(records().filter((record) => record.kind === "delivered").length, 4);
    });
  });

  describe("resolveVerdicts", () => {
    const launch = (toolUseId, node, plan = "p1") => ({ kind: "launch", toolUseId, agentType: "reviewer", plan, id: toolUseId, verifies: node });
    const bind = (toolUseId, agentId) => ({ kind: "bind", toolUseId, agentId });
    const verdict = (agentId, result, source, node = null) => ({ kind: "verdict", agentId, node, verdict: result, ...(source === undefined ? {} : { source }) });

    it("lets a handback verdict beat a stop verdict in either order", () => {
      for (const order of [["handback", "stop"], ["stop", "handback"]]) {
        const list = [launch("t1", "n1"), bind("t1", "a1"), ...order.map((source) => verdict("a1", source === "handback" ? "pass" : "fail", source))];
        assert.deepEqual(resolveVerdicts(list).map((entry) => entry.verdict), ["pass"], order.join());
      }
    });

    it("ranks a source-less verdict with stop and the latest of equals wins", () => {
      const list = [launch("t1", "n1"), bind("t1", "a1"), verdict("a1", "fail"), verdict("a1", "pass", "stop")];
      assert.deepEqual(resolveVerdicts(list).map((entry) => entry.verdict), ["pass"]);
      const handbackFirst = [launch("t1", "n1"), bind("t1", "a1"), verdict("a1", "fail", "handback"), verdict("a1", "pass")];
      assert.deepEqual(resolveVerdicts(handbackFirst).map((entry) => entry.verdict), ["fail"]);
    });

    it("attributes to the bound launch and falls back to the node of the verdict", () => {
      const list = [launch("t1", "n1", "pA"), launch("t2", "n2", "pB"), bind("t1", "a1"), verdict("a1", "fail", "stop", "typo"), verdict("a2", "fail", "handback", "n2"), verdict("a3", "fail", "stop")];
      assert.deepEqual(
        resolveVerdicts(list).map(({ plan, node, verdict: result }) => [plan, node, result]),
        [["pA", "n1", "fail"], ["pB", "n2", "fail"]],
      );
    });
  });

  describe("judgeReviewerReport", () => {
    const report = (extra = {}) =>
      JSON.stringify({
        agent: "reviewer",
        plan: "p1",
        id: "r1",
        summary: "요약",
        verifies: "n1",
        verdict: "pass",
        findings: [{ claim: "c", status: "confirmed", evidence: ["a:1"] }],
        ...extra,
      });
    const request = { plan: "p1", id: "r1", verifies: "n1" };

    it("takes the verdict of a valid report", () => {
      assert.deepEqual(judgeReviewerReport(report(), request), { node: "n1", verdict: "pass" });
      assert.deepEqual(judgeReviewerReport(report({ verdict: "fail" })), { node: "n1", verdict: "fail" });
    });

    it("counts an invalid report as fail and keeps the node it can tell", () => {
      assert.deepEqual(judgeReviewerReport("VERDICT n1: pass", request), { node: "n1", verdict: "fail" });
      assert.deepEqual(judgeReviewerReport("VERDICT n1: pass"), { node: null, verdict: "fail" });
      assert.deepEqual(judgeReviewerReport(report({ findings: [] }), request), { node: "n1", verdict: "fail" });
      assert.deepEqual(judgeReviewerReport(report({ verifies: "zzz" }), request), { node: "zzz", verdict: "fail" });
      assert.deepEqual(judgeReviewerReport(undefined), { node: null, verdict: "fail" });
    });
  });

  describe("requestOfAgent", () => {
    const request = { agent: "worker", plan: "p1", id: "n1", writes: ["a.ts"] };
    const userLine = (content) => `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
    let projectDir;

    beforeEach(() => {
      projectDir = join(stateDir, "project");
      mkdirSync(join(projectDir, "s1", "subagents"), { recursive: true });
    });

    const transcript = (agentId) => join(projectDir, "s1", "subagents", `agent-${agentId}.jsonl`);
    const input = (extra = {}) => ({ session_id: "s1", agent_id: "a1", agent_type: "worker", transcript_path: join(projectDir, "s1.jsonl"), ...extra });

    it("prefers the request stored on the launch the agent is bound to", () => {
      appendJsonl(statePath(input(), stateDir), { kind: "launch", toolUseId: "t1", agentType: "worker", request });
      appendJsonl(statePath(input(), stateDir), { kind: "bind", toolUseId: "t1", agentId: "a1" });
      writeFileSync(transcript("a1"), userLine(JSON.stringify({ ...request, id: "other" })));
      assert.deepEqual(requestOfAgent(input(), stateDir), request);
      assert.equal(launchOfAgent(records(), "a1").toolUseId, "t1");
    });

    it("reads the first user message of the transcript otherwise, as text or as parts", () => {
      writeFileSync(transcript("a1"), userLine(JSON.stringify(request)));
      assert.deepEqual(requestOfAgent(input(), stateDir), request);
      writeFileSync(transcript("a2"), userLine([{ type: "text", text: JSON.stringify(request) }]));
      assert.deepEqual(requestOfAgent(input({ agent_id: "a2" }), stateDir), request);
    });

    it("takes a transcript path or an agent id as the third argument", () => {
      writeFileSync(transcript("other"), userLine(JSON.stringify(request)));
      assert.deepEqual(requestOfAgent(input(), stateDir, transcript("other")), request);
      assert.deepEqual(requestOfAgent(input(), stateDir, "other"), request);
      assert.equal(requestOfAgent(input(), stateDir, "missing"), null);
    });

    it("gives null for a launch without a request, an earlier block format and an unreadable transcript", () => {
      appendJsonl(statePath(input(), stateDir), { kind: "launch", toolUseId: "t1", agentType: "worker", writes: ["a.ts"] });
      appendJsonl(statePath(input(), stateDir), { kind: "bind", toolUseId: "t1", agentId: "a1" });
      writeFileSync(transcript("a1"), userLine(`\`\`\`plan-node\n${JSON.stringify(request)}\n\`\`\`\n본문`));
      assert.equal(requestOfAgent(input(), stateDir), null);
      assert.equal(requestOfAgent(input({ transcript_path: undefined }), stateDir), null);
      assert.equal(requestOfAgent(input({ agent_id: "none" }), stateDir), null);
    });

    it("prefers agent_transcript_path", () => {
      const elsewhere = join(stateDir, "elsewhere.jsonl");
      writeFileSync(elsewhere, userLine(JSON.stringify(request)));
      assert.deepEqual(requestOfAgent(input({ agent_transcript_path: elsewhere }), stateDir), request);
    });
  });
});
