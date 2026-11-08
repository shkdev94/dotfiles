// Delegation contract guard for the plan-node blocks defined in ~/.claude/agents/planner.md.
//   PreToolUse(Agent): deny a launch whose block is malformed (format check), a worker launch that is an
//     explicit foreground launch (`run_in_background: false`) or that comes from inside a subagent (launch rules), a
//     node that already failed MAX_FAILS times since its last pass (retry limit), or a worker whose `writes`
//     overlap a worker that is still running (write overlap). Add further launch checks to AGENT_CHECKS.
//   PreToolUse(Edit|Write|MultiEdit|NotebookEdit): deny a worker's edit outside the `writes` of its node.
//   Recording events never block and never join anything; they only append facts to one append-only file
//   per session (main conversation and subagents share one session_id):
//     PreToolUse(Agent)            -> launch { toolUseId, agentType, plan, id, verifies, writes, root, ... }
//     PostToolUse(Agent)           -> bind   { toolUseId, agentId, status }
//     PostToolUseFailure(Agent)    -> fail   { toolUseId }
//     SubagentStart (worker)       -> start  { agentId }   (also fires again when SendMessage resumes the worker)
//     SubagentStop (worker)        -> stop   { agentId }
//     PostToolUse(SubagentHandback)
//     SubagentStop (with message)  -> verdict{ agentId, node, verdict }
//   The checks join them when they run, so the order the events arrive in does not matter.
//
// Which node an edit belongs to: the launch its agent_id was bound to (background workers have a bind before
// their first tool call), else the plan-node block on the first line of the subagent transcript (a worker
// resumed or started outside the guard). With neither, the edit passes: a worker started without a node
// block has no writes to enforce. Limits: edits made through Bash are not checked, and a worker resumed with
// SendMessage keeps the writes of its first launch (a new Agent launch is needed to change them).
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { appendJsonl, findRepoRoot, readJsonl, sessionStatePath } from "./project-tools.mjs";
import { preToolUseOutput, runJsonHook } from "./run-hook.mjs";

const HANDBACK_TOOL = "SubagentHandback";
const STATE_FILE = "delegation.jsonl";
const FENCE_OPEN = "```plan-node";
const FENCE_CLOSE = "```";
const MAX_FAILS = 3;
const RUNNING_TTL_MS = 3 * 60 * 60 * 1000;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TRANSCRIPT_FIRST_LINE_LIMIT = 4 * 1024 * 1024;
const BLOCK_REQUIRED = new Set(["worker", "reviewer"]);
const BLOCK_OPTIONAL = new Set(["researcher"]);
const VERDICT_LINE = /^VERDICT (\S+): (pass|fail)$/;

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

// --- Format check -------------------------------------------------------------------------------

function writesPathProblem(path) {
  if (!isNonEmptyString(path)) {
    return "빈 문자열";
  }
  if (path.startsWith("./")) {
    return "`./`로 시작";
  }
  if (path.startsWith("~")) {
    return "`~`로 시작 (절대 경로나 저장소 기준 상대 경로를 쓴다)";
  }
  const base = path.endsWith("/**") ? path.slice(0, -3) : path;
  if (base === "") {
    return "루트 전체(`/**`)";
  }
  if (base.split("/").includes("..")) {
    return "`..` 세그먼트 포함";
  }
  if (/[*?[]/.test(base)) {
    return "와일드카드는 끝의 `/**`만 허용";
  }
  return null;
}

function validateNode(node, type) {
  const problems = [];
  const need = (condition, message) => {
    if (!condition) {
      problems.push(message);
    }
  };

  need(node.agent === type, `agent는 subagent_type(${type})과 같아야 한다 (현재 ${JSON.stringify(node.agent)})`);
  need(isNonEmptyString(node.id), "id는 비어 있지 않은 문자열이어야 한다");
  need("plan" in node && (node.plan === null || typeof node.plan === "string"), "plan은 string 또는 null이어야 한다 (생략 불가)");
  need(isStringArray(node.dependsOn), "dependsOn은 string[]이어야 한다 (없으면 [])");
  need(
    isStringArray(node.acceptanceCriteria) && node.acceptanceCriteria.length >= 1,
    "acceptanceCriteria는 1개 이상인 string[]이어야 한다",
  );

  if (type === "worker") {
    if (!isStringArray(node.writes)) {
      problems.push("writes는 string[]이어야 한다");
    } else if (node.writes.length === 0 && node.exclusive !== true) {
      problems.push("writes는 1개 이상이어야 한다 (`exclusive: true`일 때만 [] 허용)");
    }
  } else if (type === "reviewer") {
    need(Array.isArray(node.writes) && node.writes.length === 0, "reviewer의 writes는 []이어야 한다");
    need(isNonEmptyString(node.verifies), "reviewer는 verifies(검증 대상 노드 id 문자열)가 필요하다");
  } else {
    need(
      node.writes === undefined || (Array.isArray(node.writes) && node.writes.length === 0),
      "researcher의 writes는 생략하거나 []이어야 한다",
    );
  }

  if (isStringArray(node.writes)) {
    for (const path of node.writes) {
      const problem = writesPathProblem(path);
      if (problem !== null) {
        problems.push(`writes 항목 ${JSON.stringify(path)}: ${problem}`);
      }
    }
  }

  const inputsRequired = typeof node.plan === "string" && (type === "worker" || type === "reviewer");
  if (inputsRequired) {
    need(isStringArray(node.inputs) && node.inputs.length >= 1, "계획 노드(plan이 null이 아님)의 inputs는 1개 이상인 string[]이어야 한다");
  } else {
    need(node.inputs === undefined || isStringArray(node.inputs), "inputs는 string[]이어야 한다");
  }

  const { requirement } = node;
  need(
    requirement === undefined ||
      requirement === null ||
      (typeof requirement === "object" &&
        !Array.isArray(requirement) &&
        typeof requirement.link === "string" &&
        typeof requirement.excerpt === "string"),
    "requirement는 생략, null, {link: string, excerpt: string} 중 하나여야 한다",
  );
  if (type === "worker") {
    need(node.exclusive === undefined || typeof node.exclusive === "boolean", "exclusive는 생략하거나 boolean이어야 한다");
  } else {
    need(node.exclusive === undefined, `${type} 노드에는 exclusive를 쓰지 않는다 (worker 전용)`);
  }

  return problems;
}

// { node, problems }. `node` is null when the prompt has no parsable block. A researcher may omit the
// block (nothing is reported); worker and reviewer must start the prompt with it. Only the first block is
// the node; later plan-node blocks belong to the body (for example quoted examples).
function readNodeBlock(prompt, blockRequired) {
  const lines = prompt.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");

  if (first === -1 || !lines[first].startsWith(FENCE_OPEN)) {
    if (!blockRequired) {
      return { node: null, problems: [] };
    }
    const elsewhere = lines.some((line) => line.trimEnd() === FENCE_OPEN);
    let problem = "프롬프트 맨 앞에 plan-node 블록이 없다";
    if (first !== -1 && lines[first].trim() === FENCE_OPEN) {
      problem = "여는 줄은 들여쓰기 없이 줄 처음에 둔다";
    } else if (elsewhere) {
      problem = "plan-node 블록이 프롬프트 맨 앞(앞쪽 공백·빈 줄 제외 첫 내용)이 아니다";
    }
    return { node: null, problems: [problem] };
  }

  const problems = [];
  if (lines[first].trimEnd() !== FENCE_OPEN) {
    problems.push(`여는 줄은 정확히 ${FENCE_OPEN}여야 한다 (현재 ${JSON.stringify(lines[first].trimEnd())})`);
  }

  const close = lines.findIndex((line, index) => index > first && line.trimEnd() === FENCE_CLOSE);
  if (close === -1) {
    problems.push(`plan-node 블록을 닫는 ${FENCE_CLOSE} 줄이 없다`);
    return { node: null, problems };
  }

  let node = null;
  try {
    const parsed = JSON.parse(lines.slice(first + 1, close).join("\n"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      node = parsed;
    } else {
      problems.push("블록 내용은 JSON 객체 하나여야 한다");
    }
  } catch (error) {
    problems.push(`블록 내용이 올바른 JSON이 아니다 (${error.message})`);
  }
  return { node, problems };
}

function checkFormat(ctx) {
  return ctx.formatProblems;
}

// --- Retry limit --------------------------------------------------------------------------------

function nodeKey(plan, node) {
  return JSON.stringify([plan ?? "_", node]);
}

// The node a launch works on: a worker implements its own id, a reviewer checks `verifies`.
function targetNodeOf(subagentType, node) {
  if (subagentType === "worker") {
    return node.id;
  }
  return subagentType === "reviewer" ? node.verifies : null;
}

// Joins the recorded facts into [{ plan, node, verdict }] in the order the verdicts were reported.
// - A reviewer agent counts once: its latest verdict record wins.
// - A verdict is attributed to the launch its agent was bound to (PostToolUse(Agent)), whatever its text says.
// - Without a bind it falls back to the latest reviewer launch that verifies the node named on the verdict
//   line and is not bound to another agent. With no node on the line either, it cannot be attributed and is
//   ignored.
function resolveVerdicts(records) {
  const launches = new Map();
  const boundLaunchByAgent = new Map();
  const latestVerdictByAgent = new Map();

  records.forEach((record, index) => {
    if (record.kind === "launch" && record.agentType === "reviewer") {
      launches.set(record.toolUseId, record);
    } else if (record.kind === "bind") {
      boundLaunchByAgent.set(record.agentId, record.toolUseId);
    } else if (record.kind === "verdict") {
      latestVerdictByAgent.set(record.agentId, { index, record });
    }
  });

  // A launch bound to some agent belongs to that agent, so it cannot be the fallback for another one.
  const boundLaunchIds = new Set(boundLaunchByAgent.values());
  const unboundReviewerLaunches = [...launches.values()].filter((launch) => !boundLaunchIds.has(launch.toolUseId));
  const resolved = [];
  for (const { index, record } of latestVerdictByAgent.values()) {
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
  const target = targetNodeOf(ctx.subagentType, ctx.node);
  if (target === null) {
    return [];
  }
  const fails = failsSinceLastPass(ctx.records, nodeKey(ctx.node.plan, target));
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
  const mine = scopeOf(ctx.node.writes, root);
  const reasons = [];
  for (const running of runningWorkers(ctx.records, ctx.now)) {
    const label = labelOf(running.plan, running.id);
    if (running.plan === ctx.node.plan && running.id === ctx.node.id) {
      reasons.push(`노드 ${label}가 이미 실행 중이다. 끝난 뒤에 다시 위임한다.`);
    } else if (running.exclusive === true || ctx.node.exclusive === true) {
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

// Each check gets { input, subagentType, node, records, formatProblems, now, hints } and returns a list of
// reasons; it may push extra lines for the end of the deny message to `hints`.
// `node` is the validated block; checks after checkFormat only run when the format is valid.
const AGENT_CHECKS = [checkRetryLimit, checkWriteOverlap];

// --- Launch -------------------------------------------------------------------------------------

function denyOutput(reasons, withContractHint, hints = []) {
  const hint = withContractHint ? "\n형식 정의: ~/.claude/agents/planner.md의 '노드 블록' 절" : "";
  const lines = reasons.length === 1 ? reasons[0] : reasons.map((reason) => `- ${reason}`).join("\n");
  const head = reasons.length === 1 ? "" : "위임을 거부한다:\n";
  const tail = hints.map((line) => `\n${line}`).join("");
  return preToolUseOutput({ decision: "deny", reason: `${head}${lines}${tail}${hint}` });
}

// Rules on how a worker may be launched, independent of its node block. Only an explicit foreground launch
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
  const blockRequired = BLOCK_REQUIRED.has(subagentType);
  if (!blockRequired && !BLOCK_OPTIONAL.has(subagentType)) {
    return null;
  }

  const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt : "";
  const { node, problems } = readNodeBlock(prompt, blockRequired);
  const formatProblems = node === null ? problems : [...problems, ...validateNode(node, subagentType)];
  const ruleProblems = launchRuleProblems(input, subagentType);
  if (node === null && formatProblems.length === 0 && ruleProblems.length === 0) {
    return null;
  }
  if (formatProblems.length > 0 || ruleProblems.length > 0) {
    return denyOutput([...formatProblems, ...ruleProblems], formatProblems.length > 0);
  }

  const path = sessionStatePath(input, STATE_FILE, stateDir);
  const ctx = { input, subagentType, node, records: readJsonl(path), formatProblems, now, hints: [] };
  const reasons = AGENT_CHECKS.flatMap((check) => check(ctx));
  if (reasons.length > 0) {
    return denyOutput(reasons, false, ctx.hints);
  }

  if (blockRequired) {
    try {
      appendJsonl(path, {
        kind: "launch",
        ts: now,
        toolUseId: input.tool_use_id ?? randomUUID(),
        agentType: subagentType,
        plan: node.plan,
        id: node.id,
        verifies: node.verifies ?? null,
        writes: node.writes,
        exclusive: node.exclusive === true,
        root: findRepoRoot(input.cwd ?? process.cwd()),
      });
    } catch {
      // Recording is best-effort; never block a valid launch on it.
    }
  }
  return null;
}

// --- Recording ----------------------------------------------------------------------------------

// Strip emphasis a reviewer may wrap around the verdict (`**VERDICT n1: pass**`, `` `VERDICT n1: pass` ``).
function lastNonEmptyLine(text) {
  const lines = text.split("\n").map((line) => line.trim());
  const line = lines.findLast((candidate) => candidate !== "") ?? "";
  return line.replace(/^[*_`\s]+|[*_`\s]+$/g, "");
}

// A missing or malformed verdict line is undecided, and undecided counts as fail.
function parseVerdict(text) {
  const line = lastNonEmptyLine(typeof text === "string" ? text : "");
  const match = VERDICT_LINE.exec(line);
  if (match !== null) {
    return { node: match[1], verdict: match[2] };
  }
  return { node: /^VERDICT\s+([^\s:]+)/.exec(line)?.[1] ?? null, verdict: "fail" };
}

function recordVerdict(input, text, stateDir, now) {
  if (input.agent_type !== "reviewer" || typeof input.agent_id !== "string") {
    return;
  }
  const path = sessionStatePath(input, STATE_FILE, stateDir);
  appendJsonl(path, { kind: "verdict", ts: now, agentId: input.agent_id, ...parseVerdict(text) });
}

// PostToolUse(Agent) tells which agent a launch became (both foreground and background launches).
function recordBind(input, stateDir, now) {
  const agentId = input.tool_response?.agentId ?? input.tool_input?.agentId;
  if (typeof input.tool_use_id !== "string" || typeof agentId !== "string") {
    return;
  }
  if (!BLOCK_REQUIRED.has(input.tool_input?.subagent_type)) {
    return;
  }
  appendJsonl(sessionStatePath(input, STATE_FILE, stateDir), {
    kind: "bind",
    ts: now,
    toolUseId: input.tool_use_id,
    agentId,
    status: input.tool_response?.status ?? null,
  });
}

// A worker stopped, with or without a final message.
function recordStop(input, stateDir, now) {
  if (input.agent_type !== "worker" || typeof input.agent_id !== "string") {
    return;
  }
  appendJsonl(sessionStatePath(input, STATE_FILE, stateDir), { kind: "stop", ts: now, agentId: input.agent_id });
}

// A worker started, or started again after SendMessage resumed it (same agent_id, no resume marker).
function recordStart(input, stateDir, now) {
  if (input.agent_type !== "worker" || typeof input.agent_id !== "string") {
    return;
  }
  appendJsonl(sessionStatePath(input, STATE_FILE, stateDir), { kind: "start", ts: now, agentId: input.agent_id });
}

// An Agent call failed (an error the tool reported; Claude Code fires no hook for an abort).
function recordFailure(input, stateDir) {
  if (typeof input.tool_use_id !== "string") {
    return;
  }
  appendJsonl(sessionStatePath(input, STATE_FILE, stateDir), { kind: "fail", toolUseId: input.tool_use_id });
}

// --- Worker edits -------------------------------------------------------------------------------

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

function agentTranscriptPath(input) {
  if (isNonEmptyString(input.agent_transcript_path)) {
    return input.agent_transcript_path;
  }
  if (!isNonEmptyString(input.transcript_path) || !isNonEmptyString(input.session_id)) {
    return null;
  }
  return join(dirname(input.transcript_path), input.session_id, "subagents", `agent-${input.agent_id}.jsonl`);
}

// The node block at the start of the worker's first prompt, or null.
function nodeFromTranscript(input) {
  const path = agentTranscriptPath(input);
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
  const prompt = Array.isArray(content)
    ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
    : content;
  return typeof prompt === "string" ? readNodeBlock(prompt, false).node : null;
}

// { plan, id, writes, exclusive, root } for the worker that made this call, or null (see the header).
function nodeOfWorker(input, records, fallbackRoot) {
  const bind = records.findLast((record) => record.kind === "bind" && record.agentId === input.agent_id);
  const launch =
    bind === undefined
      ? undefined
      : records.findLast((record) => record.kind === "launch" && record.agentType === "worker" && record.toolUseId === bind.toolUseId);
  const node = launch ?? nodeFromTranscript(input);
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

  const records = readJsonl(sessionStatePath(input, STATE_FILE, stateDir));
  const node = nodeOfWorker(input, records, findRepoRoot(cwd));
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

// --- Entry --------------------------------------------------------------------------------------

// PreToolUse(Agent, Edit, Write, MultiEdit, NotebookEdit): a deny output or null. Recording events: always null.
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
    } else if (event === "PostToolUseFailure" && input.tool_name === "Agent") {
      recordFailure(input, stateDir);
    } else if (event === "PostToolUse" && input.tool_name === HANDBACK_TOOL) {
      recordVerdict(input, input.tool_input?.message, stateDir, now);
    } else if (event === "SubagentStart") {
      recordStart(input, stateDir, now);
    } else if (event === "SubagentStop") {
      recordStop(input, stateDir, now);
      // Without a message (handback mode) the handback report already carried the verdict.
      if (typeof input.last_assistant_message === "string") {
        recordVerdict(input, input.last_assistant_message, stateDir, now);
      }
    }
  } catch {
    // Recording must never fail the hook.
  }
  return null;
}

runJsonHook(evaluate, import.meta.url);
