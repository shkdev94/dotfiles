// Stop / SubagentStop / PreToolUse(SubagentHandback): typecheck the TS files this agent edited with the
// project's own tsc. Blocks the stop while the edited files still have type errors, up to MAX_BLOCKS times
// per agent. A SubagentStop block after the subagent delivered its final report (SubagentHandback) does not
// resume it, so the same check runs as a PreToolUse deny on SubagentHandback, before the report is sent.
// Repeating the same diagnostics as the previous block means the agent chose not to fix them (for example
// errors that predate its edits), so that stop passes.
// Files are recorded by lint-on-edit.mjs.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import {
  clearState,
  findBin,
  readBlockCount,
  readEditedFiles,
  readLastSignature,
  searchDirs,
  statePaths,
  stripAnsi,
  truncate,
  writeBlockCount,
  writeLastSignature,
} from "./project-tools.mjs";
import { preToolUseOutput, runJsonHook } from "./run-hook.mjs";

const HANDBACK_TOOL = "SubagentHandback";
const MAX_BLOCKS = 3;
const TSC_TIMEOUT_MS = 240_000;
// Stay under the 300s hook timeout in settings.json.
const TOTAL_BUDGET_MS = 280_000;
const MAX_BUFFER = 256 * 1024 * 1024;
const REASON_LIMIT = 6000;
// How deep `references` of a solution-style tsconfig are followed.
const MAX_REFERENCE_DEPTH = 5;

// path(line,col): error TSxxxx: message
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
// "Output file ... has not been built from source file": a referenced project is not built, not a code error.
const IGNORED_CODES = new Set(["TS6305"]);

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

// Removes comments and trailing commas (outside strings) so tsconfig's JSONC parses as JSON.
// Returns null when the result still is not valid JSON.
export function parseJsonc(text) {
  const source = text.replace(/^\uFEFF/, "");

  const stripComments = () => {
    let out = "";
    for (let i = 0; i < source.length; ) {
      const char = source[i];
      if (char === '"') {
        const end = stringEnd(source, i);
        out += source.slice(i, end);
        i = end;
      } else if (char === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") {
          i += 1;
        }
      } else if (char === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? source.length : end + 2;
      } else {
        out += char;
        i += 1;
      }
    }
    return out;
  };

  const stripTrailingCommas = (input) => {
    let out = "";
    for (let i = 0; i < input.length; ) {
      const char = input[i];
      if (char === '"') {
        const end = stringEnd(input, i);
        out += input.slice(i, end);
        i = end;
      } else if (char === ",") {
        let next = i + 1;
        while (next < input.length && /\s/.test(input[next])) {
          next += 1;
        }
        if (input[next] !== "}" && input[next] !== "]") {
          out += char;
        }
        i += 1;
      } else {
        out += char;
        i += 1;
      }
    }
    return out;
  };

  try {
    return JSON.parse(stripTrailingCommas(stripComments()));
  } catch {
    return null;
  }
}

// Index just past the string literal that starts at `start`.
function stringEnd(text, start) {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    i += text[i] === "\\" ? 2 : 1;
  }
  return Math.min(i + 1, text.length);
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

function typecheck(tsconfig, editedFiles, timeout) {
  const cwd = dirname(tsconfig);
  const tsc = findBin(cwd, "tsc");
  if (tsc === null) {
    return [];
  }

  const result = spawnSync(tsc.bin, ["--noEmit", "--pretty", "false", "-p", tsconfig], {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  // Timeouts and spawn failures say nothing about the code, so they do not block.
  if (result.error !== undefined || result.status === null || result.status === 0) {
    return [];
  }

  const edited = new Set(editedFiles.map(realOrResolved));
  return parseDiagnostics(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, cwd).filter(
    (diagnostic) => edited.has(diagnostic.file) && !IGNORED_CODES.has(diagnostic.code),
  );
}

function formatReason(diagnostics, cwd, beforeHandback) {
  const byFile = new Map();
  for (const diagnostic of diagnostics) {
    byFile.set(diagnostic.file, [...(byFile.get(diagnostic.file) ?? []), diagnostic]);
  }

  const sections = [...byFile].map(([file, items]) => {
    const lines = items.map((item) => `- (${item.line},${item.column}) ${item.code}: ${item.message}`);
    return `${relative(cwd, file) || file}\n${lines.join("\n")}`;
  });
  const fix = beforeHandback ? "보고 전에 이번 변경으로 생긴 오류는 고친다." : "이번 변경으로 생긴 오류는 고친다.";
  return `이번에 편집한 파일에 타입 오류가 있다. ${fix} 원래 있던 오류는 작업 범위 밖이면 고치지 말고 보고에 남긴다.\n\n${truncate(sections.join("\n\n"), REASON_LIMIT)}`;
}

function diagnosticKey(diagnostic) {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.code}:${diagnostic.message}`;
}

function uniqueDiagnostics(diagnostics) {
  return [...new Map(diagnostics.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic])).values()];
}

// Same file, line, code and message set gives the same signature.
function signatureOf(diagnostics) {
  const keys = diagnostics.map(diagnosticKey).sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

// Reason to keep the agent working, or null to let it stop.
function check(input, stateDir, beforeHandback) {
  const paths = statePaths(input, stateDir);
  const files = readEditedFiles(paths).filter((file) => existsSync(file));
  if (files.length === 0) {
    clearState(paths);
    return null;
  }

  // Give up after repeated blocks so an unfixable error cannot trap the agent.
  const blocks = readBlockCount(paths);
  if (blocks >= MAX_BLOCKS) {
    clearState(paths);
    return null;
  }

  const tsconfigs = new Set();
  for (const file of files) {
    const tsconfig = findTsconfig(file);
    if (tsconfig !== null) {
      tsconfigs.add(tsconfig);
    }
  }

  // A solution-style tsconfig (`files: []` plus `references`) checks nothing itself, so its projects run too.
  const visited = new Set();
  const projects = [...tsconfigs].flatMap((tsconfig) => collectProjects(tsconfig, visited));

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const collected = [];
  for (const project of projects) {
    const timeout = Math.min(TSC_TIMEOUT_MS, deadline - Date.now());
    if (timeout <= 0) {
      break;
    }
    collected.push(...typecheck(project, files, timeout));
  }
  const diagnostics = uniqueDiagnostics(collected);

  if (diagnostics.length === 0) {
    clearState(paths);
    return null;
  }

  // Unchanged since the last block: the agent decided to leave them, so stop blocking.
  const signature = signatureOf(diagnostics);
  if (readLastSignature(paths) === signature) {
    clearState(paths);
    return null;
  }

  writeBlockCount(paths, blocks + 1);
  writeLastSignature(paths, signature);
  return formatReason(diagnostics, input.cwd ?? process.cwd(), beforeHandback);
}

// Stop / SubagentStop: { decision: "block", reason }. PreToolUse on SubagentHandback: a deny output.
export function evaluate(input, { stateDir } = {}) {
  if (input.hook_event_name === "PreToolUse") {
    if (input.tool_name !== HANDBACK_TOOL) {
      return null;
    }
    const reason = check(input, stateDir, true);
    return reason === null ? null : preToolUseOutput({ decision: "deny", reason });
  }

  const reason = check(input, stateDir, false);
  return reason === null ? null : { decision: "block", reason };
}

runJsonHook((input) => evaluate(input), import.meta.url);
