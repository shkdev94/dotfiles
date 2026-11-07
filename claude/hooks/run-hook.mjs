// Shared stdin/stdout handling for PreToolUse hooks.
// `evaluate` returns null to defer to the normal permission flow,
// or { decision: "deny" | "ask", reason } to override it.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function runHook(evaluate, moduleUrl) {
  if (moduleUrl !== pathToFileURL(process.argv[1]).href) {
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
