// The one hook for the moment a subagent reports: PreToolUse(SubagentHandback), PostToolUse(SubagentHandback)
// and SubagentStop. For planner, researcher, worker and reviewer it enforces, in this order:
//   1. the report is one valid JSON result (agent-contract.mjs readJsonDocument + validateResult, checked against
//      the request the agent was started with when that is known);
//   2. only when the format is valid, the checks of the files the agent edited (check-on-stop.mjs runEditChecks:
//      format, lint, typecheck, related tests);
//   3. when both pass, the report is allowed.
// A report that fails either step is refused: a deny on SubagentHandback (the report is not sent and the agent
// is asked to call SubagentHandback again) or a block on SubagentStop (the agent continues). The refusals are
// counted per agent (delegation-state.mjs nextAttempt) and the limit is MAX_REPORT_REJECTS; the n-th refusal
// tells the agent how many chances are left (rejectNotice).
// Past the limit
//   - SubagentHandback: the original text and the reasons are archived and queued as a notice for the main
//     conversation, a reviewer counts as fail, and every further attempt is denied with "stop" as the reason;
//   - SubagentStop: the same, but the stop is not blocked (the report would be lost, and Claude Code limits how
//     often a stop can be continued), so the report reaches the main conversation as it is, without any mark:
//     a SubagentStop hook cannot change what is delivered. That the report is invalid reaches the main
//     conversation only through the queued notice.
// Claude Code does not offer SubagentHandback in every permission mode; where it is not used, SubagentStop's
// last_assistant_message is the report. An agent that went through SubagentHandback (a refused attempt or a
// delivered report since its last start) is not checked again at its SubagentStop: only the end is recorded.
// PostToolUse(SubagentHandback) records the delivery and a reviewer's verdict. SubagentStop records a worker's
// stop and, for a reviewer, the verdict of a report that passed. A reviewer that ends at SubagentStop without
// a delivered report or a verdict since its last start (no text, or a refused handback that was never fixed)
// counts as fail. This hook is the only path that writes the SubagentHandback (Pre and Post) and SubagentStop
// records (settings.json registers it for all three events).
// Other agents (anything but the four) and the main conversation keep the checks of check-on-stop.mjs without
// the format step: same output, kind limits per agent as there.
import { readJsonDocument, validateResult } from "./agent-contract.mjs";
import { noticeSection, outputOf, runEditChecks } from "./check-on-stop.mjs";
import {
  archiveInvalidReport,
  isAgentType,
  judgeReviewerReport,
  MAX_REPORT_REJECTS,
  nextAttempt,
  readRecords,
  recordDelivered,
  recordReject,
  recordStop,
  recordVerdict,
  rejectNotice,
  requestOfAgent,
} from "./delegation-state.mjs";
import { preToolUseOutput, runJsonHook } from "./run-hook.mjs";

const HANDBACK_TOOL = "SubagentHandback";

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

// Where the format of a report is defined, per agent type.
function definitionHint(type) {
  const section = type === "planner" ? "출력 형식" : "보고 방식";
  return `형식 정의: ~/.claude/agents/${type}.md의 ${section} 절`;
}

function formatReason(problems, type) {
  return ["보고 형식이 맞지 않는다.", ...problems.map((problem) => `- ${problem}`), definitionHint(type)].join("\n");
}

// A SubagentHandback attempt (refused or delivered) since the agent's last start: its report went (or was
// to go) through SubagentHandback, so its SubagentStop has nothing left to check.
function hasHandbackTrace(records, agentId) {
  const own = records.filter((record) => record.agentId === agentId);
  const lastStart = own.findLastIndex((record) => record.kind === "start");
  return own
    .slice(lastStart + 1)
    .some((record) => record.kind === "delivered" || (record.kind === "reject" && record.source === "handback"));
}

// Whether the agent has a delivered report or a verdict since its last start. A reviewer that ends without
// either has no verdict, which would drop it from the fail count of delegation-guard.mjs.
function hasReportSince(records, agentId) {
  const own = records.filter((record) => record.agentId === agentId);
  const lastStart = own.findLastIndex((record) => record.kind === "start");
  return own.slice(lastStart + 1).some((record) => record.kind === "delivered" || record.kind === "verdict");
}

// The first line of each check section, as the reasons kept with an archived report.
const headOf = (section) => section.split("\n", 1)[0];

// What was wrong with a report that is checked now: { reason, reasons } or null when it passes.
// `reason` is the text for the agent, `reasons` the short list kept with an archived report.
async function findProblems(input, { type, text, request, handback }, { stateDir, env, timeouts }) {
  const { value, problems } = readJsonDocument(text, { subject: "응답" });
  const formatProblems = value === null ? problems : validateResult(value, type, { request });
  if (formatProblems.length > 0) {
    return { reason: formatReason(formatProblems, type), reasons: formatProblems, value };
  }

  const checks = await runEditChecks(input, { stateDir, env, timeouts, kindLimits: false, beforeHandback: handback });
  const sections = [...checks.problemSections];
  if (checks.noticeLines.length > 0) {
    sections.push(noticeSection(checks.noticeLines));
  }
  if (sections.length === 0) {
    return null;
  }
  const reasons = [
    ...checks.problemSections.map(headOf),
    ...checks.noticeLines.map((line) => line.replace(/^- /, "")),
  ];
  const all = checks.formatSection === null ? sections : [checks.formatSection, ...sections];
  return { reason: all.join("\n\n"), reasons, value };
}

// A reviewer's report counts as fail: the node comes from the report or the request.
function recordFailedVerdict(input, text, request, source, stateDir) {
  if (input.agent_type !== "reviewer") {
    return;
  }
  const { node } = judgeReviewerReport(text, request);
  recordVerdict(input, { node, verdict: "fail", source }, stateDir);
}

// An agent ends at SubagentStop without a report to check (no text, a handback trace) or the gate failed.
// - worker: the stop record is enough (delegation-guard.mjs runningWorkers reads only stop records).
// - reviewer: without a delivered report or verdict since its last start it counts as fail. source is "stop"
//   on purpose: SubagentStop can arrive before PostToolUse(SubagentHandback), and a handback verdict outranks
//   a stop verdict (delegation-state.mjs resolveVerdicts), so a pass that is recorded later is not overridden.
// - planner, researcher: there is nothing to record. A report that was not delivered through SubagentHandback
//   is announced to the main conversation by Claude Code itself (claude/CLAUDE.md, "보고 미전달").
// Recording never throws: a failure here must not keep the stop from being recorded or fail the hook.
function recordEnd(input, stateDir, text) {
  try {
    if (input.agent_type === "reviewer" && !hasReportSince(readRecords(input, stateDir), input.agent_id)) {
      let request = null;
      try {
        request = requestOfAgent(input, stateDir);
      } catch {
        // The node of the verdict then comes from the report only.
      }
      recordFailedVerdict(input, typeof text === "string" ? text : "", request, "stop", stateDir);
    }
  } catch {
    // See above.
  }
  try {
    recordStop(input, stateDir);
  } catch {
    // See above.
  }
}

// PreToolUse(SubagentHandback) or SubagentStop of planner, researcher, worker or reviewer.
async function gateReport(input, options) {
  const { stateDir, checkReport } = options;
  const handback = input.hook_event_name === "PreToolUse";
  const source = handback ? "handback" : "stop";
  const type = input.agent_type;
  const text = handback ? input.tool_input?.message : input.last_assistant_message;
  const records = readRecords(input, stateDir);

  if (!handback && (typeof text !== "string" || hasHandbackTrace(records, input.agent_id))) {
    recordEnd(input, stateDir, text);
    return null;
  }

  const n = nextAttempt(records, input.agent_id);
  const request = requestOfAgent(input, stateDir);
  const found = await checkReport(input, { type, text, request, handback }, options);

  if (found === null) {
    if (!handback) {
      if (type === "reviewer") {
        const { node, verdict } = judgeReviewerReport(text, request);
        recordVerdict(input, { node, verdict, source }, stateDir);
      }
      recordStop(input, stateDir);
    }
    return null;
  }

  if (n <= MAX_REPORT_REJECTS) {
    recordReject(input, { source, n, toolUseId: input.tool_use_id }, stateDir);
    const reason = `${found.reason}\n\n${rejectNotice(n, source)}\n${
      handback ? "고친 뒤 SubagentHandback을 다시 호출하라" : "고친 뒤 다시 보고하라"
    }`;
    return handback ? preToolUseOutput({ decision: "deny", reason }) : { decision: "block", reason };
  }

  // Past the limit: keep the original for the main conversation and stop asking.
  const value = found.value;
  archiveInvalidReport({
    input,
    stateDir,
    agentType: type,
    plan: request?.plan ?? (typeof value?.plan === "string" ? value.plan : null),
    id: isNonEmptyString(request?.id) ? request.id : isNonEmptyString(value?.id) ? value.id : null,
    source,
    reasons: found.reasons,
    raw: typeof text === "string" ? text : "",
    n,
    delivered: !handback,
  });
  recordFailedVerdict(input, text, request, source, stateDir);
  if (handback) {
    recordReject(input, { source, n, toolUseId: input.tool_use_id }, stateDir);
    return preToolUseOutput({
      decision: "deny",
      reason:
        "반려 한도를 넘었다. 보고는 전달되지 않고 원문과 사유는 메인에 따로 전달된다. 더 고치거나 다시 제출하지 말고 종료하라",
    });
  }
  recordStop(input, stateDir);
  return null;
}

// PostToolUse(SubagentHandback): the report reached the main conversation.
function recordHandback(input, stateDir) {
  recordDelivered(input, stateDir);
  if (input.agent_type === "reviewer") {
    const { node, verdict } = judgeReviewerReport(input.tool_input?.message, requestOfAgent(input, stateDir));
    recordVerdict(input, { node, verdict, source: "handback" }, stateDir);
  }
}

// Output for the event, or null. `env`, `timeouts` and `checkReport` exist for tests.
export async function evaluate(input, { stateDir, env = process.env, timeouts = {}, checkReport = findProblems } = {}) {
  const event = input.hook_event_name;
  const options = { stateDir, env, timeouts, checkReport };

  if (event === "PostToolUse" && input.tool_name === HANDBACK_TOOL) {
    try {
      recordHandback(input, stateDir);
    } catch {
      // Recording must never fail the hook.
    }
    return null;
  }

  const handback = event === "PreToolUse" && input.tool_name === HANDBACK_TOOL;
  if (!handback && event !== "SubagentStop") {
    return null;
  }
  if (isAgentType(input.agent_type)) {
    if (handback) {
      return gateReport(input, options);
    }
    // Fail open at SubagentStop: an exception must not leave the end of the agent unrecorded (a worker would
    // stay "running" until RUNNING_TTL_MS). A block path keeps the agent running, so it records nothing.
    try {
      return await gateReport(input, options);
    } catch {
      recordEnd(input, stateDir, input.last_assistant_message);
      return null;
    }
  }
  return outputOf(input, await runEditChecks(input, { ...options, kindLimits: true, beforeHandback: handback }));
}

runJsonHook((input) => evaluate(input), import.meta.url);
