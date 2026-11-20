// Run with: node --test claude/hooks/agent-contract.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_TYPES,
  readJsonDocument,
  requestFromTranscriptContent,
  validateRequest,
  validateResult,
  writesPathProblem,
} from "./agent-contract.mjs";

const without = (object, ...keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
const includes = (problems, part) => problems.some((problem) => problem.includes(part));
const expectProblem = (problems, part) => assert.ok(includes(problems, part), `expected "${part}" in ${JSON.stringify(problems)}`);

describe("AGENT_TYPES", () => {
  it("lists the four agent types and is frozen", () => {
    assert.deepEqual([...AGENT_TYPES], ["planner", "researcher", "worker", "reviewer"]);
    assert.ok(Object.isFrozen(AGENT_TYPES));
  });
});

describe("readJsonDocument (A0)", () => {
  const object = { a: 1 };

  it("reads a bare JSON object, ignoring a BOM and surrounding whitespace", () => {
    assert.deepEqual(readJsonDocument(`﻿ \n${JSON.stringify(object)}\n `), { value: object, problems: [] });
  });

  it("reads an object wrapped in a ``` or ```json fence", () => {
    assert.deepEqual(readJsonDocument(`\`\`\`\n{"a":1}\n\`\`\``).value, object);
    assert.deepEqual(readJsonDocument(`\n\`\`\`json\n{\n  "a": 1\n}\n\`\`\`\n\n`).value, object);
  });

  it("rejects text around the JSON with the whole-document hint", () => {
    for (const text of ['결과는 다음과 같다 {"a":1}', '{"a":1} 끝', '설명\n```json\n{"a":1}\n```']) {
      const { value, problems } = readJsonDocument(text);
      assert.equal(value, null, text);
      expectProblem(problems, "응답 전체를 JSON 객체 하나로 쓴다. 앞뒤 설명·마크다운 금지");
    }
  });

  it("rejects a fence with another info string, text after the fence, or no closing fence", () => {
    assert.notEqual(readJsonDocument('```plan-node\n{"a":1}\n```').problems.length, 0);
    assert.notEqual(readJsonDocument('```json\n{"a":1}\n```\n설명').problems.length, 0);
    assert.notEqual(readJsonDocument('```json\n{"a":1}').problems.length, 0);
    assert.notEqual(readJsonDocument("```").problems.length, 0);
  });

  it("rejects arrays, primitives and invalid JSON", () => {
    for (const text of ["[]", '"x"', "1", "null", "{not json}", ""]) {
      assert.notEqual(readJsonDocument(text).problems.length, 0, text);
    }
    assert.notEqual(readJsonDocument(undefined).problems.length, 0);
  });

  it("words the problem for a request when asked", () => {
    const { problems } = readJsonDocument("설명", { subject: "요청" });
    expectProblem(problems, "요청 전체를 JSON 객체 하나로 쓴다. 앞뒤 설명·마크다운 금지");
  });
});

describe("requestFromTranscriptContent", () => {
  const json = '{"id":"n1"}';

  it("reads a string content", () => {
    assert.deepEqual(requestFromTranscriptContent(json), { id: "n1" });
    assert.deepEqual(requestFromTranscriptContent(`\`\`\`json\n${json}\n\`\`\``), { id: "n1" });
  });

  it("reads the joined text parts first", () => {
    const parts = [{ type: "text", text: '{"id":' }, { type: "text", text: '"n1"}' }];
    assert.deepEqual(requestFromTranscriptContent(parts), { id: "n1" });
  });

  it("falls back to the first text part that parses", () => {
    const parts = [{ type: "text", text: "<system-reminder>" }, { type: "text", text: json }, { type: "text", text: '{"id":"n2"}' }];
    assert.deepEqual(requestFromTranscriptContent(parts), { id: "n1" });
  });

  it("returns null for prose, arrays, non-text parts and other content", () => {
    assert.equal(requestFromTranscriptContent("그냥 지시"), null);
    assert.equal(requestFromTranscriptContent("[1]"), null);
    assert.equal(requestFromTranscriptContent([{ type: "image" }, { text: 3 }]), null);
    assert.equal(requestFromTranscriptContent(undefined), null);
    assert.equal(requestFromTranscriptContent(5), null);
  });
});

describe("writesPathProblem", () => {
  it("accepts plain paths, absolute paths and a trailing /**", () => {
    for (const path of ["src/a.ts", "/abs/a.ts", "src/**", "/abs/dir/**", ".github/a.yml", "src/./a.ts"]) {
      assert.equal(writesPathProblem(path), null, path);
    }
  });

  it("explains each rejected form", () => {
    const cases = [
      ["", "빈 문자열"],
      ["./a.ts", "`./`"],
      ["~/a.ts", "`~`"],
      ["a/../b.ts", "`..`"],
      ["/**", "루트"],
      ["/", "루트"],
      ["//", "루트"],
      [".", "루트"],
      ["/.", "루트"],
      ["/./**", "루트"],
      ["src/*.ts", "와일드카드"],
      ["src/**/a.ts", "와일드카드"],
      ["src/a?.ts", "와일드카드"],
      ["src/[ab].ts", "와일드카드"],
    ];
    for (const [path, expected] of cases) {
      assert.ok(writesPathProblem(path)?.includes(expected), `${path}: ${writesPathProblem(path)}`);
    }
  });
});

describe("validateRequest (A1)", () => {
  const base = (extra = {}) => ({
    plan: "p1",
    id: "n1",
    goal: "목표",
    instructions: ["하나"],
    acceptanceCriteria: ["기준"],
    ...extra,
  });
  const worker = (extra = {}) =>
    base({ agent: "worker", dependsOn: [], writes: ["src/a.ts"], verification: ["node --test"], inputs: ["src/a.ts:1-10"], ...extra });
  const reviewer = (extra = {}) =>
    base({ agent: "reviewer", id: "r1", dependsOn: ["n1"], writes: [], verifies: "n1", inputs: ["src/a.ts:1-10"], ...extra });
  const researcher = (extra = {}) => base({ agent: "researcher", id: "q1", plan: null, dependsOn: [], ...extra });
  const planner = (extra = {}) => base({ agent: "planner", id: "pl1", plan: "p1", ...extra });

  it("accepts a well-formed request for each type", () => {
    assert.deepEqual(validateRequest(worker(), "worker"), []);
    assert.deepEqual(validateRequest(reviewer(), "reviewer"), []);
    assert.deepEqual(validateRequest(researcher(), "researcher"), []);
    assert.deepEqual(validateRequest(planner(), "planner"), []);
  });

  it("accepts the minimal researcher form outside a plan", () => {
    const minimal = { plan: null, id: "r1", agent: "researcher", goal: "조사", instructions: ["읽는다"], dependsOn: [], acceptanceCriteria: ["답"] };
    assert.deepEqual(validateRequest(minimal, "researcher"), []);
  });

  it("allows unknown keys and the optional fields", () => {
    const extra = {
      extra: 1,
      requirement: { link: "https://x", excerpt: "e" },
      outOfScope: ["a"],
      context: "c",
      verification: ["v"],
    };
    assert.deepEqual(validateRequest(worker(extra), "worker"), []);
    assert.deepEqual(validateRequest(worker({ requirement: null }), "worker"), []);
    assert.deepEqual(validateRequest(planner({ decisions: ["d"], inputs: ["i"], dependsOn: [] }), "planner"), []);
  });

  it("rejects a request that is not an object or has an unknown type", () => {
    expectProblem(validateRequest([], "worker"), "JSON 객체");
    expectProblem(validateRequest(worker(), "general-purpose"), "subagent_type");
  });

  const commonCases = [
    ["agent differs from subagent_type", worker({ agent: "reviewer" }), "worker", "agent는"],
    ["empty id", worker({ id: "" }), "worker", "id는"],
    ["numeric id", worker({ id: 1 }), "worker", "id는"],
    ["missing plan", without(worker(), "plan"), "worker", "plan은"],
    ["numeric plan", worker({ plan: 3 }), "worker", "plan은"],
    ["missing goal", without(worker(), "goal"), "worker", "goal"],
    ["blank goal", worker({ goal: "  " }), "worker", "goal"],
    ["missing instructions", without(worker(), "instructions"), "worker", "instructions"],
    ["empty instructions", worker({ instructions: [] }), "worker", "instructions"],
    ["blank instruction", worker({ instructions: [""] }), "worker", "instructions"],
    ["empty acceptanceCriteria", worker({ acceptanceCriteria: [] }), "worker", "acceptanceCriteria"],
    ["non-array dependsOn", worker({ dependsOn: "n1" }), "worker", "dependsOn"],
    ["non-string dependsOn item", worker({ dependsOn: [1] }), "worker", "dependsOn"],
    ["missing dependsOn on a researcher", without(researcher(), "dependsOn"), "researcher", "dependsOn"],
    ["requirement without excerpt", worker({ requirement: { link: "x" } }), "worker", "requirement"],
    ["requirement with empty link", worker({ requirement: { link: "", excerpt: "e" } }), "worker", "requirement"],
    ["requirement that is a string", worker({ requirement: "x" }), "worker", "requirement"],
    ["non-array outOfScope", worker({ outOfScope: "x" }), "worker", "outOfScope"],
    ["non-string context", worker({ context: 1 }), "worker", "context"],
    ["non-array verification on a reviewer", reviewer({ verification: "x" }), "reviewer", "verification"],
    ["exclusive on a reviewer", reviewer({ exclusive: true }), "reviewer", "exclusive"],
    ["exclusive false on a reviewer", reviewer({ exclusive: false }), "reviewer", "exclusive"],
    ["exclusive on a researcher", researcher({ exclusive: true }), "researcher", "exclusive"],
    ["exclusive on a planner", planner({ exclusive: true }), "planner", "exclusive"],
  ];
  for (const [name, request, type, expected] of commonCases) {
    it(`rejects ${name}`, () => {
      expectProblem(validateRequest(request, type), expected);
    });
  }

  const workerCases = [
    ["missing writes", without(worker(), "writes"), "writes는 string[]"],
    ["empty writes", worker({ writes: [] }), "writes는 1개 이상"],
    ["empty writes with exclusive false", worker({ writes: [], exclusive: false }), "writes는 1개 이상"],
    ["exclusive that is not boolean", worker({ exclusive: "yes" }), "exclusive"],
    ["writes with a .. segment", worker({ writes: ["a/../b.ts"] }), ".."],
    ["writes starting with ./", worker({ writes: ["./a.ts"] }), "./"],
    ["writes starting with ~", worker({ writes: ["~/.claude/a.ts"] }), "`~`"],
    ["writes with * in the middle", worker({ writes: ["src/*.ts"] }), "와일드카드"],
    ["missing verification", without(worker(), "verification"), "verification"],
    ["empty verification", worker({ verification: [] }), "verification"],
    ["plan node without inputs", without(worker(), "inputs"), "inputs"],
    ["plan node with empty inputs", worker({ inputs: [] }), "inputs"],
  ];
  for (const [name, request, expected] of workerCases) {
    it(`rejects a worker with ${name}`, () => {
      expectProblem(validateRequest(request, "worker"), expected);
    });
  }

  it("allows worker variations the plan-node format allowed", () => {
    assert.deepEqual(validateRequest(worker({ writes: [], exclusive: true }), "worker"), []);
    assert.deepEqual(validateRequest(worker({ writes: ["src/**", "/abs/a.ts"] }), "worker"), []);
    assert.deepEqual(validateRequest(without(worker({ plan: null }), "inputs"), "worker"), []);
  });

  it("checks reviewers", () => {
    expectProblem(validateRequest(reviewer({ writes: ["a.ts"] }), "reviewer"), "writes는 []");
    expectProblem(validateRequest(without(reviewer(), "writes"), "reviewer"), "writes는 []");
    expectProblem(validateRequest(without(reviewer(), "verifies"), "reviewer"), "verifies");
    expectProblem(validateRequest(reviewer({ verifies: "" }), "reviewer"), "verifies");
    expectProblem(validateRequest(without(reviewer(), "inputs"), "reviewer"), "inputs");
    assert.deepEqual(validateRequest(without(reviewer({ plan: null }), "inputs"), "reviewer"), []);
  });

  it("checks researchers", () => {
    expectProblem(validateRequest(researcher({ writes: ["a.ts"] }), "researcher"), "researcher의 writes");
    expectProblem(validateRequest(researcher({ inputs: "x" }), "researcher"), "inputs");
    assert.deepEqual(validateRequest(researcher({ writes: [] }), "researcher"), []);
    assert.deepEqual(validateRequest(researcher({ plan: "p1" }), "researcher"), []);
  });

  it("checks planners", () => {
    expectProblem(validateRequest(planner({ plan: null }), "planner"), "planner의 plan");
    expectProblem(validateRequest(planner({ dependsOn: ["x"] }), "planner"), "planner의 dependsOn");
    expectProblem(validateRequest(planner({ writes: ["a.ts"] }), "planner"), "planner의 writes");
    expectProblem(validateRequest(planner({ verifies: "n1" }), "planner"), "verifies");
    expectProblem(validateRequest(planner({ decisions: "x" }), "planner"), "decisions");
    assert.deepEqual(validateRequest(planner({ writes: [] }), "planner"), []);
  });

  it("lists every violation at once", () => {
    const problems = validateRequest(worker({ id: "", writes: ["./a", "b/../c"], acceptanceCriteria: [] }), "worker");
    for (const part of ["id는", "./", "..", "acceptanceCriteria"]) {
      expectProblem(problems, part);
    }
  });
});

describe("validateResult (A2)", () => {
  const workerRequest = { agent: "worker", plan: "p1", id: "n1", writes: ["a.ts"] };
  const workerResult = (extra = {}) => ({
    agent: "worker",
    plan: "p1",
    id: "n1",
    status: "done",
    summary: "완료",
    changed: [{ path: "a.ts", summary: "수정" }],
    checks: [{ command: "node --test", result: "pass", detail: "3 pass" }],
    issues: [{ kind: "note", detail: "참고" }],
    ...extra,
  });
  const reviewerRequest = { agent: "reviewer", plan: "p1", id: "r1", verifies: "n1" };
  const reviewerResult = (extra = {}) => ({
    agent: "reviewer",
    plan: "p1",
    id: "r1",
    summary: "검토",
    verifies: "n1",
    verdict: "pass",
    findings: [{ claim: "동작한다", status: "confirmed", evidence: ["a.ts:1"], reproduce: "node a.ts" }],
    ...extra,
  });
  const researcherResult = (extra = {}) => ({
    agent: "researcher",
    plan: null,
    id: "q1",
    summary: "결론",
    evidence: [{ claim: "A다", status: "confirmed", source: "a.ts:3", quote: "A" }],
    unverified: [],
    ...extra,
  });

  it("rejects a result that is not an object or has an unknown type", () => {
    expectProblem(validateResult([], "worker"), "JSON 객체");
    expectProblem(validateResult(workerResult(), "general-purpose"), "subagent_type");
  });

  describe("common", () => {
    it("accepts a matching request", () => {
      assert.deepEqual(validateResult(workerResult(), "worker", { request: workerRequest }), []);
      assert.deepEqual(validateResult(workerResult(), "worker"), []);
    });

    it("rejects mismatched agent, plan and id and a missing or blank summary", () => {
      expectProblem(validateResult(workerResult({ agent: "reviewer" }), "worker"), "agent는");
      expectProblem(validateResult(without(workerResult(), "plan"), "worker"), "plan은");
      expectProblem(validateResult(workerResult({ plan: "p2" }), "worker", { request: workerRequest }), "plan은 요청의 plan");
      expectProblem(validateResult(workerResult({ id: "n2" }), "worker", { request: workerRequest }), "id는 요청의 id");
      expectProblem(validateResult(workerResult({ id: "" }), "worker"), "id는");
      expectProblem(validateResult(workerResult({ summary: " " }), "worker"), "summary");
      expectProblem(validateResult(without(workerResult(), "summary"), "worker"), "summary");
    });

    it("treats a request with plan null as plan null", () => {
      assert.deepEqual(validateResult(researcherResult(), "researcher", { request: { plan: null, id: "q1" } }), []);
      expectProblem(validateResult(researcherResult({ plan: "p1" }), "researcher", { request: { plan: null, id: "q1" } }), "plan은 요청의 plan");
    });

    it("allows unknown keys", () => {
      assert.deepEqual(validateResult(workerResult({ extra: { a: 1 } }), "worker"), []);
    });
  });

  describe("worker", () => {
    it("accepts a blocked result with a blocker", () => {
      const blocked = workerResult({ status: "blocked", issues: [{ kind: "blocker", detail: "writes 밖 수정 필요" }] });
      assert.deepEqual(validateResult(blocked, "worker"), []);
    });

    it("accepts done with a not_run check and empty lists", () => {
      const result = workerResult({ checks: [{ command: "nix build", result: "not_run" }], changed: [], issues: [] });
      assert.deepEqual(validateResult(result, "worker"), []);
    });

    const cases = [
      ["an unknown status", workerResult({ status: "ok" }), "status"],
      ["a missing changed", without(workerResult(), "changed"), "changed"],
      ["a changed item without path", workerResult({ changed: [{ summary: "x" }] }), "changed[0].path"],
      ["a changed item without summary", workerResult({ changed: [{ path: "a" }] }), "changed[0].summary"],
      ["a non-object changed item", workerResult({ changed: ["a.ts"] }), "changed[0]"],
      ["a missing checks", without(workerResult(), "checks"), "checks"],
      ["a check without command", workerResult({ checks: [{ result: "pass" }] }), "checks[0].command"],
      ["a check with an unknown result", workerResult({ checks: [{ command: "x", result: "ok" }] }), "checks[0].result"],
      ["a check with a non-string detail", workerResult({ checks: [{ command: "x", result: "pass", detail: 1 }] }), "checks[0].detail"],
      ["a missing issues", without(workerResult(), "issues"), "issues"],
      ["an issue with an unknown kind", workerResult({ issues: [{ kind: "warn", detail: "x" }] }), "issues[0].kind"],
      ["an issue without detail", workerResult({ issues: [{ kind: "note" }] }), "issues[0].detail"],
      ["done with a failed check", workerResult({ checks: [{ command: "x", result: "fail" }] }), "fail인 check"],
      ["done with a blocker", workerResult({ issues: [{ kind: "blocker", detail: "x" }] }), "blocker"],
      ["blocked without a blocker", workerResult({ status: "blocked" }), "blocker issue가 1개 이상"],
    ];
    for (const [name, result, expected] of cases) {
      it(`rejects ${name}`, () => {
        expectProblem(validateResult(result, "worker"), expected);
      });
    }
  });

  describe("reviewer", () => {
    it("accepts pass and fail results", () => {
      assert.deepEqual(validateResult(reviewerResult(), "reviewer", { request: reviewerRequest }), []);
      const failing = reviewerResult({
        verdict: "fail",
        findings: [
          { claim: "A", status: "refuted", evidence: ["a.ts:1"] },
          { claim: "B", status: "unverified", evidence: [] },
        ],
      });
      assert.deepEqual(validateResult(failing, "reviewer", { request: reviewerRequest }), []);
    });

    const cases = [
      ["a missing verifies", without(reviewerResult(), "verifies"), "verifies"],
      ["a verdict outside pass|fail", reviewerResult({ verdict: "ok" }), "verdict"],
      ["empty findings", reviewerResult({ findings: [] }), "findings"],
      ["a missing findings", without(reviewerResult(), "findings"), "findings"],
      ["a finding without claim", reviewerResult({ findings: [{ status: "confirmed", evidence: ["x"] }] }), "findings[0].claim"],
      ["a finding with an unknown status", reviewerResult({ findings: [{ claim: "x", status: "ok", evidence: [] }] }), "findings[0].status"],
      ["a finding with non-array evidence", reviewerResult({ findings: [{ claim: "x", status: "unverified", evidence: "x" }] }), "evidence"],
      ["a finding with a non-string reproduce", reviewerResult({ findings: [{ claim: "x", status: "unverified", evidence: [], reproduce: 1 }], verdict: "fail" }), "reproduce"],
      ["a confirmed finding without evidence", reviewerResult({ findings: [{ claim: "x", status: "confirmed", evidence: [] }] }), "evidence는 status가 confirmed"],
      ["a refuted finding without evidence", reviewerResult({ verdict: "fail", findings: [{ claim: "x", status: "refuted", evidence: [] }] }), "evidence는 status가 refuted"],
      ["pass with a refuted finding", reviewerResult({ findings: [{ claim: "x", status: "refuted", evidence: ["e"] }] }), "모든 finding이 confirmed"],
      ["pass with an unverified finding", reviewerResult({ findings: [{ claim: "x", status: "unverified", evidence: [] }] }), "모든 finding이 confirmed"],
    ];
    for (const [name, result, expected] of cases) {
      it(`rejects ${name}`, () => {
        expectProblem(validateResult(result, "reviewer"), expected);
      });
    }

    it("rejects verifies that differs from the request", () => {
      expectProblem(validateResult(reviewerResult({ verifies: "r1" }), "reviewer", { request: reviewerRequest }), "요청의 verifies");
    });
  });

  describe("researcher", () => {
    it("accepts evidence only, unverified only and both", () => {
      assert.deepEqual(validateResult(researcherResult(), "researcher"), []);
      const unverifiedOnly = researcherResult({
        evidence: [],
        unverified: [{ item: "X", searched: "rg X", nextCheck: "문서를 읽는다" }],
      });
      assert.deepEqual(validateResult(unverifiedOnly, "researcher"), []);
      const inferred = researcherResult({ evidence: [{ claim: "B", status: "inferred", source: "추론" }] });
      assert.deepEqual(validateResult(inferred, "researcher"), []);
    });

    const cases = [
      ["both evidence and unverified empty", researcherResult({ evidence: [], unverified: [] }), "둘 다 비어"],
      ["a missing evidence", without(researcherResult(), "evidence"), "evidence"],
      ["a missing unverified", without(researcherResult(), "unverified"), "unverified"],
      ["evidence with an unknown status", researcherResult({ evidence: [{ claim: "A", status: "refuted", source: "x" }] }), "evidence[0].status"],
      ["evidence without source", researcherResult({ evidence: [{ claim: "A", status: "confirmed", source: " " }] }), "evidence[0].source"],
      ["evidence without claim", researcherResult({ evidence: [{ status: "confirmed", source: "x" }] }), "evidence[0].claim"],
      ["evidence with a non-string quote", researcherResult({ evidence: [{ claim: "A", status: "confirmed", source: "x", quote: 1 }] }), "quote"],
      ["unverified without nextCheck", researcherResult({ unverified: [{ item: "X", searched: "y" }] }), "unverified[0].nextCheck"],
      ["unverified without searched", researcherResult({ unverified: [{ item: "X", nextCheck: "y" }] }), "unverified[0].searched"],
      ["unverified without item", researcherResult({ unverified: [{ searched: "X", nextCheck: "y" }] }), "unverified[0].item"],
    ];
    for (const [name, result, expected] of cases) {
      it(`rejects ${name}`, () => {
        expectProblem(validateResult(result, "researcher"), expected);
      });
    }
  });

  describe("planner", () => {
    const req = (agent, id, extra = {}) => ({
      plan: "p1",
      id,
      agent,
      goal: "목표",
      instructions: ["지시"],
      dependsOn: [],
      acceptanceCriteria: ["기준"],
      ...extra,
    });
    const w = (id, extra = {}) => req("worker", id, { writes: [`src/${id}.ts`], verification: ["v"], inputs: ["src/a.ts:1"], ...extra });
    const r = (id, verifies, extra = {}) => req("reviewer", id, { writes: [], verifies, inputs: ["src/a.ts:1"], dependsOn: [verifies], ...extra });

    const plannerRequest = { agent: "planner", plan: "p1", id: "pl1" };
    const plannerResult = (extra = {}) => ({
      agent: "planner",
      plan: "p1",
      id: "pl1",
      summary: "계획 완료",
      status: "ready",
      goal: "목표",
      requirement: null,
      outOfScope: ["범위 밖"],
      assumptions: ["가정"],
      openQuestions: [],
      stages: [["n1", "n2"], ["r1", "r2"]],
      nodes: [w("n1"), w("n2"), r("r1", "n1"), r("r2", "n2")],
      selfCheck: [{ item: "writes 겹침", result: "pass", detail: "없음" }],
      ...extra,
    });
    const check = (result, options = {}) => validateResult(result, "planner", { request: plannerRequest, ...options });

    it("accepts a ready plan", () => {
      assert.deepEqual(check(plannerResult()), []);
    });

    it("accepts a plan awaiting answers and a requirement object", () => {
      const result = plannerResult({
        status: "awaiting_answers",
        requirement: { link: "https://x", excerpt: "e" },
        openQuestions: [{ question: "어느 쪽?", options: ["A", "B"], recommendation: "A" }],
      });
      assert.deepEqual(check(result), []);
    });

    it("accepts a researcher node and an exclusive worker alone in its stage", () => {
      const result = plannerResult({
        stages: [["q1"], ["n1"], ["x1"], ["r1", "rx"]],
        nodes: [
          req("researcher", "q1"),
          w("n1", { dependsOn: ["q1"] }),
          w("x1", { writes: [], exclusive: true, dependsOn: ["n1"] }),
          r("r1", "n1"),
          r("rx", "x1"),
        ],
      });
      assert.deepEqual(check(result), []);
    });

    it("rejects the plan mismatching the request", () => {
      expectProblem(check(plannerResult({ plan: "p2", nodes: [] })), "plan은 요청의 plan");
    });

    const fieldCases = [
      ["an unknown status", { status: "done" }, "status"],
      ["a missing goal", { goal: "" }, "goal"],
      ["a missing requirement", { requirement: undefined }, "requirement"],
      ["an invalid requirement", { requirement: { link: "x" } }, "requirement"],
      ["non-array outOfScope", { outOfScope: "x" }, "outOfScope"],
      ["non-array assumptions", { assumptions: "x" }, "assumptions"],
      ["ready with open questions", { openQuestions: [{ question: "?", options: [] }] }, "ready이면 openQuestions가 비어"],
      ["awaiting_answers without questions", { status: "awaiting_answers" }, "awaiting_answers이면"],
      ["an open question without question text", { status: "awaiting_answers", openQuestions: [{ options: [] }] }, "openQuestions[0].question"],
      ["an open question with non-array options", { status: "awaiting_answers", openQuestions: [{ question: "?", options: "x" }] }, "options"],
      ["empty stages", { stages: [] }, "stages"],
      ["an empty stage", { stages: [["n1", "n2"], []] }, "stages"],
      ["stages that are not arrays of arrays", { stages: ["n1"] }, "stages"],
      ["a missing nodes", { nodes: undefined }, "nodes"],
      ["a failing selfCheck", { selfCheck: [{ item: "겹침", result: "fail", detail: "겹친다" }] }, "자체 점검이 fail"],
      ["a selfCheck with an unknown result", { selfCheck: [{ item: "x", result: "ok", detail: "" }] }, "selfCheck[0].result"],
      ["a missing selfCheck", { selfCheck: undefined }, "selfCheck"],
    ];
    for (const [name, extra, expected] of fieldCases) {
      it(`rejects ${name}`, () => {
        expectProblem(check(plannerResult(extra)), expected);
      });
    }

    it("rejects an invalid node request, an unknown node agent and a node of another plan", () => {
      const invalid = plannerResult({ nodes: [w("n1", { acceptanceCriteria: [] }), w("n2"), r("r1", "n1"), r("r2", "n2")] });
      expectProblem(check(invalid), "nodes[0](n1): acceptanceCriteria");
      const planner = plannerResult({ nodes: [req("planner", "n1", { plan: "p1" }), w("n2"), r("r1", "n1"), r("r2", "n2")] });
      expectProblem(check(planner), "nodes[0](n1).agent");
      const otherPlan = plannerResult({ nodes: [w("n1", { plan: "p9" }), w("n2"), r("r1", "n1"), r("r2", "n2")] });
      expectProblem(check(otherPlan), "nodes[0](n1).plan");
    });

    it("rejects duplicate node ids", () => {
      const result = plannerResult({ nodes: [w("n1"), w("n1", { writes: ["src/z.ts"] }), r("r1", "n1")], stages: [["n1"], ["r1"]] });
      expectProblem(check(result), "중복");
    });

    it("rejects a node missing from the stages, in two stages, or a stage id that is not a node", () => {
      expectProblem(check(plannerResult({ stages: [["n1"], ["r1", "r2"]] })), "노드 n2가 어떤 단계에도 없다");
      expectProblem(check(plannerResult({ stages: [["n1", "n2"], ["r1", "r2"], ["n1"]] })), "정확히 한 단계");
      expectProblem(check(plannerResult({ stages: [["n1", "n2"], ["r1", "r2", "ghost"]] })), "nodes에 없는 id");
    });

    it("rejects a dependsOn that is unknown, self, same-stage, later or cyclic", () => {
      const withDeps = (deps) => plannerResult({ nodes: [w("n1", { dependsOn: deps.n1 }), w("n2", { dependsOn: deps.n2 ?? [] }), r("r1", "n1"), r("r2", "n2")] });
      expectProblem(check(withDeps({ n1: ["ghost"] })), "nodes에 없는 id");
      expectProblem(check(withDeps({ n1: ["n1"] })), "자기 자신");
      expectProblem(check(withDeps({ n1: ["n2"] })), "엄격히 앞선 단계");
      expectProblem(check(withDeps({ n1: ["r1"] })), "엄격히 앞선 단계");
      expectProblem(check(withDeps({ n1: ["n2"], n2: ["n1"] })), "엄격히 앞선 단계");
    });

    it("accepts a dependsOn on an earlier stage", () => {
      const result = plannerResult({
        stages: [["n1"], ["r1", "n2"], ["r2"]],
        nodes: [w("n1"), w("n2", { dependsOn: ["n1"] }), r("r1", "n1"), r("r2", "n2")],
      });
      assert.deepEqual(check(result), []);
    });

    it("rejects an exclusive worker that shares its stage", () => {
      const result = plannerResult({
        nodes: [w("n1", { writes: [], exclusive: true }), w("n2"), r("r1", "n1"), r("r2", "n2")],
      });
      expectProblem(check(result), "exclusive worker n1");
    });

    it("rejects overlapping writes of workers in the same stage", () => {
      const sameFile = plannerResult({ nodes: [w("n1", { writes: ["src/a.ts"] }), w("n2", { writes: ["src/a.ts"] }), r("r1", "n1"), r("r2", "n2")] });
      expectProblem(check(sameFile), "writes가 겹친다");
      const dirContains = plannerResult({ nodes: [w("n1", { writes: ["src/**"] }), w("n2", { writes: ["src/sub/a.ts"] }), r("r1", "n1"), r("r2", "n2")] });
      expectProblem(check(dirContains), "writes가 겹친다");
      const nestedDirs = plannerResult({ nodes: [w("n1", { writes: ["src/sub/**"] }), w("n2", { writes: ["src/**"] }), r("r1", "n1"), r("r2", "n2")] });
      expectProblem(check(nestedDirs), "writes가 겹친다");
    });

    it("does not treat sibling paths as overlapping and ignores different stages", () => {
      const siblings = plannerResult({ nodes: [w("n1", { writes: ["src/a/**"] }), w("n2", { writes: ["src/ab.ts"] }), r("r1", "n1"), r("r2", "n2")] });
      assert.deepEqual(check(siblings), []);
      const serial = plannerResult({
        stages: [["n1"], ["r1", "n2"], ["r2"]],
        nodes: [w("n1", { writes: ["src/a.ts"] }), w("n2", { writes: ["src/a.ts"], dependsOn: ["n1"] }), r("r1", "n1"), r("r2", "n2")],
      });
      assert.deepEqual(check(serial), []);
    });

    it("resolves relative writes against root, so an absolute path can overlap", () => {
      const nodes = [w("n1", { writes: ["src/a.ts"] }), w("n2", { writes: ["/repo/src/**"] }), r("r1", "n1"), r("r2", "n2")];
      assert.deepEqual(check(plannerResult({ nodes })), []);
      expectProblem(check(plannerResult({ nodes }), { root: "/repo" }), "writes가 겹친다");
    });

    it("rejects a worker without a later reviewer", () => {
      const missing = plannerResult({ stages: [["n1", "n2"], ["r1"]], nodes: [w("n1"), w("n2"), r("r1", "n1")] });
      expectProblem(check(missing), "worker n2를 verifies하는 reviewer");
      const sameStage = plannerResult({ stages: [["n1", "n2", "r1", "r2"]], nodes: [w("n1"), w("n2"), r("r1", "n1", { dependsOn: [] }), r("r2", "n2", { dependsOn: [] })] });
      expectProblem(check(sameStage), "더 뒤 단계에 없다");
    });

    it("rejects a reviewer that verifies a non-worker or an unknown id", () => {
      const result = plannerResult({
        stages: [["n1", "q1"], ["r1", "r2"]],
        nodes: [w("n1"), req("researcher", "q1"), r("r1", "n1"), r("r2", "q1")],
      });
      expectProblem(check(result), "reviewer r2의 verifies");
      expectProblem(
        check(plannerResult({ nodes: [w("n1"), w("n2"), r("r1", "n1"), r("r2", "ghost", { dependsOn: [] })] })),
        "reviewer r2의 verifies",
      );
    });
  });
});
