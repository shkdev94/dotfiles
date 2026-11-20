// Delegation contract guard for the JSON requests defined in ~/.claude/agents/planner.md ('요청 형식' 절).
//   PreToolUse(Agent): deny a launch of planner, researcher, worker or reviewer whose prompt is not one valid
//     JSON request object (format check), a worker launch that is an explicit foreground launch
//     (`run_in_background: false`) or that comes from inside a subagent (launch rules), a node that already
//     failed MAX_FAILS times since its last pass (retry limit), or a worker whose `writes` overlap a worker
//     that is still running (write overlap). Add further launch checks to AGENT_CHECKS.
//   PreToolUse(Edit|Write|MultiEdit|NotebookEdit): deny a worker's edit outside the `writes` of its request.
//   PostToolUse(Agent) in the main conversation: hand the notices queued by the report gate to the main
//     conversation as additionalContext (once each; delegation-state.mjs takeNotices).
//   Recording events never block and never join anything; they only append facts to the per-session state
//     file of delegation-state.mjs:
//     PreToolUse(Agent)            -> launch { toolUseId, agentType, plan, id, verifies, writes, request, ... }
//                                     (worker and reviewer)
//     PostToolUse(Agent)           -> bind   { toolUseId, agentId, status }
//     PostToolUseFailure(Agent)    -> fail   { toolUseId }
//     SubagentStart (all four)     -> start  { agentId, agentType }   (also fires again when SendMessage resumes)
//   This hook is not registered for SubagentStop or SubagentHandback (settings.json), so it neither records nor
//   judges reports. report-gate.mjs writes the stop, delivered and verdict records of those events; the
//   checks here join all records when they run, so the order the events arrive in does not matter. The
//   notices of an invalid report reach the main conversation through this hook's PostToolUse(Agent) output
//   (above) and through the main Stop of check-on-stop.mjs.
//
// Which request an edit belongs to: the launch its agent_id was bound to (background workers have a bind before
// their first tool call), else the JSON request in the first user message of the subagent transcript (a worker
// resumed or started outside the guard). With neither, the edit passes: a worker without a request has no
// writes to enforce (a worker started with the earlier plan-node block format has only its launch record).
// Limits: edits made through Bash are not checked, and a worker resumed with SendMessage keeps the writes of
// its first launch (a new Agent launch is needed to change them).
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { AGENT_TYPES, readJsonDocument, validateRequest } from "./agent-contract.mjs";
import {
  launchOfAgent,
  readRecords,
  recordStart,
  requestOfAgent,
  resolveVerdicts,
  statePath,
  takeNotices,
} from "./delegation-state.mjs";
import { appendJsonl, findRepoRoot } from "./project-tools.mjs";
import { preToolUseOutput, runJsonHook } from "./run-hook.mjs";

const MAX_FAILS = 3;
const RUNNING_TTL_MS = 3 * 60 * 60 * 1000;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const LAUNCH_RECORDED = new Set(["worker", "reviewer"]);

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

// --- Retry limit --------------------------------------------------------------------------------

function nodeKey(plan, node) {
  return JSON.stringify([plan ?? "_", node]);
}

// The node a launch works on: a worker implements its own id, a reviewer checks `verifies`.
function targetNodeOf(subagentType, request) {
  if (subagentType === "worker") {
    return request.id;
  }
  return subagentType === "reviewer" ? request.verifies : null;
}

function failsSinceLastPass(records, key) {
  let fails = 0;
  for (const verdict of resolveVerdicts(records)) {
    if (nodeKey(verdict.plan, verdict.node) === key) {
      fails = verdict.verdict === "pass" ? 0 : fails + 1;
    }
  }
  return fails;
}

function checkRetryLimit(ctx) {
  const target = targetNodeOf(ctx.subagentType, ctx.request);
  if (target === null) {
    return [];
  }
  const fails = failsSinceLastPass(ctx.records, nodeKey(ctx.request.plan, target));
  return fails >= MAX_FAILS
    ? [
        `같은 노드(${target})가 ${MAX_FAILS}회 실패했다. 근거를 정리해 사용자에게 보고하고, 사용자가 재시도를 승인하면 새 노드 id로 계획을 갱신한다.`,
      ]
    : [];
}

// --- Write scopes -------------------------------------------------------------------------------

// The real path of `path`: symlinks in the nearest existing ancestor are resolved, so the repository path and
// a symlinked alias such as ~/.claude/hooks compare equal even when the file does not exist yet.
function canonicalPath(path) {
  const absolute = resolve(path);
  const tail = [];
  for (let head = absolute; ; ) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) {
        return absolute;
      }
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

// [{ path, dir }] with absolute paths. Relative `writes` entries are relative to the repository root; an
// entry ending in `/**` covers everything below its path.
function scopeOf(writes, root) {
  return writes.map((entry) => {
    const dir = entry.endsWith("/**");
    return { path: canonicalPath(resolve(root, dir ? entry.slice(0, -3) : entry)), dir };
  });
}

const isWithin = (child, parent) => child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

// Same path, or one is a directory scope that contains the other.
function entriesOverlap(left, right) {
  return (
    left.path === right.path || (left.dir && isWithin(right.path, left.path)) || (right.dir && isWithin(left.path, right.path))
  );
}

const showEntry = (entry) => (entry.dir ? `${entry.path}/**` : entry.path);

// The overlapping path of two scopes (the more specific one), or null.
function firstOverlap(left, right) {
  for (const a of left) {
    for (const b of right) {
      if (entriesOverlap(a, b)) {
        const inner = a.path.length >= b.path.length ? a : b;
        return showEntry(a.path === b.path ? { path: a.path, dir: a.dir || b.dir } : inner);
      }
    }
  }
  return null;
}

// `writes` entries of a worker request that name the repository root itself (its absolute path, with or without
// the `/**`). The format check rejects only the syntactic roots (`/`, `.`); this one needs the repository.
function rootWriteProblems(request, root) {
  if (!Array.isArray(request.writes)) {
    return [];
  }
  const rootPath = canonicalPath(root);
  return request.writes
    .filter((entry) => typeof entry === "string" && canonicalPath(resolve(root, entry.endsWith("/**") ? entry.slice(0, -3) : entry)) === rootPath)
    .map((entry) => `writes 항목 ${JSON.stringify(entry)}: 루트 전체(저장소 루트 자체)`);
}

// --- Write overlap ------------------------------------------------------------------------------

// Which workers are running (write overlap): a worker launch that has not completed and is newer than
// RUNNING_TTL_MS. A launch is complete when
// - a fail record names its toolUseId (the Agent call failed), or
// - it is bound to an agent whose latest completion is later than the agent's latest start. Completions are
//   the agent's stop records and its completed bind (status other than "async_launched"). Worker
//   launches normally run in the background, so the bind arrives at once with "async_launched" and the
//   worker's SubagentStop marks the end. The launch rules deny only an explicit run_in_background: false;
//   a launch without the key may run in the foreground, and its bind then carries a completed status.
//   That completed bind is a real completion path, not a defence. A start after the completion
//   (SendMessage resumed the worker) makes it running again until the next stop. Equal timestamps count as
//   completed: the guard errs toward not blocking, and the same-ms case that really happens (a first start
//   and its async bind) is harmless because an async bind is not a completion.
// If the bind never arrives (the background launch started but Claude Code fired no PostToolUse), the launch
// stays running until the TTL: only a failed Agent call (PostToolUseFailure -> fail record) completes it
// earlier. The TTL, counted from the later of the launch and the latest start, is also the safety net for a
// worker that dies without a SubagentStop.
const timeOf = (record) => (typeof record.ts === "number" ? record.ts : null);

function runningWorkers(records, now) {
  const failed = new Set();
  const bindByLaunch = new Map();
  const lastDone = new Map();
  const lastStart = new Map();
  const raise = (map, key, value) => {
    if (value !== null && value > (map.get(key) ?? -Infinity)) {
      map.set(key, value);
    }
  };

  for (const record of records) {
    if (record.kind === "fail") {
      failed.add(record.toolUseId);
    } else if (record.kind === "bind") {
      bindByLaunch.set(record.toolUseId, record);
      if (typeof record.status === "string" && record.status !== "async_launched") {
        raise(lastDone, record.agentId, timeOf(record) ?? 0);
      }
    } else if (record.kind === "stop") {
      raise(lastDone, record.agentId, timeOf(record) ?? 0);
    } else if (record.kind === "start") {
      raise(lastStart, record.agentId, timeOf(record));
    }
  }

  return records.filter((launch) => {
    if (launch.kind !== "launch" || launch.agentType !== "worker" || failed.has(launch.toolUseId)) {
      return false;
    }
    const launchedAt = timeOf(launch);
    let activeSince = launchedAt;
    const bind = bindByLaunch.get(launch.toolUseId);
    if (bind !== undefined) {
      const done = lastDone.get(bind.agentId);
      const start = lastStart.get(bind.agentId);
      if (done !== undefined && !(start !== undefined && start > done)) {
        return false;
      }
      if (start !== undefined && (activeSince === null || start > activeSince)) {
        activeSince = start;
      }
    }
    return !(activeSince !== null && now - activeSince > RUNNING_TTL_MS);
  });
}

const labelOf = (plan, id) => `${plan ?? "(plan 없음)"}/${id}`;

const OVERLAP_HINT = "앞 노드가 끝나면 풀린다. 종료 기록 없이 사라진 worker는 3시간 뒤 만료된다.";

function checkWriteOverlap(ctx) {
  if (ctx.subagentType !== "worker") {
    return [];
  }
  const root = findRepoRoot(ctx.input.cwd ?? process.cwd());
  const mine = scopeOf(ctx.request.writes, root);
  const reasons = [];
  for (const running of runningWorkers(ctx.records, ctx.now)) {
    const label = labelOf(running.plan, running.id);
    if (running.plan === ctx.request.plan && running.id === ctx.request.id) {
      reasons.push(`노드 ${label}가 이미 실행 중이다. 끝난 뒤에 다시 위임한다.`);
    } else if (running.exclusive === true || ctx.request.exclusive === true) {
      reasons.push(
        `exclusive 노드는 다른 worker와 동시에 실행할 수 없다 (실행 중: ${label}). 그 노드가 끝난 뒤 위임하거나 계획에서 dependsOn으로 직렬화한다.`,
      );
    } else {
      const overlap = firstOverlap(mine, scopeOf(running.writes ?? [], running.root ?? root));
      if (overlap !== null) {
        reasons.push(
          `writes가 실행 중인 노드 ${label}와 겹친다 (${overlap}). 그 노드가 끝난 뒤 위임하거나 계획에서 dependsOn으로 직렬화한다.`,
        );
      }
    }
  }
  if (reasons.length > 0) {
    ctx.hints.push(OVERLAP_HINT);
  }
  return reasons;
}

// Each check gets { input, subagentType, request, records, now, hints } and returns a list of reasons; it may
// push extra lines for the end of the deny message to `hints`. `request` is the validated request object;
// the checks only run when the format is valid.
const AGENT_CHECKS = [checkRetryLimit, checkWriteOverlap];

// --- Launch -------------------------------------------------------------------------------------

function denyOutput(reasons, withContractHint, hints = []) {
  const hint = withContractHint ? "\n형식 정의: ~/.claude/agents/planner.md의 '요청 형식' 절" : "";
  const lines = reasons.length === 1 ? reasons[0] : reasons.map((reason) => `- ${reason}`).join("\n");
  const head = reasons.length === 1 ? "" : "위임을 거부한다:\n";
  const tail = hints.map((line) => `\n${line}`).join("");
  return preToolUseOutput({ decision: "deny", reason: `${head}${lines}${tail}${hint}` });
}

// Rules on how a worker may be launched, independent of its request. Only an explicit foreground launch
// is denied: the desktop app's Agent tool has no `run_in_background` key and runs every launch in the
// background. Where a missing key does mean a foreground run, an interrupted launch is released only by TTL.
function launchRuleProblems(input, subagentType) {
  if (subagentType !== "worker") {
    return [];
  }
  const problems = [];
  const background = input.tool_input?.run_in_background;
  if (background === false || background === "false") {
    problems.push("worker를 포그라운드로 위임하지 않는다(`run_in_background: false` 금지). 병렬 충돌 검사가 백그라운드의 종료 기록에 의존한다.");
  }
  if (input.agent_id !== undefined && input.agent_id !== null) {
    problems.push("서브에이전트는 worker를 하위 위임하지 않는다. 일을 더 나눠야 하면 보고에 적어 메인이 계획에 반영하게 한다.");
  }
  return problems;
}

function guardAgentLaunch(input, stateDir, now) {
  const toolInput = input.tool_input ?? {};
  const subagentType = toolInput.subagent_type;
  if (!AGENT_TYPES.includes(subagentType)) {
    return null;
  }

  const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt : "";
  const { value: request, problems: documentProblems } = readJsonDocument(prompt, { subject: "요청" });
  const formatProblems = request === null ? documentProblems : validateRequest(request, subagentType);
  if (formatProblems.length === 0 && subagentType === "worker") {
    formatProblems.push(...rootWriteProblems(request, findRepoRoot(input.cwd ?? process.cwd())));
  }
  const ruleProblems = launchRuleProblems(input, subagentType);
  if (formatProblems.length > 0 || ruleProblems.length > 0) {
    return denyOutput([...formatProblems, ...ruleProblems], formatProblems.length > 0);
  }

  const path = statePath(input, stateDir);
  const ctx = { input, subagentType, request, records: readRecords(input, stateDir), now, hints: [] };
  const reasons = AGENT_CHECKS.flatMap((check) => check(ctx));
  if (reasons.length > 0) {
    return denyOutput(reasons, false, ctx.hints);
  }

  if (LAUNCH_RECORDED.has(subagentType)) {
    try {
      appendJsonl(path, {
        kind: "launch",
        ts: now,
        toolUseId: input.tool_use_id ?? randomUUID(),
        agentType: subagentType,
        plan: request.plan,
        id: request.id,
        verifies: request.verifies ?? null,
        writes: request.writes,
        exclusive: request.exclusive === true,
        root: findRepoRoot(input.cwd ?? process.cwd()),
        request,
      });
    } catch {
      // Recording is best-effort; never block a valid launch on it.
    }
  }
  return null;
}

// --- Recording ----------------------------------------------------------------------------------

// PostToolUse(Agent) tells which agent a launch became (both foreground and background launches).
function recordBind(input, stateDir, now) {
  const agentId = input.tool_response?.agentId ?? input.tool_input?.agentId;
  if (typeof input.tool_use_id !== "string" || typeof agentId !== "string") {
    return;
  }
  if (!LAUNCH_RECORDED.has(input.tool_input?.subagent_type)) {
    return;
  }
  appendJsonl(statePath(input, stateDir), {
    kind: "bind",
    ts: now,
    toolUseId: input.tool_use_id,
    agentId,
    status: input.tool_response?.status ?? null,
  });
}

// An Agent call failed (an error the tool reported; Claude Code fires no hook for an abort).
function recordFailure(input, stateDir) {
  if (typeof input.tool_use_id !== "string") {
    return;
  }
  appendJsonl(statePath(input, stateDir), { kind: "fail", toolUseId: input.tool_use_id });
}

// --- Worker edits -------------------------------------------------------------------------------

// { plan, id, writes, exclusive, root } for the worker that made this call, or null (see the header).
function nodeOfWorker(input, records, stateDir, fallbackRoot) {
  const launch = launchOfAgent(records, input.agent_id);
  const node = launch?.agentType === "worker" ? launch : requestOfAgent(input, stateDir);
  if (node === null || node === undefined || !isStringArray(node.writes)) {
    return null;
  }
  return { plan: node.plan ?? null, id: node.id, writes: node.writes, exclusive: node.exclusive === true, root: launch?.root ?? fallbackRoot };
}

function guardWorkerEdit(input, stateDir) {
  const toolInput = input.tool_input ?? {};
  const target = toolInput.file_path ?? toolInput.notebook_path;
  if (input.agent_type !== "worker" || typeof input.agent_id !== "string" || !isNonEmptyString(target)) {
    return null;
  }

  const cwd = input.cwd ?? process.cwd();
  const file = canonicalPath(resolve(cwd, target));
  // The scratchpad is where every agent is told to put temporary files.
  if (isNonEmptyString(input.scratchpad_dir) && isWithin(file, canonicalPath(input.scratchpad_dir))) {
    return null;
  }

  const records = readRecords(input, stateDir);
  const node = nodeOfWorker(input, records, stateDir, findRepoRoot(cwd));
  if (node === null) {
    return null;
  }
  if (node.exclusive && node.writes.length === 0) {
    return preToolUseOutput({
      decision: "deny",
      reason: `노드 ${node.id}는 exclusive이고 writes가 []라 소스 파일을 수정할 수 없다 (${file}). 수정하지 말고 보고에 적어 메인이 판단하게 한다.`,
    });
  }
  const entry = { path: file, dir: false };
  if (scopeOf(node.writes, node.root).some((allowed) => entriesOverlap(allowed, entry))) {
    return null;
  }
  return preToolUseOutput({
    decision: "deny",
    reason: `노드 ${node.id}의 writes 밖이다 (${file}). 수정하지 말고 보고에 적어 메인이 판단하게 한다. writes: ${JSON.stringify(node.writes)}`,
  });
}

// --- Notices ------------------------------------------------------------------------------------

// The additionalContext output for the notices the main conversation has not seen, or null.
function noticeOutput(input, stateDir) {
  const notices = takeNotices(input, stateDir);
  return notices.length === 0
    ? null
    : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notices.join("\n") } };
}

// --- Entry --------------------------------------------------------------------------------------

// PreToolUse(Agent, Edit, Write, MultiEdit, NotebookEdit): a deny output or null. PostToolUse(Agent) in the main
// conversation: an additionalContext output when notices are waiting, else null. Other recording events: null.
// `now` is injectable for tests.
export function evaluate(input, { stateDir, now = Date.now() } = {}) {
  const event = input.hook_event_name;

  if (event === "PreToolUse" && input.tool_name === "Agent") {
    return guardAgentLaunch(input, stateDir, now);
  }
  if (event === "PreToolUse" && EDIT_TOOLS.has(input.tool_name)) {
    return guardWorkerEdit(input, stateDir);
  }

  try {
    if (event === "PostToolUse" && input.tool_name === "Agent") {
      recordBind(input, stateDir, now);
      // A subagent's own Agent call must not consume what is meant for the main conversation.
      if (input.agent_id === undefined || input.agent_id === null) {
        return noticeOutput(input, stateDir);
      }
    } else if (event === "PostToolUseFailure" && input.tool_name === "Agent") {
      recordFailure(input, stateDir);
    } else if (event === "SubagentStart") {
      recordStart(input, stateDir, now);
    }
  } catch {
    // Recording must never fail the hook.
  }
  return null;
}

runJsonHook(evaluate, import.meta.url);
