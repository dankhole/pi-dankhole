import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const statusKey = "compact-tools:chat-timer";

function formatElapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** Add wall-clock session age to the normal footer without replacing it. */
export function registerTimer(pi: ExtensionAPI, enabled: boolean): void {
  if (!enabled) return;

  let interval: ReturnType<typeof setInterval> | undefined;
  let ui: ExtensionContext["ui"] | undefined;
  const stop = () => {
    if (interval !== undefined) clearInterval(interval);
    interval = undefined;
    ui?.setStatus(statusKey, undefined);
    ui = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui?.setStatus !== "function") return;

    const timestamp = ctx.sessionManager.getHeader()?.timestamp;
    const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    const startedAt = Number.isFinite(parsed) ? parsed : Date.now();
    ui = ctx.ui;
    let lastValue: string | undefined;
    const refresh = () => {
      const value = formatElapsed(Date.now() - startedAt);
      if (value === lastValue) return;
      lastValue = value;
      ctx.ui.setStatus(statusKey, value);
    };
    refresh();
    interval = setInterval(refresh, 1000);
    interval.unref();
  });

  // Pi emits this before /reload, session replacement, and normal shutdown.
  pi.on("session_shutdown", stop);
}
