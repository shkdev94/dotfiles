import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { SectionNavigation, type NavigationCommand } from "./navigation.ts";

function commandFor(data: string): NavigationCommand {
  if (matchesKey(data, "f6")) return "toggle";
  if (matchesKey(data, "up")) return "previous";
  if (matchesKey(data, "down")) return "next";
  if (matchesKey(data, "enter")) return "activate";
  if (matchesKey(data, "escape")) return "exit";
  return "other";
}

export default function sectionNavigation(pi: ExtensionAPI): void {
  let navigation: SectionNavigation | undefined;
  let unsubscribe: (() => void) | undefined;
  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    navigation?.dispose();
    navigation = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    cleanup();
    if (ctx.mode !== "tui") return;
    let unavailable: string | undefined;
    ctx.ui.setWidget("section-navigation", (tui, theme) => {
      try {
        navigation = new SectionNavigation(tui, message => ctx.ui.notify(message, "warning"));
      } catch (error) {
        unavailable = error instanceof Error ? error.message : String(error);
      }
      return {
        invalidate() {},
        dispose: cleanup,
        render(width) {
          const hint = navigation?.hint;
          return hint ? [truncateToWidth(theme.fg("accent", hint), width)] : [];
        },
      };
    });
    unsubscribe = ctx.ui.onTerminalInput(data => {
      const command = commandFor(data);
      if (isKeyRelease(data)) {
        if (command !== "other" && navigation?.active) return { consume: true };
        return;
      }
      if (unavailable && command === "toggle") {
        ctx.ui.notify(`섹션 탐색을 사용할 수 없습니다: ${unavailable}`, "warning");
        return { consume: true };
      }
      if (navigation?.handle(command)) return { consume: true };
    });
  });
  pi.on("session_tree", () => navigation?.leave());
  pi.on("session_compact", () => navigation?.leave());
  pi.on("session_shutdown", cleanup);
}
