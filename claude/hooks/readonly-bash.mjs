// PreToolUse(Bash): limit researcher and planner to read-only commands with an allowlist (anything not
// listed is denied). This prevents accidents; it is not a security boundary.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { runHook } from "./run-hook.mjs";

const RESTRICTED_AGENTS = new Set(["researcher", "planner"]);
const guidance = (agentType) => `${agentType}는 읽기 전용 명령만 쓴다. 수정·실행이 필요하면 보고에 적어 worker에 넘기게 한다.`;

class Reject extends Error {}

// --- Lexer --------------------------------------------------------------------------------------
// Splits a command line into simple commands (arrays of unquoted words). Forms that run or write
// something we cannot inspect are rejected on the spot. Comments are not recognized on purpose:
// `#` stays a literal character, so nothing after it is skipped.

function checkRedirect(op, target) {
  if ([">", ">>", "&>", "&>>", ">|"].includes(op)) {
    if (target !== "/dev/null") {
      throw new Reject(`파일에 쓰는 리다이렉션(${op} ${target})`);
    }
  } else if (op === ">&" || op === "<&") {
    if (!/^\d+$/.test(target) && target !== "-" && target !== "/dev/null") {
      throw new Reject(`파일에 쓰는 리다이렉션(${op} ${target})`);
    }
  }
  // `<` only reads.
}

function parseCommands(source) {
  const commands = [];
  let words = [];
  let word = "";
  let inWord = false;
  let pendingRedirect = null;

  const pushWord = () => {
    if (!inWord) {
      return;
    }
    if (pendingRedirect !== null) {
      checkRedirect(pendingRedirect, word);
      pendingRedirect = null;
    } else {
      words.push(word);
    }
    word = "";
    inWord = false;
  };
  const pushCommand = () => {
    pushWord();
    if (pendingRedirect !== null) {
      throw new Reject("리다이렉션 대상이 없다");
    }
    if (words.length > 0) {
      commands.push(words);
    }
    words = [];
  };
  const append = (text) => {
    word += text;
    inWord = true;
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (c === " " || c === "\t") {
      pushWord();
    } else if (c === "\n" || c === "\r" || c === ";") {
      pushCommand();
    } else if (c === "|") {
      pushCommand();
      if (next === "|" || next === "&") {
        i++;
      }
    } else if (c === "&" && next === ">") {
      pushWord();
      const op = source[i + 2] === ">" ? "&>>" : "&>";
      i += op.length - 1;
      pendingRedirect = op;
    } else if (c === "&") {
      pushCommand();
      if (next === "&") {
        i++;
      }
    } else if (c === ">" || c === "<") {
      if (next === "(") {
        throw new Reject("프로세스 치환(<(...), >(...))");
      }
      // A file descriptor prefix such as the 2 in `2>&1`.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        pushWord();
      }
      if (c === "<" && next === "<") {
        throw new Reject("here-document(<<, <<<)");
      }
      let op = c;
      if (next === ">" && c === ">") {
        op = ">>";
      } else if (next === "&") {
        op = `${c}&`;
      } else if (next === "|" && c === ">") {
        op = ">|";
      }
      i += op.length - 1;
      pendingRedirect = op;
    } else if (c === "(" || c === ")") {
      throw new Reject("서브셸·그룹((...))");
    } else if (c === "`") {
      throw new Reject("명령 치환(`...`)");
    } else if (c === "$" && next === "(") {
      throw new Reject("명령 치환($(...))");
    } else if (c === "$" && (next === "'" || next === '"')) {
      throw new Reject("$'...' / $\"...\" 따옴표");
    } else if (c === "\\") {
      if (next === undefined) {
        append("\\");
      } else {
        if (next !== "\n") {
          append(next);
        }
        i++;
      }
    } else if (c === "'") {
      const end = source.indexOf("'", i + 1);
      if (end === -1) {
        throw new Reject("닫히지 않은 따옴표");
      }
      inWord = true;
      word += source.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      inWord = true;
      let closed = false;
      for (i++; i < source.length; i++) {
        const d = source[i];
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === "`" || (d === "$" && source[i + 1] === "(")) {
          throw new Reject("큰따옴표 안의 명령 치환");
        }
        if (d === "\\" && i + 1 < source.length) {
          const e = source[i + 1];
          i++;
          if (e === "\n") {
            continue;
          }
          word += "$`\"\\".includes(e) ? e : `\\${e}`;
        } else {
          word += d;
        }
      }
      if (!closed) {
        throw new Reject("닫히지 않은 따옴표");
      }
    } else {
      append(c);
    }
  }
  pushCommand();
  return commands;
}

// --- Option helpers -----------------------------------------------------------------------------

// Arguments before the `--` terminator.
function optionArgs(args) {
  const end = args.indexOf("--");
  return end === -1 ? args : args.slice(0, end);
}

// Letters of a short-option cluster up to and including the first one that takes a value. The rest of the
// token is that value (`-Iseconds`, `-g'*.zsh'`), so its letters are not options.
function clusterLetters(arg, valueLetters) {
  const letters = [];
  for (const letter of arg.slice(1)) {
    letters.push(letter);
    if (valueLetters.includes(letter)) {
      break;
    }
  }
  return letters;
}

// True when `args` hold a forbidden option:
// - a long option that equals one of `long` or abbreviates it (GNU-style unambiguous prefixes, so
//   `--compress-prog` reaches `--compress-program`), unless it exactly equals a legitimate option in
//   `okLong` that merely looks like such an abbreviation (git `--text` is not `--textconv`);
// - a short option cluster that contains one of the `short` letters before any letter in `value` (letters
//   that take a value; their value may be attached or the next token). `-XPOST` and `-uo` count, while
//   `-Iseconds` (value I) does not.
function forbids(args, { long = [], short = "", value = "", okLong = [] }) {
  const list = optionArgs(args);
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (arg.startsWith("--")) {
      const name = arg.split("=")[0];
      if (name.length >= 3 && !okLong.includes(name) && long.some((full) => full.startsWith(name))) {
        return true;
      }
    } else if (/^-[^-]/.test(arg)) {
      const letters = clusterLetters(arg, value);
      if (letters.some((letter) => short.includes(letter))) {
        return true;
      }
      if (letters.length === arg.length - 1 && value.includes(letters.at(-1))) {
        i++;
      }
    }
  }
  return false;
}

function positionals(args, valueFlags = []) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") {
      result.push(...args.slice(i + 1));
      break;
    }
    if (valueFlags.includes(args[i])) {
      i++;
    } else if (!args[i].startsWith("-") || args[i] === "-") {
      result.push(args[i]);
    }
  }
  return result;
}

// --- Temp directory targets for clone -----------------------------------------------------------

function tmpRoots() {
  const roots = new Set(["/tmp", "/private/tmp", resolve(tmpdir())]);
  try {
    roots.add(realpathSync(tmpdir()));
  } catch {
    // Keep the unresolved path only.
  }
  return [...roots];
}

function isUnderTmp(target) {
  const expanded = target.replace(/^\$\{?TMPDIR\}?(?=\/|$)/, tmpdir());
  if (!isAbsolute(expanded)) {
    return false;
  }
  const resolved = resolve(expanded);
  return tmpRoots().some((root) => resolved.startsWith(root + sep));
}

function checkCloneTarget(rest, valueFlags) {
  const [url, target, ...extra] = positionals(rest, valueFlags);
  if (url === undefined || target === undefined) {
    return "clone 대상 경로를 생략할 수 없다. $TMPDIR, /private/tmp, /tmp 아래 경로를 지정한다";
  }
  if (extra.length > 0) {
    return "clone 인자가 너무 많다";
  }
  if (url.startsWith("ext::")) {
    return "ext:: 전송은 명령을 실행한다";
  }
  return isUnderTmp(target) ? null : `clone 대상(${target})은 $TMPDIR, /private/tmp, /tmp 아래여야 한다`;
}

// --- git ----------------------------------------------------------------------------------------

const GIT_READ_COMMANDS = new Set(["log", "show", "blame", "diff", "status", "grep", "ls-files", "rev-parse", "cat-file"]);
// Legitimate git options that only look like abbreviations of a forbidden one (--text vs --textconv, --filter vs --filters).
const GIT_OK_LONG = ["--text", "--filter"];
const GIT_FORBIDDEN_LONG = ["--output", "--ext-diff", "--textconv", "--filters", "--exec-path", "--open-files-in-pager"];
const GIT_BRANCH_FLAGS = new Set(["-a", "--all", "-r", "--remotes", "-l", "--list", "-v", "-vv", "--verbose", "--show-current"]);
const GIT_BRANCH_VALUE_FLAGS = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);
const GIT_CLONE_VALUE_FLAGS = ["-b", "--branch", "--depth", "--filter"];
const GIT_CLONE_FLAGS = new Set(["-q", "--quiet", "-v", "--verbose", "--bare", "-n", "--no-checkout", "--single-branch", "--no-tags"]);

function checkGitBranch(args) {
  let listing = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [name, value] = arg.split(/=(.*)/s);
    if (GIT_BRANCH_VALUE_FLAGS.has(name)) {
      if (value === undefined) {
        i++;
      }
    } else if (GIT_BRANCH_FLAGS.has(arg)) {
      listing ||= arg === "-l" || arg === "--list";
    } else if (/^-[avrl]+$/.test(arg)) {
      listing ||= arg.includes("l");
    } else if (arg.startsWith("-")) {
      return `git branch ${arg}은 브랜치를 바꿀 수 있다 (목록 조회 옵션만 허용)`;
    } else if (!listing) {
      return `git branch ${arg}은 브랜치를 만든다 (목록 조회만 허용)`;
    }
  }
  return null;
}

function checkGitClone(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      break;
    }
    if (!arg.startsWith("-")) {
      continue;
    }
    const [name, value] = arg.split(/=(.*)/s);
    if (GIT_CLONE_VALUE_FLAGS.includes(name)) {
      if (value === undefined) {
        i++;
      }
    } else if (!GIT_CLONE_FLAGS.has(arg)) {
      return `git clone ${arg}은 허용 목록에 없다`;
    }
  }
  return checkCloneTarget(args, GIT_CLONE_VALUE_FLAGS);
}

function checkGit(args) {
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    const arg = args[index];
    if (arg === "-C") {
      index += 2;
    } else if (["--no-pager", "--no-optional-locks", "-P"].includes(arg)) {
      index++;
    } else {
      return `git 전역 옵션 ${arg}은 허용하지 않는다 (설정·실행 경로를 바꿀 수 있다)`;
    }
  }

  const sub = args[index];
  const rest = args.slice(index + 1);
  if (sub === undefined) {
    return null;
  }
  if (GIT_READ_COMMANDS.has(sub)) {
    if (forbids(rest, { long: GIT_FORBIDDEN_LONG, okLong: GIT_OK_LONG })) {
      return `git ${sub}의 파일 쓰기·외부 프로그램 실행 옵션은 허용하지 않는다`;
    }
    if (sub === "grep" && optionArgs(rest).some((arg) => arg.startsWith("-O"))) {
      return "git grep -O는 외부 프로그램을 실행한다";
    }
    return null;
  }
  if (sub === "branch") {
    return checkGitBranch(rest);
  }
  if (sub === "remote") {
    const ok =
      rest.length === 0 ||
      (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose")) ||
      (rest.length === 2 && rest[0] === "get-url");
    return ok ? null : "git remote는 목록(-v)과 get-url만 허용한다";
  }
  if (sub === "clone") {
    return checkGitClone(rest);
  }
  return `git ${sub}은 읽기 전용 허용 목록에 없다`;
}

// --- gh -----------------------------------------------------------------------------------------

const GH_ACTIONS = {
  issue: ["view", "list"],
  pr: ["view", "list", "diff", "checks"],
  release: ["view", "list"],
  run: ["view", "list"],
};

const GH_API_WRITE_HINT =
  "gh api는 GET 조회만 허용한다 (-X/--method, --input, -f/-F/--field/--raw-field는 쓰기 요청이 된다. GraphQL은 mutation 없는 query= 필드 하나만 허용)";
const GH_API_VALUE_FLAGS = ["-H", "--header", "-q", "--jq", "-t", "--template", "-p", "--preview", "--hostname", "--cache", "-f", "-F", "--field", "--raw-field"];
const GH_FIELD_FLAGS = ["--field", "--raw-field"];
// Short options of `gh api` that take a value (-q jq, -H header, -t template, -p preview, -f/-F field).
const GH_API_SHORT_VALUE = "qHtpfF";
// Short options with a value on the issue/pr/release/search commands (-R repo, -q jq, -t template, -L limit,
// -s state, -l label, -a assignee, -A author, -m milestone, -S search, -B base, -H head). Not -w: it is --web.
const GH_SHORT_VALUE = "RqtLslaAmSBH";

// Values of -f/-F/--field/--raw-field, including attached forms (`-Fquery=x`, `--raw-field=a=b`).
function ghApiFields(rest) {
  const args = optionArgs(rest);
  const fields = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const [name, value] = arg.split(/=(.*)/s);
      if (name.length >= 3 && GH_FIELD_FLAGS.some((full) => full.startsWith(name))) {
        fields.push(value ?? args[++i] ?? "");
      }
    } else if (/^-[^-]/.test(arg)) {
      const letters = clusterLetters(arg, GH_API_SHORT_VALUE);
      const last = letters.at(-1);
      if ("fF".includes(last)) {
        fields.push(letters.length < arg.length - 1 ? arg.slice(letters.length + 1) : (args[++i] ?? ""));
      } else if (GH_API_SHORT_VALUE.includes(last) && letters.length === arg.length - 1) {
        i++;
      }
    }
  }
  return fields;
}

function checkGhApi(rest) {
  if (forbids(rest, { long: ["--method", "--input"], short: "X", value: GH_API_SHORT_VALUE })) {
    return GH_API_WRITE_HINT;
  }
  if (optionArgs(rest).some((arg) => /method-override/i.test(arg))) {
    return "메서드 덮어쓰기 헤더는 허용하지 않는다";
  }

  const fields = ghApiFields(rest);
  if (fields.length === 0) {
    return null;
  }
  const endpoint = positionals(rest, GH_API_VALUE_FLAGS)[0];
  const [field] = fields;
  const readOnlyQuery =
    endpoint === "graphql" && fields.length === 1 && field.startsWith("query=") && !field.startsWith("query=@") && !/mutation/i.test(field);
  return readOnlyQuery ? null : GH_API_WRITE_HINT;
}

function checkGh(args) {
  const [group, action, ...more] = args;
  if (group === undefined || group === "help") {
    return null;
  }
  const rest = args.slice(1);

  if (group === "api") {
    return checkGhApi(rest);
  }
  if (group === "search") {
    return forbids(rest, { long: ["--web"], short: "w", value: GH_SHORT_VALUE }) ? "gh --web은 브라우저를 연다" : null;
  }
  if (group === "repo" && action === "clone") {
    if (more.includes("--")) {
      return "gh repo clone의 -- 뒤 git 인자는 허용하지 않는다";
    }
    return checkCloneTarget(more, []);
  }

  const allowed = group === "repo" ? ["view"] : GH_ACTIONS[group];
  if (allowed === undefined || !allowed.includes(action)) {
    return `gh ${[group, action].filter(Boolean).join(" ")}은 읽기 전용 허용 목록에 없다`;
  }
  // `-w` is --workflow for `gh run list`, and --web everywhere else.
  if (forbids(more, { long: ["--web"], short: group === "run" ? "" : "w", value: GH_SHORT_VALUE })) {
    return "gh --web은 브라우저를 연다";
  }
  return null;
}

// --- sed ----------------------------------------------------------------------------------------

// Walks a sed script and rejects commands that write files or run commands (w, W, e, s///w, s///e).
function sedScriptProblem(script) {
  const n = script.length;
  let i = 0;
  const skipLine = () => {
    while (i < n && script[i] !== "\n") {
      i++;
    }
  };
  const skipUntil = (delimiter) => {
    while (i < n && script[i] !== delimiter) {
      i += script[i] === "\\" ? 2 : 1;
    }
    if (i >= n) {
      return false;
    }
    i++;
    return true;
  };
  const skipDigits = () => {
    while (i < n && /\d/.test(script[i])) {
      i++;
    }
  };
  const skipAddress = () => {
    const c = script[i];
    if (c === "/" || c === "\\") {
      const delimiter = c === "\\" ? script[i + 1] : "/";
      i += c === "\\" ? 2 : 1;
      if (delimiter === undefined || !skipUntil(delimiter)) {
        return false;
      }
      while (i < n && "IM".includes(script[i])) {
        i++;
      }
      return true;
    }
    if (/\d/.test(c)) {
      skipDigits();
      if (script[i] === "~") {
        i++;
        skipDigits();
      }
      return true;
    }
    if (c === "$") {
      i++;
      return true;
    }
    if (c === "+" || c === "~") {
      i++;
      skipDigits();
      return true;
    }
    return false;
  };

  while (i < n) {
    while (i < n && /[\s;]/.test(script[i])) {
      i++;
    }
    if (i >= n) {
      break;
    }
    if (script[i] === "#") {
      skipLine();
      continue;
    }
    if (script[i] === "}" || script[i] === "{") {
      i++;
      continue;
    }

    if (skipAddress()) {
      while (script[i] === " ") {
        i++;
      }
      if (script[i] === ",") {
        i++;
        while (script[i] === " ") {
          i++;
        }
        if (!skipAddress()) {
          return "해석할 수 없는 sed 주소";
        }
      }
    }
    while (i < n && (script[i] === " " || script[i] === "!")) {
      i++;
    }

    const command = script[i++];
    if (command === "s") {
      const delimiter = script[i++];
      if (delimiter === undefined || delimiter === "\n" || delimiter === "\\") {
        return "해석할 수 없는 sed s 명령";
      }
      if (!skipUntil(delimiter) || !skipUntil(delimiter)) {
        return "닫히지 않은 sed s 명령";
      }
      const start = i;
      while (i < n && !/[\s;}]/.test(script[i])) {
        i++;
      }
      const flags = script.slice(start, i);
      if (!/^[gpiImM0-9]*$/.test(flags)) {
        return `sed s 플래그(${flags})는 파일 쓰기·명령 실행을 포함할 수 있다`;
      }
    } else if (command === "y") {
      const delimiter = script[i++];
      if (delimiter === undefined || !skipUntil(delimiter) || !skipUntil(delimiter)) {
        return "닫히지 않은 sed y 명령";
      }
    } else if (command === "a" || command === "i" || command === "c") {
      skipLine();
      while (i < n && script[i - 1] === "\\") {
        i++;
        skipLine();
      }
    } else if (command === "r" || command === "R") {
      skipLine();
    } else if (command === "w" || command === "W") {
      return "sed w/W 명령은 파일에 쓴다";
    } else if (command === "e") {
      return "sed e 명령은 셸 명령을 실행한다";
    } else if (command === "b" || command === "t" || command === "T" || command === ":") {
      while (i < n && !/[\n;]/.test(script[i])) {
        i++;
      }
    } else if (["l", "L", "q", "Q"].includes(command)) {
      skipDigits();
    } else if (!"=dDgGhHnNpPxzF{}".includes(command)) {
      return `알 수 없는 sed 명령(${command})`;
    }
  }
  return null;
}

const SED_LONG_FLAGS = new Set([
  "--quiet",
  "--silent",
  "--regexp-extended",
  "--separate",
  "--null-data",
  "--unbuffered",
  "--posix",
  "--debug",
  "--sandbox",
  "--follow-symlinks",
  "--binary",
]);

function checkSed(args) {
  const scripts = [];
  const files = [];
  let scriptGiven = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      files.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [name, value] = arg.split(/=(.*)/s);
      if (name === "--expression") {
        scripts.push(value ?? args[++i]);
        scriptGiven = true;
      } else if (name === "--line-length") {
        if (value === undefined) {
          i++;
        }
      } else if (!SED_LONG_FLAGS.has(name)) {
        return `sed ${name}은 허용하지 않는다 (-i/--in-place, -f/--file 포함)`;
      }
    } else if (/^-[^-]/.test(arg)) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j];
        if ("nErsuz".includes(letter)) {
          continue;
        }
        if (letter === "e") {
          scripts.push(arg.length > j + 1 ? arg.slice(j + 1) : args[++i]);
          scriptGiven = true;
        } else if (letter === "l") {
          if (j === arg.length - 1) {
            i++;
          }
        } else {
          return `sed -${letter}은 허용하지 않는다 (-i는 파일을 수정하고 -f는 검사할 수 없는 스크립트를 읽는다)`;
        }
        break;
      }
    } else {
      files.push(arg);
    }
  }

  if (!scriptGiven) {
    scripts.push(files.shift());
  }
  for (const script of scripts) {
    if (typeof script !== "string") {
      return "sed 스크립트가 없다";
    }
    const problem = sedScriptProblem(script);
    if (problem !== null) {
      return problem;
    }
  }
  return null;
}

// --- Other commands -----------------------------------------------------------------------------

const FIND_FORBIDDEN = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

// Replaces string literals, regex literals and comments with placeholders so `>` and `|` inside them are not
// mistaken for operators. Returns null for a program it cannot read to the end.
function stripAwkLiterals(program) {
  let out = "";
  let previous = "";
  for (let i = 0; i < program.length; i++) {
    const c = program[i];
    if (c === '"') {
      i++;
      while (i < program.length && program[i] !== '"') {
        i += program[i] === "\\" ? 2 : 1;
      }
      if (i >= program.length) {
        return null;
      }
      out += '""';
      previous = '"';
    } else if (c === "#") {
      while (i + 1 < program.length && program[i + 1] !== "\n") {
        i++;
      }
    } else if (c === "/" && (previous === "" || "\n(,{};!~&|=<>+-*%^?:".includes(previous) || /\b(print|printf|return|in)\s*$/.test(out))) {
      // A slash where an operand is expected starts a regex literal; a `/` inside [...] does not end it.
      let inClass = false;
      i++;
      while (i < program.length && (inClass || program[i] !== "/")) {
        if (program[i] === "\\") {
          i++;
        } else if (program[i] === "[") {
          inClass = true;
        } else if (program[i] === "]") {
          inClass = false;
        }
        i++;
      }
      if (i >= program.length) {
        return null;
      }
      out += "0";
      previous = "0";
    } else {
      out += c;
      if (c !== " " && c !== "\t") {
        previous = c;
      }
    }
  }
  return out;
}

// `print`/`printf` redirect with `>`, `>>` or `|`; the same characters elsewhere are comparisons and `||`.
function awkPrintRedirects(program) {
  const stripped = stripAwkLiterals(program);
  if (stripped === null) {
    return true;
  }
  for (const match of stripped.matchAll(/\bprintf?\b/g)) {
    const statement = stripped.slice(match.index + match[0].length).split(/[;}\n]/, 1)[0];
    if (/>|(?<!\|)\|(?!\|)/.test(statement)) {
      return true;
    }
  }
  return false;
}

function checkAwk(args) {
  let program;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      program = args[i + 1];
      break;
    }
    if (arg === "-F" || arg === "-v") {
      i++;
    } else if (arg.startsWith("-F") || (arg.startsWith("-v") && arg.length > 2)) {
      continue;
    } else if (arg.startsWith("-") && arg !== "-") {
      return `awk ${arg}은 허용하지 않는다 (-F와 -v만 쓴다. -f는 검사할 수 없는 프로그램을 읽는다)`;
    } else {
      program = arg;
      break;
    }
  }
  if (program === undefined) {
    return "awk 프로그램이 없다";
  }
  if (/\b(system|getline)\b|@|\|&/.test(program)) {
    return "awk 프로그램의 system·getline·coprocess(|&)·@ 지시문은 허용하지 않는다";
  }
  return awkPrintRedirects(program) ? "awk의 print/printf 출력 리다이렉션(>, >>)·파이프(|)는 허용하지 않는다" : null;
}

// Flags `nix` may get (name -> number of values that follow). Everything else is denied: --store,
// --accept-flake-config, --option, --allow-unsafe-native-code-during-evaluation and the other setting
// overrides can write the store, run code or change trust. The list comes from the nix 2.34.9 manuals
// (nix3-eval, nix3-search, nix3-path-info, nix3-flake-show, nix3-flake-metadata):
// - evaluation inputs: --expr, --file, --apply, --arg, --argstr, --impure, --inputs-from, --no-registries
// - lock guards: --no-write-lock-file, --no-update-lock-file
// - output shape: --json, --raw, --pretty, --no-pretty, --json-format, --read-only (eval only)
// - listing and sizes: --all-systems, --legacy, --exclude, --closure-size, --human-readable, --size,
//   --sigs, --derivation, --recursive
// - logging and misc: --quiet, --verbose, --print-build-logs, --offline, --help, --version,
//   --extra-experimental-features
const NIX_FLAGS = new Map([
  ["--read-only", 0],
  ["--no-write-lock-file", 0],
  ["--no-update-lock-file", 0],
  ["--json", 0],
  ["--raw", 0],
  ["--pretty", 0],
  ["--no-pretty", 0],
  ["--json-format", 1],
  ["--apply", 1],
  ["--expr", 1],
  ["--file", 1],
  ["--arg", 2],
  ["--argstr", 2],
  ["--impure", 0],
  ["--inputs-from", 1],
  ["--no-registries", 0],
  ["--extra-experimental-features", 1],
  ["--all-systems", 0],
  ["--legacy", 0],
  ["--exclude", 1],
  ["--closure-size", 0],
  ["--human-readable", 0],
  ["--size", 0],
  ["--sigs", 0],
  ["--derivation", 0],
  ["--recursive", 0],
  ["--quiet", 0],
  ["--verbose", 0],
  ["--print-build-logs", 0],
  ["--offline", 0],
  ["--help", 0],
  ["--version", 0],
]);
const NIX_SHORT_FLAGS = new Map([["-f", 1], ["-e", 1], ["-S", 0], ["-s", 0], ["-r", 0], ["-h", 0], ["-v", 0], ["-L", 0]]);

// { words, flags, problem }: positional words, the flag names that were given, and the first flag that is
// not on the allowlist. A flag's values are skipped, so `--expr --store` is an expression.
function parseNixArgs(args) {
  const words = [];
  const flags = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      words.push(...args.slice(i + 1));
      break;
    }
    if (arg.length > 1 && arg.startsWith("-")) {
      const long = arg.startsWith("--");
      const [name, value] = long ? arg.split(/=(.*)/s) : [arg, undefined];
      const table = long ? NIX_FLAGS : NIX_SHORT_FLAGS;
      if (!table.has(name)) {
        return { words, flags, problem: arg };
      }
      flags.add(name);
      if (value === undefined) {
        i += table.get(name);
      }
    } else {
      words.push(arg);
    }
  }
  return { words, flags, problem: null };
}

// nix evaluation can write flake.lock and realize store paths, so each read command must say it will not.
function checkNix(args) {
  const { words, flags, problem } = parseNixArgs(args);
  if (problem !== null) {
    return `nix ${problem}은 허용 목록에 없다 (--store·--option·--write-to·--accept-flake-config·lock 갱신 옵션 등은 허용하지 않는다)`;
  }
  if (flags.has("--help")) {
    return null;
  }
  const [sub, action] = words;
  const readCommand =
    sub === "eval" || sub === "search" || sub === "path-info" || (sub === "flake" && ["show", "metadata", "info"].includes(action));
  if (!readCommand) {
    return `nix ${words.slice(0, 2).join(" ")}은 읽기 전용 허용 목록에 없다 (eval, search, path-info, flake show|metadata|info만 허용)`;
  }
  if (!flags.has("--no-write-lock-file") && !flags.has("--no-update-lock-file")) {
    return "flake.lock을 쓰지 않도록 --no-write-lock-file(또는 --no-update-lock-file)을 붙인다";
  }
  // Only `nix eval` has --read-only in 2.34.9; the other read commands do not instantiate derivations.
  if (sub === "eval" && !flags.has("--read-only")) {
    return "nix eval은 derivation을 만들지 않도록 --read-only를 붙인다";
  }
  return null;
}

const NONE = () => null;

// Each checker returns a reason string or null. A command that is not a key here is denied.
const COMMANDS = {
  git: checkGit,
  gh: checkGh,
  sed: checkSed,
  awk: checkAwk,
  nix: checkNix,
  rg: (args) =>
    forbids(args, { long: ["--pre", "--pre-glob", "--hostname-bin", "--search-zip"], short: "z", value: "ABCEMdefgjmrtT" })
      ? "rg의 --pre/--pre-glob/--hostname-bin/-z는 외부 프로그램을 실행한다"
      : null,
  find: (args) => {
    const bad = args.find((arg) => FIND_FORBIDDEN.has(arg));
    return bad === undefined ? null : `find ${bad}은 삭제·실행·파일 쓰기를 한다`;
  },
  sort: (args) =>
    forbids(args, { long: ["--output", "--compress-program"], short: "o", value: "ktTS" }) ? "sort -o/--output은 파일에 쓴다" : null,
  tree: (args) => (forbids(args, { long: ["--output"], short: "o", value: "IPLHT" }) ? "tree -o는 파일에 쓴다" : null),
  file: (args) => (forbids(args, { long: ["--compile"], short: "C", value: "mfFeP" }) ? "file -C는 파일을 만든다" : null),
  uniq: (args) => (positionals(args, ["-f", "-s", "-w"]).length > 1 ? "uniq의 두 번째 파일 인자는 출력 파일이다" : null),
  date: (args) =>
    forbids(args, { long: ["--set"], short: "s", value: "Irdfv" }) || args.some((arg) => /^\d{8,12}(\.\d{2})?$/.test(arg))
      ? "date는 시스템 시간을 바꿀 수 있는 형태를 허용하지 않는다"
      : null,
  printf: (args) => (forbids(args, { short: "v" }) ? "printf -v는 변수에 쓴다" : null),
  cd: (args) => (args.length <= 1 ? null : "cd는 인자 하나만 허용한다"),
  command: (args) =>
    (args[0] === "-v" || args[0] === "-V") && args.length >= 2 ? null : "command는 -v/-V 조회만 허용한다",
  mise: (args) =>
    ["which", "ls", "list", "current", "where"].includes(args[0]) ? null : "mise는 which|ls|current|where 조회만 허용한다",
  grep: NONE,
  jq: NONE,
  ls: NONE,
  cat: NONE,
  head: NONE,
  tail: NONE,
  wc: NONE,
  stat: NONE,
  which: NONE,
  pwd: NONE,
  echo: NONE,
  cut: NONE,
  tr: NONE,
  diff: NONE,
  realpath: NONE,
  dirname: NONE,
  basename: NONE,
  help: NONE,
  nl: NONE,
  du: NONE,
  test: NONE,
  "[": NONE,
  readlink: NONE,
  uname: NONE,
  type: NONE,
  ps: NONE,
  shasum: NONE,
  sha256sum: NONE,
  md5: NONE,
};

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const WRAPPERS = new Set(["env", "xargs", "sudo", "doas", "nohup", "nice", "time", "builtin", "watch", "timeout", "exec"]);
// A tool asked for its help or version only prints text. `version` is a subcommand name, not a flag: any
// other program may treat it as a file or task (`make version`), so only listed commands (`gh version`) get it.
const HELP_ONLY_ARGS = new Set(["--help", "-h", "--version"]);

function checkCommand(words) {
  const [name, ...args] = words;

  if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(name)) {
    return "변수 할당 접두어는 허용하지 않는다";
  }
  if (name.includes("/")) {
    return "경로로 지정한 명령은 허용하지 않는다 (허용 목록의 명령 이름만 쓴다)";
  }
  if (name === "tee") {
    return "tee는 파일에 쓴다";
  }
  if (name === "eval" || name === "source" || name === ".") {
    return `${name}은 임의 코드를 실행한다`;
  }
  if (SHELLS.has(name)) {
    return `${name}으로 다른 명령을 실행할 수 없다`;
  }
  if (WRAPPERS.has(name)) {
    return `${name}은 다른 명령을 감싸 실행한다`;
  }

  if (args.length === 1 && (HELP_ONLY_ARGS.has(args[0]) || (args[0] === "version" && name !== "command" && Object.hasOwn(COMMANDS, name)))) {
    return null;
  }

  const checker = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (checker === undefined) {
    return `${name}은 읽기 전용 허용 목록에 없다`;
  }
  return checker(args);
}

export function evaluate(input) {
  if (input.tool_name !== "Bash" || !RESTRICTED_AGENTS.has(input.agent_type)) {
    return null;
  }

  const command = input.tool_input?.command;
  if (typeof command !== "string") {
    return null;
  }

  let commands;
  try {
    commands = parseCommands(command);
  } catch (error) {
    if (!(error instanceof Reject)) {
      throw error;
    }
    return { decision: "deny", reason: `${guidance(input.agent_type)}\n막힌 명령: \`${command}\` — ${error.message}` };
  }

  const blocked = [];
  for (const words of commands) {
    const why = checkCommand(words);
    if (why !== null) {
      blocked.push(`막힌 명령: \`${words.join(" ")}\` — ${why}`);
    }
  }
  return blocked.length === 0 ? null : { decision: "deny", reason: `${guidance(input.agent_type)}\n${blocked.join("\n")}` };
}

runHook(evaluate, import.meta.url);
