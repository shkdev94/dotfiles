// Format and lint for check-on-stop.mjs, with the project's own tools from `node_modules/.bin`.
// Both work on the JS/TS/Vue/Svelte files an agent edited (recorded by record-edit.mjs).
// Each file gets only the first tool that is detected for it, in priority order: oxfmt, Biome, Prettier
// for format; oxlint, ESLint, Biome for lint. A lower-priority tool never touches a file that a
// higher-priority one handles; it is used only for files the higher one is not detected for.
// A tool is detected only when a package.json declares it in dependencies/devDependencies. The nearest
// package.json (from the file upward) that declares any tool of that kind decides: only the tools it declares
// are candidates. A config file or a bin without a declaration never selects a tool. Format never blocks.
// Format runs first, one run after another. Lint runs after format, one run per (linter, cwd) with all of
// its files, the runs at the same time.
// Timeouts, spawn failures and tool errors say nothing about the code; they come back as notices.
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import {
  FRAMEWORK_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  findBin,
  findConfigDir,
  nearestDeclared,
  parseJsonc,
  spawnAsync,
  stripAnsi,
  truncate,
} from "./project-tools.mjs";

export const DEFAULT_FORMAT_TIMEOUT_MS = 30_000;
export const DEFAULT_LINT_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 4000;

const ESLINT_CONFIGS = [
  ...["js", "mjs", "cjs", "ts", "mts", "cts"].map((ext) => `eslint.config.${ext}`),
  ".eslintrc",
  ...["js", "cjs", "json", "yaml", "yml"].map((ext) => `.eslintrc.${ext}`),
];
// Biome reads them in this order.
const BIOME_CONFIGS = ["biome.json", "biome.jsonc", ".biome.json", ".biome.jsonc"];
const OXFMT_CONFIGS = [".oxfmtrc.json", ".oxfmtrc.jsonc", "oxfmt.config.ts", "oxfmt.config.mts"];
const PRETTIER_CONFIGS = [
  ".prettierrc",
  ...["json", "yml", "yaml", "json5", "js", "mjs", "cjs", "ts", "mts", "cts", "toml"].map(
    (ext) => `.prettierrc.${ext}`,
  ),
  ...["js", "mjs", "cjs", "ts", "mts", "cts"].map((ext) => `prettier.config.${ext}`),
];

const ALL_EXTENSIONS = new Set([...SCRIPT_EXTENSIONS, ...FRAMEWORK_EXTENSIONS]);

// `requiresConfig`: skip unless a config file exists (ESLint without config only errors out).
// `passExitCodes`: exit codes that mean the linter itself failed (not the edited code), so they do not block.
// cwd is the config directory, falling back to the project that owns the binary.
// `packageName`: dependency that declares the tool; only a declared linter is a candidate.
// In priority order: the first one detected for a file lints it.
const LINTERS = [
  {
    name: "oxlint",
    tool: "oxlint",
    packageName: "oxlint",
    configs: [".oxlintrc.json", "oxlint.config.ts"],
    requiresConfig: false,
    extensions: SCRIPT_EXTENSIONS,
    // ignorePatterns matches would otherwise end with "No files found to lint" and exit 1
    args: (files) => ["--no-error-on-unmatched-pattern", ...files],
  },
  {
    name: "ESLint",
    tool: "eslint",
    packageName: "eslint",
    configs: ESLINT_CONFIGS,
    requiresConfig: true,
    // ESLint exits 2 for configuration and internal errors.
    passExitCodes: [2],
    extensions: ALL_EXTENSIONS,
    args: (files) => [...files],
  },
  {
    name: "Biome",
    tool: "biome",
    packageName: "@biomejs/biome",
    configs: BIOME_CONFIGS,
    requiresConfig: false,
    extensions: SCRIPT_EXTENSIONS,
    // lint only; formatting is the format kind's job
    args: (files) => ["lint", "--no-errors-on-unmatched", "--files-ignore-unknown=true", ...files],
  },
];

// In priority order: the first one detected for a file formats it. `packageName`: dependency that declares
// the tool; only a declared formatter is a candidate (a config file alone, or a `prettier` key in package.json
// alone, does not select it). `cwd` is "config" (the config directory, else the bin root) or "root" (the bin root).
// `enabled(configDir)` is false when the project's config turns the formatter off.
const FORMATTERS = [
  {
    name: "oxfmt",
    tool: "oxfmt",
    configs: OXFMT_CONFIGS,
    packageName: "oxfmt",
    // .svelte needs Prettier behind oxfmt plus an option, so it is left to Prettier.
    extensions: new Set([...SCRIPT_EXTENSIONS, ".vue"]),
    cwd: "root",
    // Writes in place by default.
    args: (files) => ["--no-error-on-unmatched-pattern", ...files],
  },
  {
    name: "Biome",
    tool: "biome",
    configs: BIOME_CONFIGS,
    packageName: "@biomejs/biome",
    extensions: ALL_EXTENSIONS,
    cwd: "config",
    // `biome check --write` would also apply lint fixes; only `format` is used.
    args: (files) => ["format", "--write", "--no-errors-on-unmatched", "--files-ignore-unknown=true", ...files],
    enabled: (configDir) => configDir === null || biomeFormatterEnabled(configDir),
  },
  {
    name: "Prettier",
    tool: "prettier",
    configs: PRETTIER_CONFIGS,
    packageName: "prettier",
    extensions: ALL_EXTENSIONS,
    cwd: "root",
    // Files without a parser (.svelte without its plugin) are ignored, as are unmatched patterns.
    args: (files) => ["--write", "--ignore-unknown", "--no-error-on-unmatched-pattern", ...files],
  },
];

function biomeFormatterEnabled(configDir) {
  const name = BIOME_CONFIGS.find((candidate) => readText(join(configDir, candidate)) !== null);
  const config = name === undefined ? null : parseJsonc(readText(join(configDir, name)));
  return config?.formatter?.enabled !== false;
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// The first formatter (FORMATTERS order) that applies to `file`: { formatter, bin, cwd }, or null.
// Only formatters declared by the nearest declaring package.json are candidates.
function detectFormatter(file) {
  const dir = dirname(file);
  const extension = extname(file).toLowerCase();
  const declared = nearestDeclared(
    dir,
    FORMATTERS.map((formatter) => formatter.packageName),
  );

  for (const formatter of FORMATTERS) {
    if (!declared.has(formatter.packageName) || !formatter.extensions.has(extension)) {
      continue;
    }
    const bin = findBin(dir, formatter.tool);
    if (bin === null) {
      continue;
    }
    const configDir = findConfigDir(dir, formatter.configs);
    if (formatter.enabled !== undefined && !formatter.enabled(configDir)) {
      continue;
    }
    return { formatter, bin: bin.bin, cwd: formatter.cwd === "config" ? (configDir ?? bin.root) : bin.root };
  }
  return null;
}

// The first linter (LINTERS order) that applies to `file`, with the cwd to run it in: { linter, bin, cwd }, or null.
// Only linters declared by the nearest declaring package.json are candidates.
function detectLinter(file) {
  const dir = dirname(file);
  const extension = extname(file).toLowerCase();
  const declared = nearestDeclared(
    dir,
    LINTERS.map((linter) => linter.packageName),
  );

  for (const linter of LINTERS) {
    if (!declared.has(linter.packageName) || !linter.extensions.has(extension)) {
      continue;
    }
    const bin = findBin(dir, linter.tool);
    const configDir = findConfigDir(dir, linter.configs);
    if (bin === null || (linter.requiresConfig && configDir === null)) {
      continue;
    }
    return { linter, bin: bin.bin, cwd: configDir ?? bin.root };
  }
  return null;
}

// Files per run, each file in the run of the tool `detect` picked for it:
// [{ tool: linter|formatter, bin, cwd, files }], in first-seen order.
function groupRuns(files, detect) {
  const runs = new Map();
  for (const file of files) {
    const detected = detect(file);
    if (detected === null) {
      continue;
    }
    const { linter, formatter, bin, cwd } = detected;
    const tool = linter ?? formatter;
    const key = `${tool.name}\0${cwd}\0${bin}`;
    const run = runs.get(key) ?? { tool, bin, cwd, files: [] };
    run.files.push(file);
    runs.set(key, run);
  }
  return [...runs.values()];
}

function toolEnv(env) {
  return { ...env, NO_COLOR: "1", FORCE_COLOR: "0" };
}

function readBytes(file) {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

// Non-code outcomes of one run as a notice, or null for a normal exit.
// { tool, type: "spawn" | "timeout" | "tool", seconds?, detail? }
function noticeOfResult(tool, result, timeout) {
  if (result.error !== undefined) {
    return { tool: tool.tool, type: "spawn", detail: result.error.message };
  }
  if (result.timedOut) {
    return { tool: tool.tool, type: "timeout", seconds: timeout / 1000 };
  }
  if (result.status === null) {
    return { tool: tool.tool, type: "tool", detail: `signal ${result.signal ?? "unknown"}` };
  }
  return null;
}

function outputOf(result) {
  return stripAnsi(`${result.stdout ?? ""}${result.stderr ?? ""}`).trim();
}

// Formats each file of `files` with the first formatter detected for it, one run after another. Never blocks.
// A run never starts after `deadline` (epoch ms) and is cut off at the deadline or after `timeoutMs`.
// Returns { changed: [files whose content differs from before the format], notices }.
export async function runFormat(
  files,
  { env = process.env, deadline = Number.POSITIVE_INFINITY, timeoutMs = DEFAULT_FORMAT_TIMEOUT_MS } = {},
) {
  const runs = groupRuns(files, detectFormatter);
  const formatted = [...new Set(runs.flatMap((run) => run.files))];
  const before = new Map(formatted.map((file) => [file, readBytes(file)]));

  const notices = [];
  for (const run of runs) {
    const timeout = Math.min(timeoutMs, deadline - Date.now());
    if (timeout <= 0) {
      notices.push({ tool: run.tool.tool, type: "timeout", seconds: 0, skipped: true });
      continue;
    }
    const result = await spawnAsync(run.bin, run.tool.args(run.files), {
      cwd: run.cwd,
      env: toolEnv(env),
      timeout,
    });
    const notice = noticeOfResult(run.tool, result, timeout);
    if (notice !== null) {
      notices.push(notice);
    } else if (result.status !== 0) {
      notices.push({ tool: run.tool.tool, type: "tool", detail: outputOf(result) || `exit ${result.status}` });
    }
  }

  const changed = formatted.filter((file) => {
    const original = before.get(file);
    const current = readBytes(file);
    return original !== null && current !== null && !original.equals(current);
  });
  return { changed, notices };
}

// Lints each file of `files` with the first linter detected for it, the runs at the same time. Returns
// { failures: [{ name, status, output }], notices } like the other kinds of check-on-stop.
export async function runLint(
  files,
  { env = process.env, deadline = Number.POSITIVE_INFINITY, timeoutMs = DEFAULT_LINT_TIMEOUT_MS } = {},
) {
  const runs = groupRuns(files, detectLinter);

  const results = await Promise.all(
    runs.map(async (run) => {
      const timeout = Math.min(timeoutMs, deadline - Date.now());
      if (timeout <= 0) {
        return { notice: { tool: run.tool.tool, type: "timeout", seconds: 0, skipped: true } };
      }
      const result = await spawnAsync(run.bin, run.tool.args(run.files), {
        cwd: run.cwd,
        env: toolEnv(env),
        timeout,
      });

      const notice = noticeOfResult(run.tool, result, timeout);
      if (notice !== null) {
        return { notice };
      }
      if (result.status === 0) {
        return {};
      }
      const output = outputOf(result);
      // The linter itself failed (ESLint: configuration or internal error), not the edited code.
      if ((run.tool.passExitCodes ?? []).includes(result.status)) {
        return { notice: { tool: run.tool.tool, type: "tool", detail: output || `exit ${result.status}` } };
      }
      return { failure: { name: run.tool.name, status: result.status, output: truncate(output, OUTPUT_LIMIT) } };
    }),
  );

  return {
    failures: results.flatMap((result) => (result.failure === undefined ? [] : [result.failure])),
    notices: results.flatMap((result) => (result.notice === undefined ? [] : [result.notice])),
  };
}
