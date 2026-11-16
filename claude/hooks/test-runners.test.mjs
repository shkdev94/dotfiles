// Run with: node --test claude/hooks/test-runners.test.mjs
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { spawnAsync } from "./project-tools.mjs";
import { planTestRuns, runTests } from "./test-runners.mjs";

// Temporary project with a .git directory so upward searches cannot leave it.
function makeProject() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "test-runners-")));
  mkdirSync(join(dir, ".git"));
  return dir;
}

function writeProjectFile(root, relativePath, content = "") {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function writePackage(root, pkg, dir = ".") {
  writeProjectFile(root, join(dir, "package.json"), JSON.stringify(pkg));
}

// Fake tool that prints its cwd and arguments, then `output`, optionally sleeps, and exits with `exit`.
function fakeBin(root, name, { exit = 0, output = "", sleep = 0, dir = "." } = {}) {
  const nap = sleep > 0 ? `sleep ${sleep}\n` : "";
  const script = `#!/bin/sh\necho "CWD: $(pwd -P)"\necho "ARGS: $*"\ncat <<'FAKE_EOF'\n${output}\nFAKE_EOF\n${nap}exit ${exit}\n`;
  const path = writeProjectFile(root, join(dir, "node_modules/.bin", name), script);
  chmodSync(path, 0o755);
}

const NODE_TEST_PASS = `import { it } from "node:test";\nit("ok", () => {});\n`;

describe("test-runners", () => {
  let root;

  beforeEach(() => {
    root = makeProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("spawnAsync", () => {
    it("resolves with status and output", async () => {
      const result = await spawnAsync("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"], { cwd: root });
      assert.equal(result.status, 3);
      assert.equal(result.stdout, "out\n");
      assert.equal(result.stderr, "err\n");
      assert.equal(result.timedOut, false);
      assert.equal(result.error, undefined);
    });

    it("keeps at most maxBuffer bytes per stream", async () => {
      const result = await spawnAsync("/bin/sh", ["-c", "yes x | head -c 100000"], { cwd: root, maxBuffer: 1000 });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.length, 1000);
    });

    it("reports a timeout and does not wait for a grandchild holding the pipes", async () => {
      const startedAt = Date.now();
      const result = await spawnAsync("/bin/sh", ["-c", "sleep 5; echo done"], { cwd: root, timeout: 200 });
      assert.equal(result.timedOut, true);
      assert.equal(result.status, null);
      assert.ok(Date.now() - startedAt < 3000);
    });

    it("kills a process that ignores SIGTERM and still resolves with timedOut", async () => {
      const startedAt = Date.now();
      const script = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
      const result = await spawnAsync(process.execPath, ["-e", script], { cwd: root, timeout: 300 });
      assert.equal(result.timedOut, true);
      assert.equal(result.signal, "SIGKILL");
      assert.ok(Date.now() - startedAt < 4000);
    });

    it("resolves instead of rejecting when the program cannot be spawned", async () => {
      const result = await spawnAsync(join(root, "missing"), [], { cwd: root });
      assert.equal(result.status, null);
      assert.equal(result.error?.code, "ENOENT");
    });
  });

  describe("runner selection", () => {
    function setup(pkg) {
      writePackage(root, pkg);
      fakeBin(root, "vitest");
      fakeBin(root, "jest");
      return writeProjectFile(root, "src/a.ts", "export const a = 1;\n");
    }

    const cases = [
      ["scripts.test names jest when both are declared", { scripts: { test: "jest --coverage" }, devDependencies: { jest: "1", vitest: "1" } }, "jest"],
      ["scripts.test names vitest when both are declared", { scripts: { test: "NODE_ENV=test vitest run" }, devDependencies: { jest: "1", vitest: "1" } }, "vitest"],
      ["vitest wins when both are declared and scripts.test names neither", { devDependencies: { jest: "1", vitest: "1" } }, "vitest"],
      ["vitest wins when both are declared and scripts.test names both", { scripts: { test: "jest && vitest" }, dependencies: { jest: "1" }, devDependencies: { vitest: "1" } }, "vitest"],
      ["only jest is declared, even when scripts.test names vitest", { scripts: { test: "vitest" }, dependencies: { jest: "1" } }, "jest"],
      ["only jest is a dependency", { dependencies: { jest: "1" } }, "jest"],
    ];

    for (const [name, pkg, expected] of cases) {
      it(name, () => {
        const file = setup(pkg);
        assert.deepEqual(
          planTestRuns([file]).map((run) => run.runner),
          [expected],
        );
      });
    }

    it("does not treat a longer word as a runner in scripts.test", () => {
      const file = setup({ scripts: { test: "vitestx && jest" }, devDependencies: { jest: "1", vitest: "1" } });
      assert.deepEqual(
        planTestRuns([file]).map((run) => run.runner),
        ["jest"],
      );
    });

    it("does not select a runner that scripts.test mentions but package.json does not declare", () => {
      const file = setup({ scripts: { test: "vitest run" } });
      assert.deepEqual(planTestRuns([file]), []);
    });

    it("falls back to node:test when scripts.test names an undeclared runner", () => {
      writePackage(root, { scripts: { test: "jest" } });
      fakeBin(root, "jest");
      const a = writeProjectFile(root, "a.mjs", "export const a = 1;\n");
      writeProjectFile(root, "a.test.mjs", `import { it } from "node:test";\nimport "./a.mjs";\nit("a", () => {});\n`);
      assert.deepEqual(
        planTestRuns([a]).map((run) => run.runner),
        ["node:test"],
      );
    });

    it("uses the root declaration, with the subpackage as cwd, when the subpackage declares no runner", () => {
      writePackage(root, { devDependencies: { vitest: "1" } });
      writePackage(root, { name: "web", scripts: { test: "vitest" } }, "packages/web");
      fakeBin(root, "vitest", { dir: "packages/web" });
      const file = writeProjectFile(root, "packages/web/src/b.ts", "");
      const [run, ...rest] = planTestRuns([file]);
      assert.equal(rest.length, 0);
      assert.equal(run.runner, "vitest");
      assert.equal(run.cwd, join(root, "packages/web"));
      assert.equal(run.bin, join(root, "packages/web/node_modules/.bin/vitest"));
      assert.deepEqual(run.args, ["related", "--run", "--passWithNoTests", "src/b.ts"]);
    });

    it("breaks a both-declared tie with the subpackage's scripts.test, not the declaring root's", () => {
      writePackage(root, { devDependencies: { vitest: "1", jest: "1" }, scripts: { test: "vitest" } });
      writePackage(root, { name: "web", scripts: { test: "jest" } }, "packages/web");
      fakeBin(root, "jest", { dir: "packages/web" });
      const file = writeProjectFile(root, "packages/web/src/b.ts", "");
      assert.deepEqual(
        planTestRuns([file]).map((run) => run.runner),
        ["jest"],
      );
    });

    it("groups files by the nearest package.json", () => {
      writePackage(root, { devDependencies: { vitest: "1" } });
      writePackage(root, { devDependencies: { jest: "1" } }, "packages/web");
      fakeBin(root, "vitest");
      fakeBin(root, "jest");
      const rootFile = writeProjectFile(root, "src/a.ts", "");
      const webFile = writeProjectFile(root, "packages/web/src/b.ts", "");
      const runs = planTestRuns([rootFile, webFile]);
      assert.deepEqual(
        runs.map((run) => [run.runner, run.cwd, run.files]),
        [
          ["vitest", root, [rootFile]],
          ["jest", join(root, "packages/web"), [webFile]],
        ],
      );
    });

    it("treats an unparsable package.json as having no runner", () => {
      writeProjectFile(root, "package.json", "{ not json");
      fakeBin(root, "vitest");
      const file = writeProjectFile(root, "a.ts", "");
      assert.deepEqual(planTestRuns([file]), []);
    });

    it("skips projects under Yarn PnP", () => {
      writeProjectFile(root, ".pnp.cjs", "");
      writePackage(root, { devDependencies: { vitest: "1" } }, "app");
      fakeBin(root, "vitest", { dir: "app" });
      const file = writeProjectFile(root, "app/src/a.ts", "");
      assert.deepEqual(planTestRuns([file]), []);

      rmSync(join(root, ".pnp.cjs"));
      writeProjectFile(root, ".pnp.loader.mjs", "");
      assert.deepEqual(planTestRuns([file]), []);
    });

    it("skips silently when the runner binary is not installed", async () => {
      writePackage(root, { devDependencies: { vitest: "1" } });
      const file = writeProjectFile(root, "src/a.ts", "");
      assert.deepEqual(await runTests([file]), { failures: [], notices: [] });
    });

    it("ignores files that are not JS/TS sources or do not exist", () => {
      writePackage(root, { devDependencies: { vitest: "1" } });
      fakeBin(root, "vitest");
      const doc = writeProjectFile(root, "README.md", "");
      assert.deepEqual(planTestRuns([doc, join(root, "missing.ts")]), []);
    });
  });

  describe("arguments and working directory", () => {
    it("runs vitest related --run in the package directory without the test script", async () => {
      writePackage(root, { scripts: { test: "vitest" }, devDependencies: { vitest: "1" } }, "app");
      fakeBin(root, "vitest", { dir: "app", exit: 1 });
      const file = writeProjectFile(root, "app/src/a.ts", "");
      const [run] = planTestRuns([file]);
      assert.deepEqual(run.args, ["related", "--run", "--passWithNoTests", "src/a.ts"]);
      assert.equal(run.cwd, join(root, "app"));

      const { notices } = await runTests([file]);
      assert.equal(notices.length, 1);
      assert.match(notices[0].detail, new RegExp(`CWD: ${join(root, "app")}`));
      assert.match(notices[0].detail, /ARGS: related --run --passWithNoTests src\/a\.ts/);
    });

    it("runs jest --ci --findRelatedTests with every file of the package", () => {
      writePackage(root, { devDependencies: { jest: "1" } });
      fakeBin(root, "jest");
      const a = writeProjectFile(root, "src/a.js", "");
      const b = writeProjectFile(root, "src/b.tsx", "");
      const [run] = planTestRuns([a, b]);
      assert.deepEqual(run.args, ["--ci", "--passWithNoTests", "--findRelatedTests", "src/a.js", "src/b.tsx"]);
      assert.equal(run.cwd, root);
    });

    for (const runner of ["vitest", "jest"]) {
      it(`passes edited .vue and .svelte files to ${runner} as relative paths`, () => {
        writePackage(root, { devDependencies: { [runner]: "1" } });
        fakeBin(root, runner);
        const vue = writeProjectFile(root, "src/App.vue", "");
        const svelte = writeProjectFile(root, "src/Widget.svelte", "");
        const [run, ...rest] = planTestRuns([vue, svelte]);
        assert.equal(rest.length, 0);
        assert.equal(run.runner, runner);
        assert.deepEqual(run.files, [vue, svelte]);
        assert.deepEqual(run.args.slice(-2), ["src/App.vue", "src/Widget.svelte"]);
      });
    }

    it("hands the runner a colorless environment without NODE_TEST_CONTEXT", () => {
      writePackage(root, { devDependencies: { jest: "1" } });
      fakeBin(root, "jest");
      const file = writeProjectFile(root, "a.js", "");
      const [run] = planTestRuns([file], { env: { PATH: "/bin", NODE_TEST_CONTEXT: "child-v8", KEEP: "1" } });
      assert.deepEqual(run.env, { PATH: "/bin", KEEP: "1", NO_COLOR: "1", FORCE_COLOR: "0" });
    });
  });

  describe("node:test fallback", () => {
    it("selects only node:test files that import the edited file directly", () => {
      const a = writeProjectFile(root, "lib/a.mjs", "export const a = 1;\n");
      const b = writeProjectFile(root, "lib/b.mjs", "export const b = 1;\n");
      const direct = writeProjectFile(root, "lib/a.test.mjs", `import { it } from "node:test";\nimport { a } from "./a.mjs";\nit("a", () => a);\n`);
      const dynamic = writeProjectFile(root, "lib/dyn.test.mjs", `import { it } from "node:test";\nit("d", async () => { await import("./a.mjs"); });\n`);
      const required = writeProjectFile(root, "lib/req.test.cjs", `const { it } = require("node:test");\nit("r", () => { require('./a.mjs'); });\n`);
      writeProjectFile(root, "lib/other.test.mjs", `import { it } from "node:test";\nimport "./b.mjs";\nit("o", () => {});\n`);
      writeProjectFile(root, "lib/plain.test.mjs", `import { a } from "./a.mjs";\nexport default a;\n`);
      writeProjectFile(root, "lib/indirect.test.mjs", `import { it } from "node:test";\nimport "./helper.mjs";\nit("i", () => {});\n`);
      writeProjectFile(root, "lib/sub/a.test.mjs", `import { it } from "node:test";\nimport "../a.mjs";\nit("s", () => {});\n`);

      const [run, ...rest] = planTestRuns([a]);
      assert.equal(rest.length, 0);
      assert.equal(run.runner, "node:test");
      assert.equal(run.bin, process.execPath);
      assert.equal(run.cwd, join(root, "lib"));
      assert.deepEqual(run.args, ["--test", "--test-reporter=tap", ...[direct, dynamic, required].sort()]);

      assert.equal(planTestRuns([b]).length, 1);
      assert.deepEqual(planTestRuns([b])[0].args.slice(2), [join(root, "lib/other.test.mjs")]);
    });

    it("includes the edited file when it is itself a node:test test", () => {
      const test = writeProjectFile(root, "lib/c.test.mjs", NODE_TEST_PASS);
      const [run] = planTestRuns([test]);
      assert.deepEqual(run.args, ["--test", "--test-reporter=tap", test]);
    });

    it("does not run anything when no test is selected", () => {
      const a = writeProjectFile(root, "lib/a.mjs", "export const a = 1;\n");
      writeProjectFile(root, "lib/a.test.mjs", `import { a } from "./a.mjs";\nexport default a;\n`);
      assert.deepEqual(planTestRuns([a]), []);
    });

    it("is used for a package without vitest or jest", () => {
      writePackage(root, { scripts: { test: "node --test" } });
      const a = writeProjectFile(root, "a.mjs", "export const a = 1;\n");
      writeProjectFile(root, "a.test.mjs", `import { it } from "node:test";\nimport "./a.mjs";\nit("a", () => {});\n`);
      assert.equal(planTestRuns([a])[0].runner, "node:test");
    });

    it("never hands .vue or .svelte files to node:test, with or without a package.json", () => {
      const importer = `import { it } from "node:test";\nimport "./App.vue";\nimport "./Widget.svelte";\nit("a", () => {});\n`;
      writePackage(root, { scripts: { test: "node --test" } }, "pkg");
      for (const dir of ["pkg", "loose"]) {
        const vue = writeProjectFile(root, `${dir}/App.vue`, "");
        const svelte = writeProjectFile(root, `${dir}/Widget.svelte`, "");
        writeProjectFile(root, `${dir}/app.test.mjs`, importer);
        assert.deepEqual(planTestRuns([vue, svelte]), []);
      }
    });

    it("passes a passing test run", async () => {
      const a = writeProjectFile(root, "a.mjs", "export const a = 1;\n");
      writeProjectFile(root, "a.test.mjs", `import { it } from "node:test";\nimport { a } from "./a.mjs";\nit("a is one", () => { if (a !== 1) throw new Error("no"); });\n`);
      assert.deepEqual(await runTests([a]), { failures: [], notices: [] });
    });

    it("reports a failing test with its name and output", async () => {
      const a = writeProjectFile(root, "a.mjs", "export const a = 2;\n");
      writeProjectFile(root, "a.test.mjs", `import { it } from "node:test";\nimport { a } from "./a.mjs";\nit("a is one", () => { if (a !== 1) throw new Error("expected one"); });\n`);
      const { failures, notices } = await runTests([a]);
      assert.deepEqual(notices, []);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].runner, "node:test");
      assert.deepEqual(failures[0].keys, ["a is one"]);
      assert.equal(failures[0].key, "a is one");
      assert.match(failures[0].text, /expected one/);
    });
  });

  describe("result parsing", () => {
    function setupRunner(runner, options) {
      writePackage(root, { devDependencies: { [runner]: "1" } });
      fakeBin(root, runner, options);
      return writeProjectFile(root, "src/a.ts", "");
    }

    it("parses vitest FAIL lines, strips ANSI and removes duplicates", async () => {
      const output = [
        "\u001b[31m FAIL \u001b[39m src/a.test.ts > suite > works",
        "AssertionError: expected 1 to be 2",
        "FAIL  src/a.test.ts > suite > works",
        "FAIL  src/b.test.ts > other",
      ].join("\n");
      const file = setupRunner("vitest", { exit: 1, output });
      const { failures, notices } = await runTests([file]);
      assert.deepEqual(notices, []);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].runner, "vitest");
      assert.deepEqual(failures[0].keys, ["src/a.test.ts > suite > works", "src/b.test.ts > other"]);
      assert.doesNotMatch(failures[0].text, /\u001b/);
      assert.match(failures[0].text, /AssertionError/);
    });

    it("parses jest FAIL and bullet lines", async () => {
      const output = ["FAIL src/a.test.js", "  ● Console", "  ● suite › case one", "  ● suite › case one", "Tests: 1 failed"].join("\n");
      const file = setupRunner("jest", { exit: 1, output });
      const { failures } = await runTests([file]);
      assert.deepEqual(failures[0].keys, ["src/a.test.js", "suite › case one"]);
    });

    it("truncates the failure text to 4000 characters plus a notice line", async () => {
      const output = `FAIL src/a.test.ts > t\n${"x".repeat(9000)}`;
      const file = setupRunner("vitest", { exit: 1, output });
      const { failures } = await runTests([file]);
      assert.ok(failures[0].text.length < 4100);
      assert.match(failures[0].text, /자 생략\)$/);
    });

    it("reports a tool notice when the runner fails without naming a test", async () => {
      const file = setupRunner("vitest", { exit: 1, output: "Error: Cannot find config" });
      const { failures, notices } = await runTests([file]);
      assert.deepEqual(failures, []);
      assert.equal(notices.length, 1);
      assert.equal(notices[0].name, "vitest");
      assert.equal(notices[0].type, "tool");
      assert.match(notices[0].detail, /Cannot find config/);
    });

    it("treats exit code 0 as a pass even when the output mentions FAIL", async () => {
      const file = setupRunner("vitest", { exit: 0, output: "FAIL looks bad but passed" });
      assert.deepEqual(await runTests([file]), { failures: [], notices: [] });
    });

    it("reports a spawn notice when the binary cannot be started", async () => {
      writePackage(root, { devDependencies: { vitest: "1" } });
      const bin = writeProjectFile(root, "node_modules/.bin/vitest", "#!/nonexistent/interpreter\n");
      chmodSync(bin, 0o755);
      const file = writeProjectFile(root, "src/a.ts", "");
      const { failures, notices } = await runTests([file]);
      assert.deepEqual(failures, []);
      assert.equal(notices.length, 1);
      assert.equal(notices[0].type, "spawn");
      assert.equal(notices[0].name, "vitest");
    });
  });

  describe("time limits", () => {
    it("reports a timeout notice when a run exceeds timeoutMs", async () => {
      writePackage(root, { devDependencies: { vitest: "1" } });
      fakeBin(root, "vitest", { sleep: 5, exit: 1, output: "FAIL src/a.test.ts > t" });
      const file = writeProjectFile(root, "src/a.ts", "");
      const startedAt = Date.now();
      const { failures, notices } = await runTests([file], { timeoutMs: 300 });
      assert.deepEqual(failures, []);
      assert.equal(notices.length, 1);
      assert.equal(notices[0].type, "timeout");
      assert.equal(notices[0].name, "vitest");
      assert.equal(notices[0].seconds, 0.3);
      assert.ok(Date.now() - startedAt < 3000);
    });

    it("limits a run to the time left before the deadline", async () => {
      writePackage(root, { devDependencies: { vitest: "1" } });
      fakeBin(root, "vitest", { sleep: 5 });
      const file = writeProjectFile(root, "src/a.ts", "");
      const { notices } = await runTests([file], { deadline: Date.now() + 300 });
      assert.equal(notices.length, 1);
      assert.equal(notices[0].type, "timeout");
      assert.ok(notices[0].seconds <= 0.3);
    });

    it("marks only runs that were not started for lack of time as skipped", async () => {
      writePackage(root, { devDependencies: { vitest: "1" } });
      fakeBin(root, "vitest", { sleep: 5 });
      const file = writeProjectFile(root, "src/a.ts", "");

      const expired = await runTests([file], { deadline: Date.now() - 1 });
      assert.equal(expired.notices[0].skipped, true);
      assert.equal(expired.notices[0].seconds, 0);

      const timedOut = await runTests([file], { timeoutMs: 300 });
      assert.equal(timedOut.notices[0].type, "timeout");
      assert.equal(timedOut.notices[0].skipped, undefined);
      assert.equal(timedOut.notices[0].detail, undefined);
    });

    it("does not run anything after the deadline has passed", async () => {
      writePackage(root, { devDependencies: { vitest: "1" } });
      fakeBin(root, "vitest", { exit: 1, output: "FAIL src/a.test.ts > t" });
      const file = writeProjectFile(root, "src/a.ts", "");
      const { failures, notices } = await runTests([file], { deadline: Date.now() - 1 });
      assert.deepEqual(failures, []);
      assert.equal(notices.length, 1);
      assert.equal(notices[0].type, "timeout");
      assert.equal(notices[0].seconds, 0);
    });
  });
});
