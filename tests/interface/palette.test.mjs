import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { after, test } from "node:test";

const root = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const requirePi = createRequire(join(root, "package.json"));
const fromPi = path => import(pathToFileURL(join(root, path)).href);
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
  "@earendil-works/pi-tui": requirePi.resolve("@earendil-works/pi-tui"),
} });
const { assistantBackground, userBackground, conversationProse, toolBackground, toolChromeText, toolStatusText, paint } = await jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styling/palette.ts"));
const { backgroundAnsi, colorToRgb, parseColor, styleText, Text } = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
const { questionStyle } = await jiti.import(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/questions/question-palette.ts"));
const { loadExtensions } = await fromPi("dist/core/extensions/loader.js");
const { ToolExecutionComponent } = await fromPi("dist/modes/interactive/components/tool-execution.js");
const themes = await fromPi("dist/modes/interactive/theme/theme.js");
const scratch = mkdtempSync(join(tmpdir(), "compact-tools-palette-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = scratch;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(scratch, { recursive: true, force: true });
});
const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styling/index.ts");
const tools = ["read", "bash", "powershell", "edit", "write", "codemode", "Agent", "grep", "find", "ls", "__proto__", ...Array.from({ length: 24 }, (_, i) => `custom_${i}`)];
const ansiColor = ansi => {
  const [, mode, channels] = ansi.match(/\x1b\[(?:38|48);([25]);([\d;]+)m/) ?? [];
  assert.ok(mode, JSON.stringify(ansi));
  if (mode === "5") return colorToRgb(parseColor(Number(channels)));
  const [r, g, b] = channels.split(";").map(Number);
  return { r, g, b };
};
function assertWarmOrNeutral(ansi) {
  const { r, g, b } = ansiColor(ansi);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), spread = max - min;
  if (spread < 12) return; // Quantization may make a subtle fill neutral.
  const hue = ((max === r ? (g - b) / spread : max === g ? (b - r) / spread + 2 : (r - g) / spread + 4) * 60 + 360) % 360;
  assert.ok(hue < 90 || hue > 260, `tool color must not be blue/green: ${JSON.stringify({ r, g, b, hue })}`);
}
function theme(appearance, mode) {
  return { appearance, getColorMode: () => mode, style: (text, options) => styleText(text, options, mode) };
}

test("all tool palette families and status cues exclude conversation blue/green in truecolor and 256-color", () => {
  for (const appearance of ["dark", "light"]) {
    for (const mode of ["truecolor", "256color"]) {
      const t = theme(appearance, mode);
      for (const tool of tools) {
        const bg = toolBackground(t, tool, "tool", "success");
        assertWarmOrNeutral(bg);
        assert.equal(toolBackground(t, tool, "tool", "error"), bg, "per-tool identity is stable across status");
      }
      for (const status of ["success", "pending", "error"]) {
        assertWarmOrNeutral(toolBackground(t, "read", "status", status));
        assertWarmOrNeutral(toolStatusText(t, status, "✓ ● ✗"));
      }
      for (const tone of ["text", "muted", "dim"]) assertWarmOrNeutral(toolChromeText(t, "tool chrome", tone));
      const distinct = ["read", "bash", "edit", "write", "codemode", "Agent"].map(tool => toolBackground(t, tool, "tool", "success"));
      assert.equal(new Set(distinct).size, distinct.length, `${appearance}/${mode}: common tool families stay distinct`);
      const { r, g, b } = ansiColor(assistantBackground(t));
      assert.ok(b > r && b > g, `${appearance}/${mode}: assistant is blue in every emitted mode`);
      const { r: ur, g: ug, b: ub } = ansiColor(userBackground(t));
      assert.ok(ug > ur && ug > ub, `${appearance}/${mode}: user fill is green`);
      assert.equal(toolBackground(t, "read", "none", "success"), "");
    }
  }
});

// Measure emitted ANSI values, including the lossy 256-color conversion, rather
// than source hex values. Native payload syntax/diffs are intentionally excluded.
const contrast = (foreground, background) => {
  const luminance = ansi => {
    const { r, g, b } = ansiColor(ansi);
    return [r, g, b].map(channel => channel / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  };
  const fg = luminance(foreground), bg = luminance(background);
  return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
};

test("emitted ANSI contrast audit for conversation/tool panels and read-only neighboring palettes", () => {
  const report = [];
  const failures = [];
  for (const appearance of ["dark", "light"]) for (const mode of ["truecolor", "256color"]) {
    const t = themes.loadThemeFromPath(join(root, `dist/modes/interactive/theme/${appearance}.json`), mode);
    const minima = new Map();
    const check = (category, label, foreground, background, target = 4.5) => {
      const ratio = contrast(foreground, background);
      const pair = { category, label, ratio, fg: ansiColor(foreground), bg: ansiColor(background) };
      if (!minima.has(category) || ratio < minima.get(category).ratio) minima.set(category, pair);
      if (ratio < target) failures.push({ appearance, mode, ...pair, target });
    };
    // Native body/title/output tokens are included where our fill changes their
    // background; code/diff tokens remain native and are not recolored or claimed.
    check("assistantBody", "text", t.fg("text", "answer"), assistantBackground(t));
    check("userBody", "userMessageText", t.fg("userMessageText", "input"), userBackground(t));
    for (const [tone, token] of Object.entries({ heading: "mdHeading", link: "mdLink", linkUrl: "mdLinkUrl", quote: "mdQuote", quoteBorder: "mdQuoteBorder", hr: "mdHr", listBullet: "mdListBullet" })) {
      const foreground = conversationProse(t, tone, "prose") ?? t.fg(token, "prose");
      check("assistantProse", token, foreground, assistantBackground(t));
      check("userProse", token, foreground, userBackground(t));
    }
    // Preserved payload foregrounds are read-only reference checks when a code
    // line inherits the conversation surface. Explicit payload backgrounds and
    // external highlighters are not covered by these theme-token samples.
    for (const token of Object.keys(t.colors).filter(token => /^(mdCode|syntax|toolDiff)/.test(token))) {
      check("assistantNativePayload", token, t.fg(token, "payload"), assistantBackground(t));
      check("userNativePayload", token, t.fg(token, "payload"), userBackground(t));
    }
    for (const name of tools) for (const status of ["success", "pending", "error"]) {
      for (const backgrounds of ["tool", "status"]) {
        const bg = toolBackground(t, name, backgrounds, status);
        for (const tone of ["text", "muted", "dim"]) check("toolChromeText", `${name}/${backgrounds}/${status}/${tone}`, toolChromeText(t, "label", tone), bg);
        check("toolStateIcons", `${name}/${backgrounds}/${status}`, toolStatusText(t, status, "✓ ● ✗"), bg);
        for (const token of ["toolTitle", "toolOutput"]) check("toolExpandedNativeText", `${name}/${backgrounds}/${status}/${token}`, t.fg(token, "output"), bg);
      }
      check("groupFooter", status, toolStatusText(t, status, "footer"), toolBackground(t, "", "status", status));
    }
    const questionPair = (category, tone, surface, target) => {
      const value = questionStyle(t, "sample", tone, surface);
      const fg = value.match(/\x1b\[38;[25];[\d;]+m/)[0];
      const bg = value.match(/\x1b\[48;[25];[\d;]+m/)[0];
      check(category, `${tone}/${surface}`, fg, bg, target);
    };
    for (const surface of ["surface", "choice", "focused", "selected"]) {
      for (const tone of ["text", "muted", "accent", "success", "warning"]) questionPair("popupText", tone, surface);
    }
    questionPair("popupBorder", "border", "surface", 3);
    for (const surface of ["choice", "question"]) for (const tone of ["text", "muted", "warning", "success"]) questionPair("questionTranscript", tone, surface);
    // These foreground-only metrics inherit the terminal background. The black/
    // white fallback is a stated reference, not a guarantee for user terminals.
    const terminalBg = backgroundAnsi(parseColor(appearance === "dark" ? "#000000" : "#ffffff"), mode);
    for (const field of ["model", "folder", "rule", "thinking", "context", "input", "output", "cost", "elapsed"]) check("metricsOnFallbackTerminal", field, paint(t, field, "metric"), terminalBg);
    report.push({ appearance, mode, minima: [...minima.values()] });
  }
  if (process.env.PALETTE_CONTRAST_REPORT) {
    console.log("PALETTE_REPORT " + JSON.stringify(report));
    console.log("PALETTE_READONLY_FAILURES " + JSON.stringify(failures.filter(value => ["assistantNativePayload", "userNativePayload", "metricsOnFallbackTerminal", "popupText", "popupBorder", "questionTranscript"].includes(value.category))));
  }
  // The owning component tests also exercise full rendered containment/layout.
  // Neighboring palettes are audited read-only; their owners handle any failures.
  const owned = failures.filter(value => ["assistantBody", "assistantProse", "userBody", "userProse", "toolChromeText", "toolStateIcons", "toolExpandedNativeText", "groupFooter", "metricsOnFallbackTerminal"].includes(value.category));
  assert.deepEqual(owned, [], "extension-painted body text and state cues meet 4.5:1 after quantization");
});

test("plain terminals add no palette escapes", () => {
  const previous = { TERM: process.env.TERM, NO_COLOR: process.env.NO_COLOR };
  try {
    for (const variable of ["TERM", "NO_COLOR"]) {
      if (variable === "TERM") process.env.TERM = "dumb"; else process.env.NO_COLOR = "";
      const t = theme("dark", "truecolor");
      assert.equal(assistantBackground(t), "");
      assert.equal(userBackground(t), "");
      assert.equal(conversationProse(t, "link", "label"), undefined);
      for (const mode of ["tool", "status", "none"]) assert.equal(toolBackground(t, "read", mode, "success"), "");
      assert.equal(toolStatusText(t, "success", "✓ done"), "✓ done");
      assert.equal(toolChromeText(t, "read path"), "read path");
      for (const key of ["TERM", "NO_COLOR"]) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
    }
  } finally {
    for (const key of ["TERM", "NO_COLOR"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test("real compact and expanded tool panels use the new fills without recoloring code/diff payloads", async () => {
  try {
    for (const backgrounds of ["tool", "status", "none"]) {
      writeFileSync(join(scratch, "compact-tools.json"), JSON.stringify({ backgrounds }));
      const loaded = await loadExtensions([extensionPath], scratch);
      assert.deepEqual(loaded.errors, []);
      const resolver = loaded.extensions[0].toolRenderers[0];
      for (const appearance of ["dark", "light"]) {
        themes.initTheme(appearance, false);
        for (const name of tools) {
          const payload = "\x1b[38;2;0;128;255mcode\x1b[39m \x1b[48;2;0;64;0mdiff\x1b[49m";
          const native = { renderCall: () => new Text("native call", 0, 0), renderResult: () => new Text(payload, 0, 0) };
          const component = new ToolExecutionComponent(name, `palette-${name}`, {}, { showImages: false, outputPad: 1 }, resolver(name, () => native), { requestRender() {} }, scratch);
          for (const status of ["pending", "success", "error"]) {
            if (status !== "pending") component.updateResult({ content: [{ type: "text", text: "result" }], details: undefined, isError: status === "error" });
            const compact = component.render(80).find(line => stripVTControlCharacters(line).trim());
            const bg = toolBackground(themes.theme, name, backgrounds, status);
            if (bg) assert.ok(compact.includes(bg), `${appearance}/${backgrounds}/${name}/${status}`);
            else assert.doesNotMatch(compact, /\x1b\[48;/);
            const icon = status === "error" ? "✗" : status === "pending" ? "·" : "✓";
            assert.ok(compact.includes(toolStatusText(themes.theme, status, icon)));
            assert.ok(compact.includes(toolChromeText(themes.theme, name)));
          }
          component.setExpanded(true);
          const expanded = component.render(80).join("\n");
          assert.ok(expanded.includes("\x1b[38;2;0;128;255mcode"));
          assert.ok(expanded.includes("\x1b[48;2;0;64;0mdiff"));
          if (backgrounds !== "none") assert.ok(expanded.includes(toolBackground(themes.theme, name, backgrounds, "error")));
        }
      }
    }
  } finally { themes.initTheme("dark", false); }
});
