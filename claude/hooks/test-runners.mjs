// Runs the tests related to edited JS/TS/Vue/Svelte files with the project's own runner, for the Stop hook
// driver. vitest and jest are used only when declared in dependencies/devDependencies (the nearest
// package.json that declares either wins) and are called directly from `node_modules/.bin` with their
// "related tests" options; the package's `test` script is never run. Without a declared runner, `node:test`
// files in the edited file's directory that import it directly are run (JS files only; .vue and .svelte
// never reach that fallback). Yarn PnP projects are skipped.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { findBin, isFile, nearestDeclared, readPackageJson, searchDirs, spawnAsync, stripAnsi, truncate } from "./project-tools.mjs";

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const NODE_TEST_EXTENSIONS = /\.(?:mjs|cjs|js)$/;
const NODE_TEST_FILE = /\.test\.(?:mjs|cjs|js)$/;
const PNP_FILES = [".pnp.cjs", ".pnp.loader.mjs"];
const TEXT_LIMIT = 4000;
const DEFAULT_TIMEOUT_MS = 120_000;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "vitest" | "jest" | null. A runner is a candidate only when the nearest package.json that declares vitest
// or jest in dependencies/devDependencies (walking up from `pkgDir`) declares it; scripts.test alone never
// selects one. With both declared, the one named in pkgDir's scripts.test wins (vitest checked first), and
// vitest is the default when neither is named.
function detectRunner(pkgDir) {
  const declared = nearestDeclared(pkgDir, ["vitest", "jest"]);
  if (declared.size === 0) {
    return null;
  }
  if (declared.size === 1) {
    return [...declared][0];
  }
  const script = readPackageJson(pkgDir)?.scripts?.test;
  for (const runner of ["vitest", "jest"]) {
    if (typeof script === "string" && new RegExp(`\\b${runner}\\b`).test(script)) {
      return runner;
    }
  }
  return "vitest";
}

function hasPnp(dir) {
  return searchDirs(dir).some((candidate) => PNP_FILES.some((name) => existsSync(join(candidate, name))));
}

// Test files in the directory of `file` that use node:test and import `file` directly
// (`file` itself when it is such a test).
function nodeTestsFor(file) {
  const dir = dirname(file);
  const name = basename(file);
  const importsEdited = new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"]\\./${escapeRegExp(name)}['"]`);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => NODE_TEST_FILE.test(entry))
    .map((entry) => join(dir, entry))
    .filter((candidate) => {
      let content;
      try {
        content = readFileSync(candidate, "utf8");
      } catch {
        return false;
      }
      if (!/['"]node:test['"]/.test(content)) {
        return false;
      }
      return candidate === file || importsEdited.test(content);
    });
}

function runEnv(env) {
  // A child `node --test` that sees this variable behaves like a worker of the parent test run.
  const { NODE_TEST_CONTEXT: _context, ...rest } = env;
  return { ...rest, NO_COLOR: "1", FORCE_COLOR: "0" };
}

// Runs to perform for `files`: [{runner, bin, args, cwd, env, files}].
export function planTestRuns(files, { env = process.env } = {}) {
  const sources = [...new Set(files.map((file) => resolve(file)))].filter(
    (file) => SOURCE_EXTENSIONS.test(file) && isFile(file),
  );
  const childEnv = runEnv(env);

  const packages = new Map(); // package dir -> files
  const loose = []; // files without a package.json
  for (const file of sources) {
    const dir = dirname(file);
    if (hasPnp(dir)) {
      continue;
    }
    const pkgDir = searchDirs(dir).find((candidate) => existsSync(join(candidate, "package.json")));
    if (pkgDir === undefined) {
      loose.push(file);
    } else {
      packages.set(pkgDir, [...(packages.get(pkgDir) ?? []), file]);
    }
  }

  const runs = [];
  const nodeTestCandidates = [...loose];
  for (const [pkgDir, group] of packages) {
    const runner = detectRunner(pkgDir);
    if (runner === null) {
      nodeTestCandidates.push(...group);
      continue;
    }
    // The runner is configured but not installed: nothing to run, and nothing to report.
    const found = findBin(pkgDir, runner);
    if (found === null) {
      continue;
    }
    // Relative to cwd, the form both runners document.
    const related = group.map((file) => relative(pkgDir, file));
    const args =
      runner === "vitest"
        ? ["related", "--run", "--passWithNoTests", ...related]
        : ["--ci", "--passWithNoTests", "--findRelatedTests", ...related];
    runs.push({ runner, bin: found.bin, args, cwd: pkgDir, env: childEnv, files: group });
  }

  const testsByDir = new Map();
  for (const file of nodeTestCandidates) {
    if (!NODE_TEST_EXTENSIONS.test(file)) {
      continue;
    }
    const tests = nodeTestsFor(file);
    if (tests.length > 0) {
      const dir = dirname(file);
      testsByDir.set(dir, [...new Set([...(testsByDir.get(dir) ?? []), ...tests])]);
    }
  }
  for (const [dir, tests] of testsByDir) {
    runs.push({
      runner: "node:test",
      bin: process.execPath,
      args: ["--test", "--test-reporter=tap", ...tests.sort()],
      cwd: dir,
      env: childEnv,
      files: tests,
    });
  }

  return runs;
}

const KEY_PATTERNS = {
  vitest: [/^\s*FAIL\s+(\S.*?)\s*$/],
  jest: [/^\s*FAIL\s+(\S.*?)\s*$/, /^\s*●\s+(.+›.+?)\s*$/],
  "node:test": [/^\s*not ok \d+ - (.+?)\s*$/],
};

function failureKeys(runner, text) {
  const keys = new Set();
  for (const line of text.split("\n")) {
    for (const pattern of KEY_PATTERNS[runner]) {
      const match = pattern.exec(line);
      if (match !== null) {
        keys.add(match[1]);
        break;
      }
    }
  }
  return [...keys];
}

async function runOne(run, timeout) {
  const result = await spawnAsync(run.bin, run.args, { cwd: run.cwd, env: run.env, timeout });

  if (result.error !== undefined) {
    return { notice: { name: run.runner, type: "spawn", detail: result.error.message } };
  }
  if (result.timedOut) {
    return { notice: { name: run.runner, type: "timeout", seconds: timeout / 1000 } };
  }
  if (result.status === 0) {
    return {};
  }
  if (result.status === null) {
    return { notice: { name: run.runner, type: "tool", detail: `signal ${result.signal ?? "unknown"}` } };
  }

  const cleaned = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const keys = failureKeys(run.runner, cleaned);
  const text = truncate(cleaned.trim(), TEXT_LIMIT);
  if (keys.length === 0) {
    return { notice: { name: run.runner, type: "tool", detail: text } };
  }
  return { failure: { runner: run.runner, key: keys.join("\n"), keys, text } };
}

// Runs the related tests one run after another. A run never starts after `deadline` (epoch ms) and is
// cut off at the deadline or after `timeoutMs`, whichever comes first.
export async function runTests(
  files,
  { env = process.env, deadline = Number.POSITIVE_INFINITY, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const failures = [];
  const notices = [];

  for (const run of planTestRuns(files, { env })) {
    const timeout = Math.min(timeoutMs, deadline - Date.now());
    if (timeout <= 0) {
      notices.push({ name: run.runner, type: "timeout", seconds: 0, skipped: true });
      continue;
    }
    const { failure, notice } = await runOne(run, timeout);
    if (failure !== undefined) {
      failures.push(failure);
    }
    if (notice !== undefined) {
      notices.push(notice);
    }
  }

  return { failures, notices };
}
