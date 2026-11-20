// State shared by the delegation hooks (delegation-guard.mjs and, for report enforcement, report-gate.mjs).
// Everything lives in one append-only file per session, <stateDir>/<session_id>/delegation.jsonl: main
// conversation and subagents share one session_id, hooks run in separate processes, and appending one short
// line is atomic enough that no hook ever read-modify-writes. Readers join the facts when they run, so the
// order in which events arrive does not matter.
//
// Records (`kind`), oldest first in the file:
//   launch   { toolUseId, agentType, plan, id, verifies, writes, exclusive, root, request }   PreToolUse(Agent)
//   bind     { toolUseId, agentId, status }                  PostToolUse(Agent): which agent a launch became
//   fail     { toolUseId }                                   PostToolUseFailure(Agent)
//   start    { agentId, agentType }                          SubagentStart (again when SendMessage resumes)
//   stop     { agentId }                                     SubagentStop (worker)
//   verdict  { agentId, node, verdict, source }              reviewer report; source "handback" | "stop"
//   reject   { agentId, attemptId, toolUseId, source, n }    a report refused by the report gate
//   delivered{ agentId }                                     a report that reached the main conversation
//   invalid  { agentId, agentType, plan, id, source, reasons, rawPath, rawLength, delivered }
//   notice   { noticeId, agentId, text } / noticeTaken { noticeId }   text for the main conversation
// Records written before the report gate have no `source` on verdicts and no `request` on launches; they are
// still read (a verdict without a source ranks like a stop verdict).
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_TYPES, readJsonDocument, requestFromTranscriptContent, validateResult } from "./agent-contract.mjs";
import { agentKeyOf, appendJsonl, defaultStateDir, readJsonl, sessionStatePath } from "./project-tools.mjs";

export const STATE_FILE = "delegation.jsonl";
export const MAX_REPORT_REJECTS = 3;
export const NOTICE_RAW_LIMIT = 2000;
const TRANSCRIPT_FIRST_LINE_LIMIT = 4 * 1024 * 1024;

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

export const isAgentType = (value) => AGENT_TYPES.includes(value);

export function statePath(input, stateDir) {
  return sessionStatePath(input, STATE_FILE, stateDir);
}

export function readRecords(input, stateDir) {
  return readJsonl(statePath(input, stateDir));
}

// --- Recording ----------------------------------------------------------------------------------

// A subagent started, or started again after SendMessage resumed it (same agent_id). All four types.
export function recordStart(input, stateDir, now = Date.now()) {
  if (!isAgentType(input.agent_type) || typeof input.agent_id !== "string") {
    return;
  }
  appendJsonl(statePath(input, stateDir), { kind: "start", ts: now, agentId: input.agent_id, agentType: input.agent_type });
}

// A worker stopped, with or without a final message. Reviewers need no stop record: only workers are "running".
export function recordStop(input, stateDir, now = Date.now()) {
  if (input.agent_type !== "worker" || typeof input.agent_id !== "string") {
    return;
  }
  appendJsonl(statePath(input, stateDir), { kind: "stop", ts: now, agentId: input.agent_id });
}

// `verdict` is { node, verdict, source } for the reviewer that made this call.
export function recordVerdict(input, { node, verdict, source }, stateDir, now = Date.now()) {
  if (input.agent_type !== "reviewer" || typeof input.agent_id !== "string") {
    return;
  }
  appendJsonl(statePath(input, stateDir), { kind: "verdict", ts: now, agentId: input.agent_id, node: node ?? null, verdict, source });
}

// A report of this agent reached the main conversation: the reject count starts over.
export function recordDelivered(input, stateDir, now = Date.now()) {
  if (!isAgentType(input.agent_type) || typeof input.agent_id !== "string") {
    return;
  }
  appendJsonl(statePath(input, stateDir), { kind: "delivered", ts: now, agentId: input.agent_id });
}

// Returns the attempt id. `n` comes from nextAttempt.
export function recordReject(input, { source, n, toolUseId = null }, stateDir, now = Date.now()) {
  const attemptId = randomUUID();
  appendJsonl(statePath(input, stateDir), {
    kind: "reject",
    ts: now,
    agentId: input.agent_id,
    attemptId,
    toolUseId: toolUseId ?? null,
    source,
    n,
  });
  return attemptId;
}

// --- Report rejects -----------------------------------------------------------------------------

// The number of the next attempt of `agentId`: rejects since its last start or delivered report, plus one.
// `recordsOrInput` is the record list, or the hook input to read it from (with `stateDir`).
export function nextAttempt(recordsOrInput, agentId, stateDir) {
  const records = Array.isArray(recordsOrInput) ? recordsOrInput : readRecords(recordsOrInput, stateDir);
  let rejects = 0;
  for (const record of records) {
    if (record.agentId !== agentId) {
      continue;
    }
    if (record.kind === "start" || record.kind === "delivered") {
      rejects = 0;
    } else if (record.kind === "reject") {
      rejects += 1;
    }
  }
  return rejects + 1;
}

// What the agent is told when its n-th attempt is refused (n <= MAX_REPORT_REJECTS).
export function rejectNotice(n, source) {
  const outcome =
    source === "handback"
      ? "보고는 전달되지 않고, 원문과 사유가 메인에 따로 전달된다."
      : "보고는 그대로 전달되지만 무효로 처리되고, 원문과 사유가 메인에 따로 전달된다.";
  return `보고 반려 ${n}/${MAX_REPORT_REJECTS}회. 남은 제출 기회 ${MAX_REPORT_REJECTS + 1 - n}회. 마지막 제출도 반려되면 ${outcome}`;
}

function noticeText({ agentType, plan, id, agentId, delivered, reasons, raw, rawLength, rawPath }) {
  const label = `${plan ?? "(plan 없음)"}/${id ?? "?"}`;
  const original =
    rawLength === 0
      ? "(비어 있음)"
      : rawLength <= NOTICE_RAW_LIMIT
        ? raw
        : `${rawLength}자라 ${rawPath}에 저장했다. researcher로 읽는다`;
  const tail = agentType === "reviewer" ? " fail로 집계했다." : "";
  return `[report-gate] ${agentType} ${label} (agent ${agentId}) 보고가 반려 한도를 넘어 ${delivered ? "무효로 전달" : "미전달"}됐다. 사유: ${reasons.join("; ")}. 원문: ${original}.${tail}`;
}

// A report that was refused past the limit: keep its text (<stateDir>/<session>/reports/<agent>-<n>.txt, mode
// 0o600; every attempt over the limit has its own n) and queue a notice for the main conversation.
// Returns { rawPath, noticeId, text }.
export function archiveInvalidReport({ input, stateDir, agentType, plan, id, source, reasons, raw, n, delivered, now = Date.now() }) {
  const agentId = input.agent_id ?? null;
  const rawText = typeof raw === "string" ? raw : "";
  const dir = sessionStatePath(input, "reports", stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rawPath = join(dir, `${agentKeyOf(input)}-${n}.txt`);
  writeFileSync(rawPath, rawText, { mode: 0o600 });
  chmodSync(rawPath, 0o600);

  const path = statePath(input, stateDir);
  appendJsonl(path, {
    kind: "invalid",
    ts: now,
    agentId,
    agentType,
    plan: plan ?? null,
    id: id ?? null,
    source,
    reasons,
    rawPath,
    rawLength: rawText.length,
    delivered: delivered === true,
  });
  const noticeId = randomUUID();
  const text = noticeText({ agentType, plan, id, agentId, delivered: delivered === true, reasons, raw: rawText, rawLength: rawText.length, rawPath });
  appendJsonl(path, { kind: "notice", ts: now, noticeId, agentId, text });
  return { rawPath, noticeId, text };
}

// The notices the main conversation has not seen yet, as a list of texts. Of several notices for one agent
// (every attempt over the limit makes one) only the latest is returned; the older ones are marked taken too.
export function takeNotices(input, stateDir) {
  const path = statePath(input, stateDir);
  const records = readJsonl(path);
  const taken = new Set(records.filter((record) => record.kind === "noticeTaken").map((record) => record.noticeId));
  const pending = records.filter((record) => record.kind === "notice" && !taken.has(record.noticeId));
  if (pending.length === 0) {
    return [];
  }
  const latestByAgent = new Map();
  for (const notice of pending) {
    latestByAgent.set(notice.agentId, notice);
  }
  for (const notice of pending) {
    appendJsonl(path, { kind: "noticeTaken", noticeId: notice.noticeId });
  }
  return [...latestByAgent.values()].map((notice) => notice.text);
}

// --- Verdicts -----------------------------------------------------------------------------------

// A reviewer's report text -> { node, verdict }. A report that is not valid counts as fail: the verdict is the
// reported one only when the whole report passes validateResult (with the request, when known).
export function judgeReviewerReport(text, request = null) {
  const { value, problems } = readJsonDocument(text, { subject: "응답" });
  const fallbackNode = isNonEmptyString(request?.verifies) ? request.verifies : null;
  if (value === null || problems.length > 0) {
    return { node: fallbackNode, verdict: "fail" };
  }
  const node = isNonEmptyString(value.verifies) ? value.verifies : fallbackNode;
  const invalid = validateResult(value, "reviewer", { request }).length > 0;
  return { node, verdict: !invalid && value.verdict === "pass" ? "pass" : "fail" };
}

const verdictRank = (record) => (record.source === "handback" ? 1 : 0);

// Joins the recorded facts into [{ plan, node, verdict }] in the order the verdicts were reported.
// - A reviewer agent counts once: its best verdict record wins. A handback verdict outranks a stop (or
//   source-less) one whatever order they arrived in; among equals the latest wins.
// - A verdict is attributed to the launch its agent was bound to (PostToolUse(Agent)), whatever its text says.
// - Without a bind it falls back to the latest reviewer launch that verifies the node named on the verdict
//   and is not bound to another agent. With no node either, it cannot be attributed and is ignored.
export function resolveVerdicts(records) {
  const launches = new Map();
  const boundLaunchByAgent = new Map();
  const bestVerdictByAgent = new Map();

  records.forEach((record, index) => {
    if (record.kind === "launch" && record.agentType === "reviewer") {
      launches.set(record.toolUseId, record);
    } else if (record.kind === "bind") {
      boundLaunchByAgent.set(record.agentId, record.toolUseId);
    } else if (record.kind === "verdict") {
      const current = bestVerdictByAgent.get(record.agentId);
      if (current === undefined || verdictRank(record) >= verdictRank(current.record)) {
        bestVerdictByAgent.set(record.agentId, { index, record });
      }
    }
  });

  // A launch bound to some agent belongs to that agent, so it cannot be the fallback for another one.
  const boundLaunchIds = new Set(boundLaunchByAgent.values());
  const unboundReviewerLaunches = [...launches.values()].filter((launch) => !boundLaunchIds.has(launch.toolUseId));
  const resolved = [];
  for (const { index, record } of bestVerdictByAgent.values()) {
    const bound = launches.get(boundLaunchByAgent.get(record.agentId));
    const launch =
      bound ??
      (record.node === null ? undefined : unboundReviewerLaunches.findLast((candidate) => candidate.verifies === record.node));
    if (launch !== undefined) {
      resolved.push({ index, plan: launch.plan, node: launch.verifies, verdict: record.verdict });
    }
  }
  return resolved.sort((left, right) => left.index - right.index);
}

// --- Requests -----------------------------------------------------------------------------------

// First line of a file, read in chunks so a long transcript is not loaded whole. null if unreadable.
function readFirstLine(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (total < TRANSCRIPT_FIRST_LINE_LIMIT) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) {
        break;
      }
      const newline = buffer.subarray(0, count).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, newline === -1 ? count : newline)));
      total += count;
      if (newline !== -1) {
        break;
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

export function agentTranscriptPath(input, agentId = input.agent_id) {
  if (isNonEmptyString(input.agent_transcript_path)) {
    return input.agent_transcript_path;
  }
  if (!isNonEmptyString(input.transcript_path) || !isNonEmptyString(input.session_id) || !isNonEmptyString(agentId)) {
    return null;
  }
  return join(dirname(input.transcript_path), input.session_id, "subagents", `agent-${agentId}.jsonl`);
}

// The request object in the first user message of the transcript at `path`, or null. A prompt that is not one
// JSON object (including the earlier plan-node block format) gives null.
export function requestFromTranscript(path) {
  const line = path === null ? null : readFirstLine(path);
  if (line === null) {
    return null;
  }
  let content;
  try {
    content = JSON.parse(line)?.message?.content;
  } catch {
    return null;
  }
  return requestFromTranscriptContent(content);
}

// The launch record this agent was bound to, or undefined.
export function launchOfAgent(records, agentId) {
  const bind = records.findLast((record) => record.kind === "bind" && record.agentId === agentId);
  return bind === undefined ? undefined : records.findLast((record) => record.kind === "launch" && record.toolUseId === bind.toolUseId);
}

// The request an agent was started with: the request stored on its bound launch first, else the first user
// message of its transcript. `agentOrTranscript` is an agent id (default input.agent_id; the transcript path
// is derived from the input) or a transcript path (contains "/"; the bound launch is looked up by
// input.agent_id). null when neither gives a request (an agent started with the earlier format, or unreadable).
export function requestOfAgent(input, stateDir, agentOrTranscript = input.agent_id) {
  const isPath = typeof agentOrTranscript === "string" && agentOrTranscript.includes("/");
  const agentId = isPath ? input.agent_id : agentOrTranscript;
  if (typeof agentId === "string") {
    const launch = launchOfAgent(readRecords(input, stateDir), agentId);
    if (launch?.request !== undefined && launch.request !== null && typeof launch.request === "object") {
      return launch.request;
    }
  }
  return requestFromTranscript(isPath ? agentOrTranscript : agentTranscriptPath(input, agentId));
}
