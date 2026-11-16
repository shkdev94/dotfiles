// Stop / SubagentStop / PreToolUse(SubagentHandback): check the JS/TS/Vue/Svelte files this agent edited
// with the project's own tools. Format runs first and rewrites the files; then lint, typecheck (tsc, only
// where package.json declares typescript) and the related tests run in parallel and are handed back as one
// reason. Format never blocks. Each other
// kind (lint, typecheck, test) blocks the stop up to MAX_BLOCKS times per agent, on every event alike; a
// kind that reached the limit is not run again. A SubagentStop block after the subagent delivered its
// final report (SubagentHandback) does not resume it, so the same check runs as a PreToolUse deny on
// SubagentHandback, before the report is sent.
// Timeouts, runs skipped for lack of time, spawn failures and tool errors say nothing about the code, so
// they never block. They are sent once as factual lines in additionalContext (Stop, SubagentStop) or as one
// deny (SubagentHandback) whose reason also asks to call SubagentHandback again.
// Files the formatters changed are listed first in whatever is sent (reason, additionalContext, deny) so the
// agent reads them again before editing; when nothing else is sent, a format alone sends nothing, because
// additionalContext would make the agent continue.
// CLAUDE_HOOKS_SKIP_TESTS=1 skips the test kind only.
// Files are recorded by record-edit.mjs.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  clearState,
  declaresPackage,
  findBin,
  parseJsonc,
  readBlockCount,
  readEditedFiles,
  readNotified,
  searchDirs,
  spawnAsync,
  statePaths,
  stripAnsi,
  truncate,
  writeBlockCount,
  writeNotified,
} from "./project-tools.mjs";
import { DEFAULT_FORMAT_TIMEOUT_MS, DEFAULT_LINT_TIMEOUT_MS, runFormat, runLint } from "./lint-format.mjs";
import { preToolUseOutput, runJsonHook } from "./run-hook.mjs";
import { runTests } from "./test-runners.mjs";

// Kept here for the callers that import it from this module.
export { parseJsonc };

const HANDBACK_TOOL = "SubagentHandback";
const MAX_BLOCKS = 3;
const DEFAULT_TIMEOUTS = {
  // One formatter run.
  format: DEFAULT_FORMAT_TIMEOUT_MS,
  // One lint run.
  lint: DEFAULT_LINT_TIMEOUT_MS,
  // One tsc run.
  tsc: 240_000,
  // One test run.
  test: 120_000,
  // Everything together; stays under the 300s hook timeout in settings.json.
  total: 280_000,
};
const MAX_BUFFER = 256 * 1024 * 1024;
const REASON_LIMIT = 6000;
const DETAIL_LIMIT = 500;
// How deep `references` of a solution-style tsconfig are followed.
const MAX_REFERENCE_DEPTH = 5;

// Files edited for tsc: TS, and JS (tsc reports on JS only where the project enables checkJs; otherwise
// the run finds nothing in them). .vue and .svelte are not checked by tsc.
const TSC_FILE = /\.[cm]?[jt]sx?$/;
// Files the test kind may relate to tests.
const TESTABLE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const LAST_CHECK = "이번이 마지막 확인이다. 고치지 못하면 원인을 보고에 남겨라.";

// path(line,col): error TSxxxx: message
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
// "Output file ... has not been built from source file": a referenced project is not built, not a code error.
const IGNORED_CODES = new Set(["TS6305"]);
// "No inputs were found in config file": the project has no file tsc could check, e.g. only JS files without allowJs.
const NO_INPUTS_CODE = "TS18003";
// Any error line, with or without a file location.
const ERROR_CODE = /\berror (TS\d+):/g;

function realOrResolved(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function findTsconfig(file) {
  const dir = searchDirs(dirname(file)).find((candidate) => existsSync(join(candidate, "tsconfig.json")));
  return dir === undefined ? null : join(dir, "tsconfig.json");
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// tsconfig files of the `references` entries: a directory means its tsconfig.json.
function referencedConfigs(tsconfig) {
  let config;
  try {
    config = parseJsonc(readFileSync(tsconfig, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(config?.references)) {
    return [];
  }

  const baseDir = dirname(tsconfig);
  const configs = [];
  for (const reference of config.references) {
    if (typeof reference?.path !== "string") {
      continue;
    }
    const target = resolve(baseDir, reference.path);
    const candidate = isDirectory(target) || !target.endsWith(".json") ? join(target, "tsconfig.json") : target;
    if (existsSync(candidate)) {
      configs.push(candidate);
    }
  }
  return configs;
}

// `tsconfig` plus the projects it references, recursively. `visited` is shared so no project runs twice.
function collectProjects(tsconfig, visited, depth = 0) {
  const key = realOrResolved(tsconfig);
  if (visited.has(key)) {
    return [];
  }
  visited.add(key);

  const projects = [tsconfig];
  if (depth < MAX_REFERENCE_DEPTH) {
    for (const reference of referencedConfigs(tsconfig)) {
      projects.push(...collectProjects(reference, visited, depth + 1));
    }
  }
  return projects;
}

// Diagnostics with their indented continuation lines folded in. Paths resolve against cwd.
export function parseDiagnostics(output, cwd) {
  const diagnostics = [];
  let current = null;
  for (const line of stripAnsi(output).split("\n")) {
    const match = DIAGNOSTIC.exec(line);
    if (match !== null) {
      current = {
        file: realOrResolved(resolve(cwd, match[1])),
        line: Number(match[2]),
        column: Number(match[3]),
        code: match[4],
        message: match[5],
      };
      diagnostics.push(current);
    } else if (current !== null && /^\s+\S/.test(line)) {
      current.message += `\n${line.trimEnd()}`;
    } else {
      current = null;
    }
  }
  return diagnostics;
}

function diagnosticKey(diagnostic) {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.code}:${diagnostic.message}`;
}

function uniqueDiagnostics(diagnostics) {
  return [...new Map(diagnostics.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic])).values()];
}

function noticeOf(kind, tool, type, { seconds, skipped, detail } = {}) {
  return {
    kind,
    tool,
    type,
    seconds,
    skipped,
    detail: detail === undefined ? undefined : truncate(detail.trim(), DETAIL_LIMIT),
  };
}

// True when every error in the output is TS18003.
function hasOnlyNoInputsError(output) {
  const codes = new Set([...stripAnsi(output).matchAll(ERROR_CODE)].map((match) => match[1]));
  return codes.size > 0 && [...codes].every((code) => code === NO_INPUTS_CODE);
}

// One tsc run: { diagnostics, notices }. Diagnostics are limited to the edited files.
async function typecheck(tsconfig, editedFiles, timeout, env) {
  const cwd = dirname(tsconfig);
  const tsc = findBin(cwd, "tsc");
  if (tsc === null) {
    return { diagnostics: [], notices: [] };
  }

  const result = await spawnAsync(tsc.bin, ["--noEmit", "--pretty", "false", "-p", tsconfig], {
    cwd,
    env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
    timeout,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error !== undefined) {
    return { diagnostics: [], notices: [noticeOf("typecheck", "tsc", "spawn", { detail: result.error.message })] };
  }
  if (result.timedOut) {
    return { diagnostics: [], notices: [noticeOf("typecheck", "tsc", "timeout", { seconds: timeout / 1000 })] };
  }
  if (result.status === null) {
    return {
      diagnostics: [],
      notices: [noticeOf("typecheck", "tsc", "tool", { detail: `signal ${result.signal ?? "unknown"}` })],
    };
  }
  if (result.status === 0) {
    return { diagnostics: [], notices: [] };
  }

  const output = `${result.stdout}\n${result.stderr}`;
  const parsed = parseDiagnostics(output, cwd);
  // tsc failed without saying anything about a file: it could not check, which is not a type error.
  if (parsed.length === 0) {
    // The project has no input for tsc (a JS file edited where allowJs is off): nothing was left unchecked.
    if (hasOnlyNoInputsError(output)) {
      return { diagnostics: [], notices: [] };
    }
    return {
      diagnostics: [],
      notices: [noticeOf("typecheck", "tsc", "tool", { detail: stripAnsi(output).trim() || `exit ${result.status}` })],
    };
  }

  const edited = new Set(editedFiles.map(realOrResolved));
  return {
    diagnostics: parsed.filter((diagnostic) => edited.has(diagnostic.file) && !IGNORED_CODES.has(diagnostic.code)),
    notices: [],
  };
}

// The typecheck kind: tsc for the projects of the edited TS/JS files, one after another. A file is checked
// only when the nearest declaring package.json lists `typescript` (dependencies/devDependencies).
async function runTypecheck(files, { env, deadline, timeouts }) {
  const tscFiles = files.filter((file) => TSC_FILE.test(file));
  const tsconfigs = new Set();
  for (const file of tscFiles) {
    if (!declaresPackage(dirname(file), "typescript")) {
      continue;
    }
    const tsconfig = findTsconfig(file);
    if (tsconfig !== null) {
      tsconfigs.add(tsconfig);
    }
  }

  // A solution-style tsconfig (`files: []` plus `references`) checks nothing itself, so its projects run too.
  const visited = new Set();
  const projects = [...tsconfigs].flatMap((tsconfig) => collectProjects(tsconfig, visited));

  const collected = [];
  const notices = [];
  for (const project of projects) {
    const timeout = Math.min(timeouts.tsc, deadline - Date.now());
    if (timeout <= 0) {
      if (findBin(dirname(project), "tsc") !== null) {
        notices.push(noticeOf("typecheck", "tsc", "timeout", { skipped: true }));
      }
      break;
    }
    const result = await typecheck(project, tscFiles, timeout, env);
    collected.push(...result.diagnostics);
    notices.push(...result.notices);
  }
  return { diagnostics: uniqueDiagnostics(collected), notices };
}

// The test kind: tests related to the edited files, with the project's own runner.
async function runTestKind(files, { env, deadline, timeouts }) {
  const testable = files.filter((file) => TESTABLE_FILE.test(file));
  if (env.CLAUDE_HOOKS_SKIP_TESTS === "1" || testable.length === 0) {
    return { failures: [], notices: [] };
  }

  const { failures, notices } = await runTests(testable, { env, deadline, timeoutMs: timeouts.test });
  return {
    failures,
    notices: notices.map((notice) =>
      noticeOf("test", notice.name, notice.type, {
        seconds: notice.seconds,
        skipped: notice.skipped,
        detail: notice.detail,
      }),
    ),
  };
}

// Notices from lint-format.mjs ({ tool, type, seconds, skipped, detail }) as notices of `kind`.
function noticesOf(kind, notices) {
  return notices.map((notice) =>
    noticeOf(kind, notice.tool, notice.type, {
      seconds: notice.seconds,
      skipped: notice.skipped,
      detail: notice.detail,
    }),
  );
}

// The format kind: the project's first detected formatter (oxfmt, Biome, Prettier) per edited file. Never blocks.
async function runFormatKind(files, { env, deadline, timeouts }) {
  const { changed, notices } = await runFormat(files, { env, deadline, timeoutMs: timeouts.format });
  return { changed, notices: noticesOf("format", notices) };
}

// The lint kind: the project's first detected linter (oxlint, ESLint, Biome) per edited file.
async function runLintKind(files, { env, deadline, timeouts }) {
  const { failures, notices } = await runLint(files, { env, deadline, timeoutMs: timeouts.lint });
  return { failures, notices: noticesOf("lint", notices) };
}

function noticeKey(notice) {
  return `${notice.kind}:${notice.tool}:${notice.type}`;
}

// Whole seconds, at least 1, for tsc and test timeouts alike.
function displaySeconds(seconds) {
  return Math.max(1, Math.round(seconds));
}

// A factual statement; additionalContext carries it as is.
function noticeMessage(notice) {
  // A formatter that did not run leaves files unformatted, not unverified.
  const action = notice.kind === "format" ? "포맷하지" : "검증하지";
  if (notice.skipped) {
    return `남은 시간이 없어 ${notice.tool}를 실행하지 못했다.`;
  }
  switch (notice.type) {
    case "timeout":
      return `${notice.tool}가 ${displaySeconds(notice.seconds)}초 안에 끝나지 않아 ${action} 못했다.`;
    case "spawn":
      return `${notice.tool}를 실행하지 못해 ${action} 못했다: ${notice.detail ?? ""}`;
    default:
      return `${notice.tool}가 결과를 내지 못하고 끝나 ${action} 못했다: ${notice.detail ?? ""}`;
  }
}

// Files a formatter changed, relative to `cwd`.
function formatSection(changed, cwd) {
  const lines = changed.map((file) => `- ${relative(cwd, file) || file}`);
  return `[포맷]\n프로젝트 포맷터가 다음 파일을 자동으로 정리했다. 편집하기 전에 다시 읽는다.\n${lines.join("\n")}`;
}

function lintSection(failures, beforeHandback, lastCheck) {
  const fix = beforeHandback ? "보고 전에 이번 변경으로 생긴 오류는 고친다." : "이번 변경으로 생긴 오류는 고친다.";
  const head = `[린트]\n이번에 편집한 파일에 프로젝트 린터가 오류를 보고했다. ${fix} 원래 있던 오류는 작업 범위 밖이면 고치지 말고 보고에 남긴다.`;
  const body = failures.map(({ name, status, output }) => `[${name}] exit ${status}\n${output}`).join("\n\n");
  return `${head}\n\n${truncate(body, REASON_LIMIT)}${lastCheck ? `\n\n${LAST_CHECK}` : ""}`;
}

function typecheckSection(diagnostics, cwd, beforeHandback, lastCheck) {
  const byFile = new Map();
  for (const diagnostic of diagnostics) {
    byFile.set(diagnostic.file, [...(byFile.get(diagnostic.file) ?? []), diagnostic]);
  }

  const sections = [...byFile].map(([file, items]) => {
    const lines = items.map((item) => `- (${item.line},${item.column}) ${item.code}: ${item.message}`);
    return `${relative(cwd, file) || file}\n${lines.join("\n")}`;
  });
  const fix = beforeHandback ? "보고 전에 이번 변경으로 생긴 오류는 고친다." : "이번 변경으로 생긴 오류는 고친다.";
  const head = `[타입 검사]\n이번에 편집한 파일에 타입 오류가 있다. ${fix} 원래 있던 오류는 작업 범위 밖이면 고치지 말고 보고에 남긴다.`;
  return `${head}\n\n${truncate(sections.join("\n\n"), REASON_LIMIT)}${lastCheck ? `\n\n${LAST_CHECK}` : ""}`;
}

function testSection(failures, beforeHandback, lastCheck) {
  const fix = beforeHandback ? "보고 전에 이번 변경으로 생긴 실패는 고친다." : "이번 변경으로 생긴 실패는 고친다.";
  const head = `[테스트]\n이번에 편집한 파일과 관련된 테스트가 실패했다. ${fix} 테스트를 통과시키려고 기대값을 바꾸지 않는다. 테스트가 틀렸다고 판단하면 근거를 보고에 남긴다.`;
  const body = failures.map((failure) => `${failure.runner}\n${failure.text}`).join("\n\n");
  return `${head}\n\n${truncate(body, REASON_LIMIT)}${lastCheck ? `\n\n${LAST_CHECK}` : ""}`;
}

// Output for the event, or null to let the agent stop (or report).
async function check(input, { stateDir, env, timeouts }) {
  const beforeHandback = input.hook_event_name === "PreToolUse";
  const paths = statePaths(input, stateDir);
  const files = readEditedFiles(paths).filter((file) => existsSync(file));
  if (files.length === 0) {
    clearState(paths);
    return null;
  }

  // Format first: the other kinds then see the formatted files.
  const context = { env, deadline: Date.now() + timeouts.total, timeouts };
  const formatted = await runFormatKind(files, context);

  // A kind that reached its limit is not run again, so an unfixable failure cannot trap the agent.
  const lintBlocks = readBlockCount(paths.lintBlocksPath);
  const typecheckBlocks = readBlockCount(paths.typecheckBlocksPath);
  const testBlocks = readBlockCount(paths.testBlocksPath);
  const empty = { diagnostics: [], failures: [], notices: [] };
  const [linted, typed, tested] = await Promise.all([
    lintBlocks >= MAX_BLOCKS ? empty : runLintKind(files, context),
    typecheckBlocks >= MAX_BLOCKS ? empty : runTypecheck(files, context),
    testBlocks >= MAX_BLOCKS ? empty : runTestKind(files, context),
  ]);

  const lintFailures = linted.failures ?? [];
  const diagnostics = typed.diagnostics ?? [];
  const failures = tested.failures ?? [];
  const cwd = input.cwd ?? process.cwd();
  const formatLines = formatted.changed.length > 0 ? [formatSection(formatted.changed, cwd)] : [];

  const notified = readNotified(paths);
  const fresh = new Map();
  for (const notice of [...formatted.notices, ...linted.notices, ...typed.notices, ...tested.notices]) {
    if (!notified.has(noticeKey(notice))) {
      fresh.set(noticeKey(notice), notice);
    }
  }
  const noticeLines = [...fresh.values()].map((notice) => `- ${noticeMessage(notice)}`);

  if (lintFailures.length === 0 && diagnostics.length === 0 && failures.length === 0) {
    clearState(paths);
    // A format alone is not worth continuing the conversation for.
    if (noticeLines.length === 0) {
      return null;
    }
    if (beforeHandback) {
      const head = "다음 항목을 검증하지 못했다. 보고에 남기고 SubagentHandback을 다시 호출하라";
      return preToolUseOutput({
        decision: "deny",
        reason: [...formatLines, `${head}\n${noticeLines.join("\n")}`].join("\n\n"),
      });
    }
    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        additionalContext: [...formatLines, noticeLines.join("\n")].join("\n\n"),
      },
    };
  }

  const sections = [...formatLines];
  if (lintFailures.length > 0) {
    writeBlockCount(paths, paths.lintBlocksPath, lintBlocks + 1);
    sections.push(lintSection(lintFailures, beforeHandback, lintBlocks + 1 >= MAX_BLOCKS));
  }
  if (diagnostics.length > 0) {
    writeBlockCount(paths, paths.typecheckBlocksPath, typecheckBlocks + 1);
    sections.push(typecheckSection(diagnostics, cwd, beforeHandback, typecheckBlocks + 1 >= MAX_BLOCKS));
  }
  if (failures.length > 0) {
    writeBlockCount(paths, paths.testBlocksPath, testBlocks + 1);
    sections.push(testSection(failures, beforeHandback, testBlocks + 1 >= MAX_BLOCKS));
  }
  if (noticeLines.length > 0) {
    writeNotified(paths, new Set([...notified, ...fresh.keys()]));
    sections.push(`[검증하지 못한 항목]\n다음 항목은 검증하지 못했다. 보고에 남긴다.\n${noticeLines.join("\n")}`);
  }

  const reason = sections.join("\n\n");
  return beforeHandback ? preToolUseOutput({ decision: "deny", reason }) : { decision: "block", reason };
}

// Stop / SubagentStop: { decision: "block", reason } or additionalContext. PreToolUse on SubagentHandback: a deny.
// `env` and `timeouts` exist for tests.
export async function evaluate(input, { stateDir, env = process.env, timeouts = {} } = {}) {
  if (input.hook_event_name === "PreToolUse" && input.tool_name !== HANDBACK_TOOL) {
    return null;
  }
  return check(input, { stateDir, env, timeouts: { ...DEFAULT_TIMEOUTS, ...timeouts } });
}

runJsonHook((input) => evaluate(input), import.meta.url);
