// Shared stdin/stdout handling for PreToolUse hooks.
// `evaluate` returns null to defer to the normal permission flow,
// or { decision: "deny" | "ask", reason } to override it.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function runHook(evaluate, moduleUrl) {
  // Node resolves `import.meta.url` to the real path but leaves `argv[1]` as
  // invoked, so resolve symlinks before comparing (~/.claude/hooks is a symlink).
  if (moduleUrl !== pathToFileURL(realpathSync(process.argv[1])).href) {
    return;
  }

  const result = evaluate(JSON.parse(readFileSync(0, "utf8")));
  if (result === null) {
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: result.decision,
        permissionDecisionReason: result.reason,
      },
    }),
  );
}
