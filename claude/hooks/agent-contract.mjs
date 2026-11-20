// Pure validators for the JSON contract between the main conversation and subagents.
//   Request: the whole prompt of a delegation is one JSON object (validateRequest).
//   Response: the whole final report of a subagent is one JSON object (validateResult).
// No file system or state access. Every validator returns a list of problems (empty = valid) so that callers
// can report all violations at once.
import { resolve } from "node:path";

export const AGENT_TYPES = Object.freeze(["planner", "researcher", "worker", "reviewer"]);

const PLAN_NODE_TYPES = ["worker", "reviewer", "researcher"];
const CHECK_RESULTS = ["pass", "fail", "not_run"];
const ISSUE_KINDS = ["blocker", "out_of_scope", "decision", "note"];
const FINDING_STATUSES = ["confirmed", "refuted", "unverified"];
const EVIDENCE_STATUSES = ["confirmed", "inferred"];

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const isNonEmptyStringArray = (value) => Array.isArray(value) && value.length >= 1 && value.every(isNonEmptyString);
const isRequirement = (value) =>
  value === undefined || value === null || (isPlainObject(value) && isNonEmptyString(value.link) && isNonEmptyString(value.excerpt));

// --- JSON document ------------------------------------------------------------------------------

// { value, problems }. `value` is the parsed object, or null when `problems` is not empty. A single
// ```/```json fence around the whole text is tolerated (a slip, not a format); anything else outside the JSON
// is rejected. `subject` ("응답" or "요청") only changes the wording of the problems.
export function readJsonDocument(text, { subject = "응답" } = {}) {
  const hint = `${subject} 전체를 JSON 객체 하나로 쓴다. 앞뒤 설명·마크다운 금지`;
  const fail = (reason) => ({ value: null, problems: [`${reason}. ${hint}`] });

  if (typeof text !== "string") {
    return fail(`${subject}이 문자열이 아니다`);
  }

  let body = text.replace(/^﻿/, "").trim();
  if (body.startsWith("```")) {
    const lines = body.replace(/\r\n?/g, "\n").split("\n");
    const open = lines[0].trimEnd();
    if (open !== "```" && open !== "```json") {
      return fail(`여는 펜스는 정확히 \`\`\` 또는 \`\`\`json이어야 한다 (현재 ${JSON.stringify(open)})`);
    }
    if (lines.length < 2 || lines[lines.length - 1].trimEnd() !== "```") {
      return fail("펜스를 닫는 ``` 줄이 마지막 줄에 없다");
    }
    body = lines.slice(1, -1).join("\n");
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return fail(`올바른 JSON이 아니다 (${error.message})`);
  }
  if (!isPlainObject(parsed)) {
    return fail("JSON 객체 하나여야 한다 (배열·원시값 불가)");
  }
  return { value: parsed, problems: [] };
}

// The request object in the first user message of a subagent transcript (`message.content`), or null.
// A string is read as one document. For a list of parts, the joined text parts are read first, then each text
// part on its own; the first that parses wins.
export function requestFromTranscriptContent(content) {
  const read = (text) => {
    const { value, problems } = readJsonDocument(text, { subject: "요청" });
    return problems.length === 0 ? value : null;
  };

  if (typeof content === "string") {
    return read(content);
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const texts = content.map((part) => (typeof part?.text === "string" ? part.text : ""));
  const joined = read(texts.join("\n"));
  if (joined !== null) {
    return joined;
  }
  for (const text of texts) {
    const single = read(text);
    if (single !== null) {
      return single;
    }
  }
  return null;
}

// --- Request ------------------------------------------------------------------------------------

export function writesPathProblem(path) {
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
  if (base.split("/").every((segment) => segment === "" || segment === ".")) {
    return "루트 전체(`/`·`/**`·`.`)";
  }
  if (base.split("/").includes("..")) {
    return "`..` 세그먼트 포함";
  }
  if (/[*?[]/.test(base)) {
    return "와일드카드는 끝의 `/**`만 허용";
  }
  return null;
}

export function validateRequest(req, subagentType) {
  if (!isPlainObject(req)) {
    return ["요청은 JSON 객체 하나여야 한다"];
  }
  if (!AGENT_TYPES.includes(subagentType)) {
    return [`subagent_type은 ${AGENT_TYPES.join("·")} 중 하나여야 한다 (현재 ${JSON.stringify(subagentType)})`];
  }
  const type = subagentType;
  const problems = [];
  const need = (condition, message) => {
    if (!condition) {
      problems.push(message);
    }
  };

  need(req.agent === type, `agent는 subagent_type(${type})과 같아야 한다 (현재 ${JSON.stringify(req.agent)})`);
  need(isNonEmptyString(req.id), "id는 비어 있지 않은 문자열이어야 한다");
  need("plan" in req && (req.plan === null || typeof req.plan === "string"), "plan은 string 또는 null이어야 한다 (생략 불가)");
  need(isNonEmptyString(req.goal), "goal은 비어 있지 않은 문자열이어야 한다");
  need(isNonEmptyStringArray(req.instructions), "instructions는 비어 있지 않은 string을 1개 이상 담은 배열이어야 한다");
  need(
    isStringArray(req.acceptanceCriteria) && req.acceptanceCriteria.length >= 1,
    "acceptanceCriteria는 1개 이상인 string[]이어야 한다",
  );
  need(
    isRequirement(req.requirement),
    "requirement는 생략, null, {link: string, excerpt: string} 중 하나여야 한다 (link·excerpt는 비어 있지 않은 문자열)",
  );
  need(req.outOfScope === undefined || isStringArray(req.outOfScope), "outOfScope는 string[]이어야 한다");
  need(req.context === undefined || typeof req.context === "string", "context는 string이어야 한다");

  if (type === "planner") {
    need(isNonEmptyString(req.plan), "planner의 plan은 만들 계획 id(비어 있지 않은 string)여야 한다");
    need(
      req.dependsOn === undefined || (Array.isArray(req.dependsOn) && req.dependsOn.length === 0),
      "planner의 dependsOn은 생략하거나 []이어야 한다",
    );
    need(req.decisions === undefined || isStringArray(req.decisions), "decisions는 string[]이어야 한다");
    need(
      req.writes === undefined || (Array.isArray(req.writes) && req.writes.length === 0),
      "planner의 writes는 생략하거나 []이어야 한다",
    );
    need(req.verifies === undefined, "planner 요청에는 verifies를 쓰지 않는다");
  } else {
    need(isStringArray(req.dependsOn), "dependsOn은 string[]이어야 한다 (없으면 [])");
  }

  if (type === "worker") {
    if (!isStringArray(req.writes)) {
      problems.push("writes는 string[]이어야 한다");
    } else if (req.writes.length === 0 && req.exclusive !== true) {
      problems.push("writes는 1개 이상이어야 한다 (`exclusive: true`일 때만 [] 허용)");
    }
    need(isNonEmptyStringArray(req.verification), "worker의 verification은 1개 이상인 string[]이어야 한다");
    need(req.exclusive === undefined || typeof req.exclusive === "boolean", "exclusive는 생략하거나 boolean이어야 한다");
  } else {
    need(req.exclusive === undefined, `${type} 노드에는 exclusive를 쓰지 않는다 (worker 전용)`);
    need(req.verification === undefined || isStringArray(req.verification), "verification은 string[]이어야 한다");
  }

  if (type === "reviewer") {
    need(Array.isArray(req.writes) && req.writes.length === 0, "reviewer의 writes는 []이어야 한다");
    need(isNonEmptyString(req.verifies), "reviewer는 verifies(검증 대상 노드 id 문자열)가 필요하다");
  } else if (type === "researcher") {
    need(
      req.writes === undefined || (Array.isArray(req.writes) && req.writes.length === 0),
      "researcher의 writes는 생략하거나 []이어야 한다",
    );
  }

  if (type !== "planner" && isStringArray(req.writes)) {
    for (const path of req.writes) {
      const problem = writesPathProblem(path);
      if (problem !== null) {
        problems.push(`writes 항목 ${JSON.stringify(path)}: ${problem}`);
      }
    }
  }

  const inputsRequired = typeof req.plan === "string" && (type === "worker" || type === "reviewer");
  if (inputsRequired) {
    need(isStringArray(req.inputs) && req.inputs.length >= 1, "계획 노드(plan이 null이 아님)의 inputs는 1개 이상인 string[]이어야 한다");
  } else {
    need(req.inputs === undefined || isStringArray(req.inputs), "inputs는 string[]이어야 한다");
  }

  return problems;
}

// --- Result -------------------------------------------------------------------------------------

// Checks every element of `list` with `check(item, label)`; elements that are not objects are reported here.
function eachItem(problems, list, name, check) {
  if (!Array.isArray(list)) {
    problems.push(`${name}는 배열이어야 한다`);
    return;
  }
  list.forEach((item, index) => {
    const label = `${name}[${index}]`;
    if (!isPlainObject(item)) {
      problems.push(`${label}는 객체여야 한다`);
      return;
    }
    check(item, label);
  });
}

function validateWorkerResult(result, problems) {
  const need = (condition, message) => {
    if (!condition) {
      problems.push(message);
    }
  };
  need(result.status === "done" || result.status === "blocked", 'status는 "done" 또는 "blocked"여야 한다');

  eachItem(problems, result.changed, "changed", (item, label) => {
    need(isNonEmptyString(item.path), `${label}.path는 비어 있지 않은 문자열이어야 한다`);
    need(isNonEmptyString(item.summary), `${label}.summary는 비어 있지 않은 문자열이어야 한다`);
  });
  eachItem(problems, result.checks, "checks", (item, label) => {
    need(isNonEmptyString(item.command), `${label}.command는 비어 있지 않은 문자열이어야 한다`);
    need(CHECK_RESULTS.includes(item.result), `${label}.result는 ${CHECK_RESULTS.join("|")} 중 하나여야 한다`);
    need(item.detail === undefined || typeof item.detail === "string", `${label}.detail은 string이어야 한다`);
  });
  eachItem(problems, result.issues, "issues", (item, label) => {
    need(ISSUE_KINDS.includes(item.kind), `${label}.kind는 ${ISSUE_KINDS.join("|")} 중 하나여야 한다`);
    need(isNonEmptyString(item.detail), `${label}.detail은 비어 있지 않은 문자열이어야 한다`);
  });

  const failedChecks = Array.isArray(result.checks) ? result.checks.filter((item) => item?.result === "fail") : [];
  const blockers = Array.isArray(result.issues) ? result.issues.filter((item) => item?.kind === "blocker") : [];
  if (result.status === "done") {
    need(failedChecks.length === 0, "status가 done이면 result가 fail인 check가 없어야 한다");
    need(blockers.length === 0, "status가 done이면 blocker issue가 없어야 한다");
  } else if (result.status === "blocked") {
    need(blockers.length >= 1, "status가 blocked이면 blocker issue가 1개 이상이어야 한다");
  }
}

function validateReviewerResult(result, request, problems) {
  const need = (condition, message) => {
    if (!condition) {
      problems.push(message);
    }
  };
  need(isNonEmptyString(result.verifies), "verifies는 비어 있지 않은 문자열이어야 한다");
  if (request !== null && result.verifies !== request.verifies) {
    problems.push(`verifies는 요청의 verifies(${JSON.stringify(request.verifies)})와 같아야 한다 (현재 ${JSON.stringify(result.verifies)})`);
  }
  need(result.verdict === "pass" || result.verdict === "fail", 'verdict는 "pass" 또는 "fail"이어야 한다');

  need(Array.isArray(result.findings) && result.findings.length >= 1, "findings는 1개 이상인 배열이어야 한다");
  eachItem(problems, result.findings, "findings", (item, label) => {
    need(isNonEmptyString(item.claim), `${label}.claim은 비어 있지 않은 문자열이어야 한다`);
    need(FINDING_STATUSES.includes(item.status), `${label}.status는 ${FINDING_STATUSES.join("|")} 중 하나여야 한다`);
    need(isStringArray(item.evidence), `${label}.evidence는 string[]이어야 한다`);
    need(item.reproduce === undefined || typeof item.reproduce === "string", `${label}.reproduce는 string이어야 한다`);
    if ((item.status === "confirmed" || item.status === "refuted") && isStringArray(item.evidence)) {
      need(item.evidence.length >= 1, `${label}.evidence는 status가 ${item.status}이면 1개 이상이어야 한다`);
    }
  });

  if (result.verdict === "pass" && Array.isArray(result.findings)) {
    result.findings.forEach((item, index) => {
      if (isPlainObject(item) && item.status !== "confirmed") {
        problems.push(`verdict가 pass이면 모든 finding이 confirmed여야 한다 (findings[${index}]는 ${JSON.stringify(item.status)})`);
      }
    });
  }
}

function validateResearcherResult(result, problems) {
  const need = (condition, message) => {
    if (!condition) {
      problems.push(message);
    }
  };
  eachItem(problems, result.evidence, "evidence", (item, label) => {
    need(isNonEmptyString(item.claim), `${label}.claim은 비어 있지 않은 문자열이어야 한다`);
    need(EVIDENCE_STATUSES.includes(item.status), `${label}.status는 ${EVIDENCE_STATUSES.join("|")} 중 하나여야 한다`);
    need(isNonEmptyString(item.source), `${label}.source는 비어 있지 않은 문자열이어야 한다`);
    need(item.quote === undefined || typeof item.quote === "string", `${label}.quote는 string이어야 한다`);
  });
  eachItem(problems, result.unverified, "unverified", (item, label) => {
    for (const key of ["item", "searched", "nextCheck"]) {
      need(isNonEmptyString(item[key]), `${label}.${key}는 비어 있지 않은 문자열이어야 한다`);
    }
  });
  if (Array.isArray(result.evidence) && Array.isArray(result.unverified)) {
    need(result.evidence.length + result.unverified.length >= 1, "evidence와 unverified가 둘 다 비어 있으면 안 된다");
  }
}

const scopeEntry = (path, root) => {
  const dir = path.endsWith("/**");
  const base = dir ? path.slice(0, -3) : path;
  return { path: root === null ? base : resolve(root, base), dir };
};
const isWithin = (child, parent) => child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
const entriesOverlap = (left, right) =>
  left.path === right.path || (left.dir && isWithin(right.path, left.path)) || (right.dir && isWithin(left.path, right.path));

function validatePlannerResult(result, root, problems) {
  const need = (condition, message) => {
    if (!condition) {
      problems.push(message);
    }
  };
  need(isNonEmptyString(result.plan), "planner 응답의 plan은 비어 있지 않은 string(계획 id)이어야 한다");
  need(result.status === "ready" || result.status === "awaiting_answers", 'status는 "ready" 또는 "awaiting_answers"여야 한다');
  need(isNonEmptyString(result.goal), "goal은 비어 있지 않은 문자열이어야 한다");
  need(
    result.requirement !== undefined && isRequirement(result.requirement),
    "requirement는 null 또는 {link: string, excerpt: string}이어야 한다 (생략 불가)",
  );
  need(isStringArray(result.outOfScope), "outOfScope는 string[]이어야 한다");
  need(isStringArray(result.assumptions), "assumptions는 string[]이어야 한다");

  eachItem(problems, result.openQuestions, "openQuestions", (item, label) => {
    need(isNonEmptyString(item.question), `${label}.question은 비어 있지 않은 문자열이어야 한다`);
    need(isStringArray(item.options), `${label}.options는 string[]이어야 한다`);
    need(item.recommendation === undefined || typeof item.recommendation === "string", `${label}.recommendation은 string이어야 한다`);
  });
  if (Array.isArray(result.openQuestions)) {
    if (result.status === "ready") {
      need(result.openQuestions.length === 0, "status가 ready이면 openQuestions가 비어 있어야 한다");
    } else if (result.status === "awaiting_answers") {
      need(result.openQuestions.length >= 1, "status가 awaiting_answers이면 openQuestions가 1개 이상이어야 한다");
    }
  }

  eachItem(problems, result.selfCheck, "selfCheck", (item, label) => {
    need(isNonEmptyString(item.item), `${label}.item은 비어 있지 않은 문자열이어야 한다`);
    need(item.result === "pass" || item.result === "fail", `${label}.result는 pass|fail 중 하나여야 한다`);
    need(typeof item.detail === "string", `${label}.detail은 string이어야 한다`);
    need(item.result !== "fail", `${label}: 자체 점검이 fail이다 (${JSON.stringify(item.item)}). 계획을 고친 뒤 반환한다`);
  });

  // Nodes: each one is a request object of its own type.
  const nodes = [];
  need(Array.isArray(result.nodes), "nodes는 배열이어야 한다");
  (Array.isArray(result.nodes) ? result.nodes : []).forEach((node, index) => {
    const label = `nodes[${index}]${isPlainObject(node) && isNonEmptyString(node.id) ? `(${node.id})` : ""}`;
    if (!isPlainObject(node)) {
      problems.push(`${label}는 객체여야 한다`);
      return;
    }
    if (!PLAN_NODE_TYPES.includes(node.agent)) {
      problems.push(`${label}.agent는 ${PLAN_NODE_TYPES.join("·")} 중 하나여야 한다 (현재 ${JSON.stringify(node.agent)})`);
      return;
    }
    if (node.plan !== result.plan) {
      problems.push(`${label}.plan은 응답의 plan(${JSON.stringify(result.plan)})과 같아야 한다 (현재 ${JSON.stringify(node.plan)})`);
    }
    for (const problem of validateRequest(node, node.agent)) {
      problems.push(`${label}: ${problem}`);
    }
    nodes.push(node);
  });

  // Stages: [[id, ...], ...]
  const stagesOk =
    Array.isArray(result.stages) &&
    result.stages.length >= 1 &&
    result.stages.every((stage) => Array.isArray(stage) && stage.length >= 1 && stage.every(isNonEmptyString));
  need(stagesOk, "stages는 비어 있지 않은 노드 id 배열을 1개 이상 담은 배열이어야 한다 (string[][])");

  const byId = new Map();
  for (const node of nodes) {
    if (!isNonEmptyString(node.id)) {
      continue;
    }
    if (byId.has(node.id)) {
      problems.push(`노드 id ${JSON.stringify(node.id)}가 중복된다`);
    } else {
      byId.set(node.id, node);
    }
  }
  if (!stagesOk) {
    return;
  }

  const positions = new Map();
  result.stages.forEach((stage, index) => {
    for (const id of stage) {
      if (!byId.has(id)) {
        problems.push(`stages[${index}]의 ${JSON.stringify(id)}는 nodes에 없는 id다`);
      } else {
        positions.set(id, [...(positions.get(id) ?? []), index]);
      }
    }
  });
  for (const id of byId.keys()) {
    const where = positions.get(id) ?? [];
    if (where.length === 0) {
      problems.push(`노드 ${id}가 어떤 단계에도 없다`);
    } else if (where.length > 1) {
      problems.push(`노드 ${id}는 정확히 한 단계에만 있어야 한다 (현재 ${where.length}번 나온다)`);
    }
  }
  const stageOf = (id) => (positions.get(id)?.length === 1 ? positions.get(id)[0] : null);

  // dependsOn must name real nodes in strictly earlier stages (this also rules out self dependency and cycles).
  for (const node of byId.values()) {
    if (!isStringArray(node.dependsOn)) {
      continue;
    }
    for (const dep of node.dependsOn) {
      if (dep === node.id) {
        problems.push(`노드 ${node.id}가 자기 자신에 의존한다`);
      } else if (!byId.has(dep)) {
        problems.push(`노드 ${node.id}의 dependsOn ${JSON.stringify(dep)}는 nodes에 없는 id다`);
      } else {
        const own = stageOf(node.id);
        const other = stageOf(dep);
        if (own !== null && other !== null && other >= own) {
          problems.push(`노드 ${node.id}의 dependsOn ${dep}는 엄격히 앞선 단계에 있어야 한다 (같은 단계이거나 뒤 단계: 순환 가능)`);
        }
      }
    }
  }

  // Exclusive workers run alone; workers in one stage must not write the same paths.
  const workersByStage = new Map();
  for (const node of byId.values()) {
    const index = stageOf(node.id);
    if (node.agent !== "worker" || index === null) {
      continue;
    }
    workersByStage.set(index, [...(workersByStage.get(index) ?? []), node]);
    if (node.exclusive === true && result.stages[index].length !== 1) {
      problems.push(`exclusive worker ${node.id}는 단계에 혼자 있어야 한다 (stages[${index}]에 ${result.stages[index].length}개)`);
    }
  }
  const scopeRoot = isNonEmptyString(root) ? root : null;
  for (const [index, workers] of workersByStage) {
    for (let a = 0; a < workers.length; a += 1) {
      for (let b = a + 1; b < workers.length; b += 1) {
        const left = isStringArray(workers[a].writes) ? workers[a].writes.map((path) => scopeEntry(path, scopeRoot)) : [];
        const right = isStringArray(workers[b].writes) ? workers[b].writes.map((path) => scopeEntry(path, scopeRoot)) : [];
        const hit = left.find((x) => right.some((y) => entriesOverlap(x, y)));
        if (hit !== undefined) {
          problems.push(`같은 단계(stages[${index}])의 worker ${workers[a].id}와 ${workers[b].id}의 writes가 겹친다 (${hit.path}${hit.dir ? "/**" : ""})`);
        }
      }
    }
  }

  // Every worker needs a reviewer in a later stage; a reviewer verifies a worker.
  const reviewers = [...byId.values()].filter((node) => node.agent === "reviewer");
  for (const reviewer of reviewers) {
    if (isNonEmptyString(reviewer.verifies) && byId.get(reviewer.verifies)?.agent !== "worker") {
      problems.push(`reviewer ${reviewer.id}의 verifies ${JSON.stringify(reviewer.verifies)}는 worker 노드 id여야 한다`);
    }
  }
  for (const worker of byId.values()) {
    if (worker.agent !== "worker") {
      continue;
    }
    const workerStage = stageOf(worker.id);
    const covered = reviewers.some((reviewer) => {
      const reviewerStage = stageOf(reviewer.id);
      return reviewer.verifies === worker.id && workerStage !== null && reviewerStage !== null && reviewerStage > workerStage;
    });
    if (!covered) {
      problems.push(`worker ${worker.id}를 verifies하는 reviewer가 더 뒤 단계에 없다`);
    }
  }
}

// problems for `result`, the parsed report of a subagent of `type`. `request` (the parsed request, optional)
// adds the cross checks: plan, id and, for reviewers, verifies must match. `root` is the base of relative
// `writes` paths in a planner's nodes.
export function validateResult(result, type, { request = null, root = null } = {}) {
  if (!isPlainObject(result)) {
    return ["응답은 JSON 객체 하나여야 한다"];
  }
  if (!AGENT_TYPES.includes(type)) {
    return [`subagent_type은 ${AGENT_TYPES.join("·")} 중 하나여야 한다 (현재 ${JSON.stringify(type)})`];
  }
  const problems = [];
  const req = isPlainObject(request) ? request : null;

  if (result.agent !== type) {
    problems.push(`agent는 ${JSON.stringify(type)}이어야 한다 (현재 ${JSON.stringify(result.agent)})`);
  }
  if (!("plan" in result) || (result.plan !== null && typeof result.plan !== "string")) {
    problems.push("plan은 string 또는 null이어야 한다 (생략 불가)");
  } else if (req !== null && result.plan !== (req.plan ?? null)) {
    problems.push(`plan은 요청의 plan(${JSON.stringify(req.plan ?? null)})과 같아야 한다 (현재 ${JSON.stringify(result.plan)})`);
  }
  if (!isNonEmptyString(result.id)) {
    problems.push("id는 비어 있지 않은 문자열이어야 한다");
  } else if (req !== null && result.id !== req.id) {
    problems.push(`id는 요청의 id(${JSON.stringify(req.id)})와 같아야 한다 (현재 ${JSON.stringify(result.id)})`);
  }
  if (!isNonEmptyString(result.summary)) {
    problems.push("summary는 비어 있지 않은 문자열이어야 한다");
  }

  if (type === "worker") {
    validateWorkerResult(result, problems);
  } else if (type === "reviewer") {
    validateReviewerResult(result, req, problems);
  } else if (type === "researcher") {
    validateResearcherResult(result, problems);
  } else {
    validatePlannerResult(result, root, problems);
  }
  return problems;
}
