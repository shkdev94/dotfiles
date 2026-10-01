import { createConnection, type Socket } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PromptCommand = { type: "prompt"; text: string };

export default function nvim(pi: ExtensionAPI): void {
  const socketPath = process.env.PI_NVIM_SOCKET;
  if (!socketPath) return;

  let socket: Socket | undefined;
  let lastError = false;

  const emit = (message: Record<string, unknown>) => {
    if (socket?.writable) socket.write(`${JSON.stringify(message)}\n`);
  };

  pi.on("session_start", (_event, ctx) => {
    socket?.destroy();
    lastError = false;
    let incoming = "";
    const connection = createConnection(socketPath);
    socket = connection;
    connection.on("connect", () => {
      emit({
        type: "hello",
        pid: process.pid,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        name: ctx.sessionManager.getSessionName(),
      });
    });
    connection.on("data", chunk => {
      incoming += chunk.toString("utf8");
      if (incoming.length > 1_000_000) {
        connection.destroy();
        return;
      }
      let newline = incoming.indexOf("\n");
      while (newline !== -1) {
        const line = incoming.slice(0, newline);
        incoming = incoming.slice(newline + 1);
        try {
          const command = JSON.parse(line) as PromptCommand;
          if (command.type === "prompt" && typeof command.text === "string" && command.text.trim()) {
            pi.sendUserMessage(command.text, { deliverAs: "followUp", expandPromptTemplates: true });
          }
        } catch (error) {
          emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
        newline = incoming.indexOf("\n");
      }
    });
    connection.on("error", () => {
      connection.destroy();
    });
  });

  pi.on("agent_start", () => {
    lastError = false;
    emit({ type: "working" });
  });
  pi.on("message_end", event => {
    if (event.message.role === "assistant") lastError = event.message.stopReason === "error";
  });
  pi.on("agent_settled", () => emit({ type: "settled", error: lastError }));
  pi.on("session_info_changed", event => emit({ type: "name", name: event.name ?? null }));
  pi.on("session_shutdown", () => {
    socket?.destroy();
    socket = undefined;
  });
}
