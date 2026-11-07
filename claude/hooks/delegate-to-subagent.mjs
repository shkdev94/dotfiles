// PreToolUse: deny work tools in the main conversation so it delegates to subagents.
// Subagent calls carry agent_id; main-conversation calls do not.
import { runHook } from "./run-hook.mjs";

export function evaluate(input) {
  if (typeof input.agent_id === "string") {
    return null;
  }

  return {
    decision: "deny",
    reason: `메인 대화에서는 ${input.tool_name} 도구를 직접 쓰지 않는다. Agent 도구로 서브에이전트에 작업을 맡기고, 보고받은 결과는 직접 확인한 사실과 구분해 전달한다.`,
  };
}

runHook(evaluate, import.meta.url);
