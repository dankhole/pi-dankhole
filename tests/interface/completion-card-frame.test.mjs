import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const requirePi = createRequire(join(root, "package.json"));
const fromPi = path => import(pathToFileURL(join(root, path)).href);
const tuiPath = dirname(requirePi.resolve("@earendil-works/pi-tui"));
const { Container, Markdown, Text, stripTerminalSequences } = await import(pathToFileURL(join(tuiPath, "index.js")).href);
const { renderLayoutFrame } = await import(pathToFileURL(join(tuiPath, "layout.js")).href);
const { createChatViewport } = await fromPi("dist/modes/interactive/chat-viewport.js");
const { UserMessageComponent } = await fromPi("dist/modes/interactive/components/user-message.js");
const { CustomMessageComponent } = await fromPi("dist/modes/interactive/components/custom-message.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
themes.initTheme("dark", false);
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
  "@earendil-works/pi-tui": requirePi.resolve("@earendil-works/pi-tui"),
} });
const source = path => jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src", path));
const { CompletionCards } = await source("workers/ui/completion-card.ts");
const { installPinnedPrompt } = await source("styling/pinned-prompt.ts");
const { installGrouping } = await source("styling/grouping.ts");
const { defaults } = await source("settings/interface.ts");
const { TranscriptMeasurement } = await source("styling/transcript-measurement.ts");

for (const scrollbar of ["hidden", "auto", "always"]) for (const expanded of [false, true]) {
  test(`warm native frame + pinned measurement skips completion layouts (${scrollbar}, expanded=${expanded})`, () => {
    let markdownRenders = 0;
    let paints = 0;
    let cardDepth = 0;
    let measurementDepth = 0;
    let measurementPasses = 0;
    const widths = { native: [], measurement: [] };
    const originalMarkdown = Markdown.prototype.render;
    const originalMeasurement = TranscriptMeasurement.prototype.render;
    const cardTheme = new Proxy(themes.theme, { get(target, key) {
      if (key === "fg") return (...args) => { paints++; return target.fg(...args); };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const chat = new Container();
    const header = new Container(); header.addChild(new Text("Header", 0, 0));
    const document = new Container();
    document.addChild(header); document.addChild(new Container()); document.addChild(chat);
    chat.addChild(new UserMessageComponent("Selected prompt"));
    for (let index = 0; index < 17; index++) {
      const details = { id: `worker-${index}`, description: "Inspect 認証 👩‍💻", status: index % 2 ? "error" : "completed",
        error: "Could not verify rollback.", resultPreview: "**No failures** in 認証.\n\n" + "Detail e\u0301\n".repeat(15),
        durationMs: 65000, totalCost: 0.75, toolUses: 2, turnCount: 1, maxTurns: 30, totalTokens: 1234,
        outputFile: "/tmp/synthetic-worker.output", invocation: { modelName: "Sol", thinking: "high" } };
      const message = new CustomMessageComponent({ role: "custom", customType: "subagent-notification",
        content: "Captured result", display: true, details, timestamp: 0 }, (_message, options) => {
        const card = new CompletionCards(details, options.expanded, cardTheme, true);
        const render = card.render;
        card.render = function(width) {
          widths[measurementDepth ? "measurement" : "native"].push(width);
          cardDepth++;
          try { return render.call(this, width); }
          finally { cardDepth--; }
        };
        return card;
      });
      message.setExpanded(expanded);
      chat.addChild(message);
    }
    const viewport = createChatViewport({ document, pendingMessages: new Container(), status: new Container(),
      widgetsAbove: new Container(), editor: new Text("Editor", 0, 0), footer: new Text("Footer", 0, 0), scrollbar });
    const tui = { mode: "fullscreen", children: [document], layoutRoot: viewport.root,
      terminal: { columns: 80, rows: 20 }, requestRender() {} };
    // Keep both default adapters enabled. Custom notifications remain individual
    // entries even though grouping projects the surrounding transcript.
    const ungroup = installGrouping(tui, defaults(), { theme: () => themes.theme, requestRender() {}, warn: assert.fail });
    const pinned = installPinnedPrompt(tui, () => themes.theme, () => ({ id: "prompt", text: "Selected prompt", displayed: true,
      rows: [{ id: "prompt", kind: "UserMessageComponent" }] }), assert.fail);
    assert.ok(pinned, "the real host layout accepts pinning");
    Markdown.prototype.render = function(width) {
      if (cardDepth) markdownRenders++;
      return originalMarkdown.call(this, width);
    };
    TranscriptMeasurement.prototype.render = function(component, width) {
      const measuringDocument = component === document;
      if (measuringDocument) { measurementPasses++; measurementDepth++; }
      try { return originalMeasurement.call(this, component, width); }
      finally { if (measuringDocument) measurementDepth--; }
    };
    const reset = () => {
      markdownRenders = 0; paints = 0; measurementPasses = 0;
      widths.native.length = 0; widths.measurement.length = 0;
    };
    const frame = () => renderLayoutFrame(viewport.root, tui.terminal.columns, tui.terminal.rows, () => {});
    try {
      // Owned grouping now supports the follow-end suffix shortcut. Scrollback
      // deliberately exercises master's full two-pass measurement/gutter contract;
      // the worker layout integration separately covers normal follow-end frames.
      frame();
      viewport.transcript.scrollTo(10, { disableFollow: true });
      for (const columns of [11, 23, 39, 80, 160]) {
        tui.terminal.columns = columns;
        reset();
        const cold = frame();
        assert.equal(markdownRenders, 17, "each changed width lays out each completion once, not once per pass");
        assert.ok(paints > 0);
        reset();
        const warm = frame();
        assert.ok(measurementPasses > 0, "the identified prompt exercises pinned transcript measurement");
        assert.ok(widths.measurement.length >= 17, "measurement traverses every completion");
        assert.ok(widths.native.length >= 17, "native host layout traverses every completion");
        const contentWidth = viewport.transcript.getContentWidth(columns);
        assert.deepEqual([...new Set([...widths.native, ...widths.measurement])], [contentWidth],
          "measurement and native layout use exactly the same effective content width, including scrollbar gutter");
        // Public render() still serves cached arrays to each host pass. Count
        // actual Markdown layout + card painting, not these cheap cache hits.
        assert.equal(markdownRenders, 0, "warm frames perform zero completion Markdown renders");
        assert.equal(paints, 0, "warm frames never enter the completion painting/truncation path");
        assert.deepEqual(warm.lines, cold.lines, "cache hits preserve the complete native frame");
        if (columns >= 80) assert.ok(warm.lines.some(line => stripTerminalSequences(line).includes("↑ You: Selected prompt")));
      }
    } finally {
      Markdown.prototype.render = originalMarkdown;
      TranscriptMeasurement.prototype.render = originalMeasurement;
      pinned.dispose();
      ungroup();
    }
  });
}
