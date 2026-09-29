import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function remainingPercent(used: number | null | undefined): number | undefined {
  if (used == null || !Number.isFinite(used)) return undefined;
  return Math.round(Math.max(0, Math.min(100, 100 - used)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function weeklyRemaining(response: unknown): number | undefined {
  if (!isRecord(response) || !isRecord(response.rate_limit)) return undefined;
  for (const window of [response.rate_limit.primary_window, response.rate_limit.secondary_window]) {
    if (isRecord(window) && window.limit_window_seconds === 604800 && typeof window.used_percent === "number") {
      return remainingPercent(window.used_percent);
    }
  }
  return undefined;
}

function isCodexEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return url.origin === "https://chatgpt.com" && url.pathname.replace(/\/+$/, "") === "/backend-api";
  } catch {
    return false;
  }
}

function credentialScope(apiKey: string, headers: Record<string, string | null> = {}): string {
  const account = Object.entries(headers).find(([name]) => name.toLowerCase() === "chatgpt-account-id")?.[1];
  return createHash("sha256").update(apiKey).update("\0").update(account ?? "").digest("hex");
}

export function gitChanges(porcelain: string): string {
  const entries = porcelain.split("\0").filter(Boolean);
  let count = 0;
  for (let index = 0; index < entries.length; index++) {
    count++;
    // A rename/copy has a second NUL-separated path, not a second change.
    if (/[RC]/.test(entries[index].slice(0, 2))) index++;
  }
  return count === 0 ? "No changes" : `${count} change${count === 1 ? "" : "s"}`;
}

function modelLabel(id: string): string {
  return id.replace(/^gpt-/, "GPT-").replace(/-(sol|astra|luna|terra)$/, (_, family: string) =>
    `-${family[0].toUpperCase()}${family.slice(1)}`,
  );
}

export default function footer(pi: ExtensionAPI): void {
  let current: ExtensionContext | undefined;
  let refreshGit: (() => Promise<void>) | undefined;
  let refreshQuota: (() => Promise<void>) | undefined;
  let disposeFooter: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    current = ctx;
    if (ctx.mode !== "tui") return;
    disposeFooter?.();

    ctx.ui.setFooter((tui, theme, data) => {
      let changes = "Git …";
      let disposed = false;
      let refreshing = false;
      let quotaRefreshing = false;
      let quota: number | undefined;
      let quotaScope: string | undefined;
      let nextQuotaRefresh = 0;
      const controller = new AbortController();

      const updateQuota = async (): Promise<void> => {
        if (disposed || quotaRefreshing) return;
        const active = current ?? ctx;
        const model = active.model;
        if (model?.provider !== "openai-codex") {
          quota = undefined;
          quotaScope = undefined;
          nextQuotaRefresh = 0;
          tui.requestRender();
          return;
        }
        quotaRefreshing = true;
        try {
          const auth = await active.modelRegistry.getApiKeyAndHeaders(model);
          if (!auth.ok || !auth.apiKey || !isCodexEndpoint(auth.baseUrl ?? model.baseUrl)) {
            throw new Error("Codex usage authentication unavailable");
          }
          const scope = credentialScope(auth.apiKey, auth.headers);
          if (quotaScope !== scope) {
            quotaScope = scope;
            quota = undefined;
            nextQuotaRefresh = 0;
            tui.requestRender();
          }
          if (Date.now() < nextQuotaRefresh) return;
          nextQuotaRefresh = Date.now() + 60000;
          const headers = new Headers();
          for (const [name, value] of Object.entries(auth.headers ?? {})) {
            if (value !== null) headers.set(name, value);
          }
          headers.set("Authorization", `Bearer ${auth.apiKey}`);
          const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
            headers,
            redirect: "error",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          });
          if (!response.ok) throw new Error("Codex usage request failed");
          const report: unknown = await response.json();
          const latest = current ?? ctx;
          const latestModel = latest.model;
          const latestAuth = latestModel?.provider === "openai-codex"
            ? await latest.modelRegistry.getApiKeyAndHeaders(latestModel) : undefined;
          if (!disposed) {
            // Discard a response if account credentials changed while it was in flight.
            quota = latestAuth?.ok && latestAuth.apiKey
              && credentialScope(latestAuth.apiKey, latestAuth.headers) === scope
              && isCodexEndpoint(latestAuth.baseUrl ?? latestModel?.baseUrl)
              ? weeklyRemaining(report) : undefined;
            if (quota === undefined) nextQuotaRefresh = 0;
            tui.requestRender();
          }
        } catch {
          if (!disposed) {
            quota = undefined;
            nextQuotaRefresh = Date.now() + 10000;
            tui.requestRender();
          }
        } finally {
          quotaRefreshing = false;
        }
      };

      const refresh = async (): Promise<void> => {
        if (disposed || refreshing) return;
        refreshing = true;
        try {
          const result = await pi.exec("git", ["status", "--porcelain=v1", "-z"], {
            cwd: ctx.cwd,
            timeout: 2000,
            signal: controller.signal,
          });
          if (!disposed) {
            changes = result.code === 0 && !result.killed ? gitChanges(result.stdout) : "Git unavailable";
            tui.requestRender();
          }
        } catch {
          if (!disposed) {
            changes = "Git unavailable";
            tui.requestRender();
          }
        } finally {
          refreshing = false;
        }
      };

      refreshGit = refresh;
      refreshQuota = updateQuota;
      const unsubscribe = data.onBranchChange(() => {
        void refresh();
        tui.requestRender();
      });
      const timer = setInterval(() => void refresh(), 5000);
      const quotaTimer = setInterval(() => void updateQuota(), 5000);
      void refresh();
      void updateQuota();

      const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        controller.abort();
        clearInterval(timer);
        clearInterval(quotaTimer);
        unsubscribe();
        if (refreshGit === refresh) refreshGit = undefined;
        if (refreshQuota === updateQuota) refreshQuota = undefined;
        if (disposeFooter === dispose) disposeFooter = undefined;
      };
      disposeFooter = dispose;

      return {
        invalidate() {},
        dispose,
        render(width): string[] {
          if (width <= 2) return [" ".repeat(Math.max(0, width))];
          const contentWidth = width - 2;
          const active = current ?? ctx;
          const home = homedir();
          const cwd = active.cwd === home ? "~" : active.cwd.startsWith(`${home}/`)
            ? `~${active.cwd.slice(home.length)}` : active.cwd;
          const remaining = remainingPercent(active.getContextUsage()?.percent);
          const statuses = data.getExtensionStatuses();
          const pathSegment = theme.fg("success", cwd);
          const segments = [
            theme.fg("accent", `${modelLabel(active.model?.id ?? "No model")} ${pi.getThinkingLevel()}`),
            pathSegment,
          ];
          const branch = data.getGitBranch();
          const branchSegment = branch ? theme.fg("mdLink", branch) : "";
          const changesSegment = branch ? theme.fg("mdLink", changes) : "";
          if (branch) {
            segments.push(branchSegment, changesSegment);
          }
          const contextColor: ThemeColor = remaining !== undefined && remaining <= 20 ? "error" : "warning";
          segments.push(theme.fg(contextColor, `Context ${remaining === undefined ? "?" : `${remaining}%`} left`));
          if (active.model?.provider === "openai-codex") {
            segments.push(theme.fg("thinkingXhigh", `weekly ${quota === undefined ? "?" : `${quota}%`} left`));
          }
          const extra = [...statuses.values()].map(value => theme.fg("dim", value.replace(/[\r\n]+/g, " ")));
          segments.push(...extra);
          const separator = theme.fg("dim", " · ");
          // Keep model, context and quota visible when the terminal narrows.
          for (const optional of [...extra.reverse(), pathSegment, changesSegment, branchSegment]) {
            if (visibleWidth(segments.join(separator)) <= contentWidth) break;
            const index = segments.indexOf(optional);
            if (index >= 0) segments.splice(index, 1);
          }
          return [` ${truncateToWidth(segments.join(separator), contentWidth)} `];
        },
      };
    });
  });

  pi.on("model_select", (_event, ctx) => {
    current = ctx;
    void refreshQuota?.();
  });
  pi.on("turn_start", (_event, ctx) => {
    current = ctx;
    void refreshQuota?.();
  });
  pi.on("agent_end", () => refreshGit?.());
  pi.on("tool_execution_end", () => refreshGit?.());
  pi.on("session_shutdown", () => {
    disposeFooter?.();
    current = undefined;
  });
}
