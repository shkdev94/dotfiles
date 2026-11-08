// PostToolUse: lint the edited JS/TS file with the project's own linters and report failures to Claude.
// Only `node_modules/.bin` tools of the project are run, so projects without linters pass silently.
// Edited TS files are also recorded for typecheck-on-stop.mjs.
import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, extname, resolve } from "node:path";
import { findBin, findConfigDir, recordEditedFile, statePaths, stripAnsi, truncate } from "./project-tools.mjs";
import { runJsonHook } from "./run-hook.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const SCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
// Only ESLint (with a config) lints these.
const FRAMEWORK_EXTENSIONS = new Set([".vue", ".svelte"]);
// Files tsc checks without extra compiler options.
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

const LINT_TIMEOUT_MS = 45_000;
// Stay under the 60s hook timeout in settings.json.
const TOTAL_BUDGET_MS = 55_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const OUTPUT_LIMIT = 4000;

const ESLINT_CONFIGS = [
  ...["js", "mjs", "cjs", "ts", "mts", "cts"].map((ext) => `eslint.config.${ext}`),
  ".eslintrc",
  ...["js", "cjs", "json", "yaml", "yml"].map((ext) => `.eslintrc.${ext}`),
];

// `requiresConfig`: skip unless a config file exists (ESLint without config only errors out).
// `passExitCodes`: exit codes that mean the linter itself failed (not the edited code), so they do not block.
// cwd is the config directory, falling back to the project that owns the binary.
const LINTERS = [
  {
    name: "ESLint",
    tool: "eslint",
    configs: ESLINT_CONFIGS,
    requiresConfig: true,
    // ESLint exits 2 for configuration and internal errors.
    passExitCodes: [2],
    extensions: new Set([...SCRIPT_EXTENSIONS, ...FRAMEWORK_EXTENSIONS]),
    args: (file) => [file],
  },
  {
    name: "Biome",
    tool: "biome",
    configs: ["biome.json", "biome.jsonc"],
    requiresConfig: false,
    extensions: SCRIPT_EXTENSIONS,
    // lint only; formatting differences are not worth blocking on
    args: (file) => ["lint", "--no-errors-on-unmatched", "--files-ignore-unknown=true", file],
  },
  {
    name: "oxlint",
    tool: "oxlint",
    configs: [".oxlintrc.json", "oxlint.config.ts"],
    requiresConfig: false,
    extensions: SCRIPT_EXTENSIONS,
    // ignorePatterns matches would otherwise end with "No files found to lint" and exit 1
    args: (file) => ["--no-error-on-unmatched-pattern", file],
  },
];

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Linters that apply to `file`, with the cwd to run each in.
function detectLinters(file, extension) {
  const dir = dirname(file);
  const detected = [];

  for (const linter of LINTERS) {
    if (!linter.extensions.has(extension)) {
      continue;
    }
    const bin = findBin(dir, linter.tool);
    const configDir = findConfigDir(dir, linter.configs);
    if (bin === null || (linter.requiresConfig && configDir === null)) {
      continue;
    }
    detected.push({ linter, bin: bin.bin, cwd: configDir ?? bin.root });
  }

  return detected;
}

function runLinter({ linter, bin, cwd }, file, timeout) {
  const result = spawnSync(bin, linter.args(file), {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });

  // Timeouts, spawn failures and linter-internal errors say nothing about the code, so they do not block.
  if (
    result.error !== undefined ||
    result.status === null ||
    result.status === 0 ||
    (linter.passExitCodes ?? []).includes(result.status)
  ) {
    return null;
  }

  const output = stripAnsi(`${result.stdout ?? ""}${result.stderr ?? ""}`).trim();
  return { name: linter.name, status: result.status, output: truncate(output, OUTPUT_LIMIT) };
}

export function evaluate(input, { stateDir } = {}) {
  const filePath = input.tool_input?.file_path;
  if (!EDIT_TOOLS.has(input.tool_name) || typeof filePath !== "string") {
    return null;
  }

  const file = resolve(input.cwd ?? process.cwd(), filePath);
  const extension = extname(file).toLowerCase();
  if (!(SCRIPT_EXTENSIONS.has(extension) || FRAMEWORK_EXTENSIONS.has(extension)) || !isFile(file)) {
    return null;
  }

  // Recorded regardless of linters so the Stop hook can typecheck it.
  if (TS_EXTENSIONS.has(extension)) {
    recordEditedFile(statePaths(input, stateDir), file);
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const failures = [];
  for (const detected of detectLinters(file, extension)) {
    const timeout = Math.min(LINT_TIMEOUT_MS, deadline - Date.now());
    if (timeout <= 0) {
      break;
    }
    const failure = runLinter(detected, file, timeout);
    if (failure !== null) {
      failures.push(failure);
    }
  }

  if (failures.length === 0) {
    return null;
  }

  const sections = failures.map(({ name, status, output }) => `[${name}] exit ${status}\n${output}`);
  return {
    decision: "block",
    reason: `${file} 편집 후 프로젝트 린터가 오류를 보고했다. 이번 변경으로 생긴 오류는 고친다. 원래 있던 오류는 작업 범위 밖이면 고치지 말고 보고에 남긴다.\n\n${sections.join("\n\n")}`,
  };
}

runJsonHook((input) => evaluate(input), import.meta.url);
