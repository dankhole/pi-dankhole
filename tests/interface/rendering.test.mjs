import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { after, test } from "node:test";

// Use the installed Pi runtime, not a mock renderer. Override for a different installation.
const root = process.env.PI_PACKAGE_DIR ?? resolve(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())), "../..");
const requirePi = createRequire(join(root, "package.json"));
const fromPi = path => import(pathToFileURL(join(root, path)).href);
const scratch = mkdtempSync(join(tmpdir(), "pi-compact-tools-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = scratch;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(scratch, { recursive: true, force: true });
});
const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styling/index.ts");
const { loadExtensions } = await fromPi("dist/core/extensions/loader.js");
const { ToolExecutionComponent } = await fromPi("dist/modes/interactive/components/tool-execution.js");
const { createAllToolRenderers } = await fromPi("dist/core/tools/renderers/index.js");
const themeModule = await fromPi("dist/modes/interactive/theme/theme.js");
const { initTheme } = themeModule;
const { Text, visibleWidth } = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
initTheme("dark", false);
const builtins = createAllToolRenderers();
async function load(toolNames = []) {
  const loaded = await loadExtensions([extensionPath], scratch);
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.getAllTools = () => toolNames.map(name => ({ name }));
  return loaded.extensions[0];
}
const extension = await load();
const resolver = extension.toolRenderers[0];
const output = text => ({ content: [{ type: "text", text }], details: undefined, isError: false, durationMs: 1250 });
function row(tool, args, custom, resolveRenderer = resolver) {
  return new ToolExecutionComponent(tool, `call-${tool}`, args, { showImages: false, outputPad: 1 },
    resolveRenderer(tool, () => custom ?? builtins[tool]), { requestRender() {} }, scratch);
}
const plain = (component, width = 100) => component.render(width).map(stripVTControlCharacters);
const nonblank = (component, width) => plain(component, width).filter(line => line.trim());

test("adds only question lifecycle tools and never replaces existing tool execution", () => {
  assert.deepEqual([...extension.tools.keys()], ["ask_user", "resolve_question"]);
  assert.deepEqual([...extension.commands.keys()].sort(), ["dankhole", "latest-input", "q", "questions"]);
  assert.equal(extension.commands.has("compact-tools"), false);
  assert.ok(extension.handlers.has("session_start"));
  assert.ok(extension.handlers.has("session_shutdown"));
});

test("question renderer survives every compact override", async () => {
  const path = join(scratch, "compact-tools.json");
  const original = { renderCall: () => new Text("Q1: Choose an option", 0, 0) };
  assert.equal(resolver("ask_user", () => original), original);
  writeFileSync(path, JSON.stringify({ defaultMode: "compact", tools: { ask_user: "compact" } }));
  try {
    const configured = await load();
    assert.equal(configured.toolRenderers[0]("ask_user", () => original), original);
  } finally { rmSync(path, { force: true }); }
});

test("commands and huge successful output occupy one nonblank line", () => {
  const component = row("bash", { command: "echo first\necho " + "very long ".repeat(50) });
  component.markExecutionStarted();
  assert.equal(nonblank(component).length, 1);
  assert.match(nonblank(component)[0], /● bash/);
  component.updateResult(output("line\n".repeat(200)));
  assert.equal(nonblank(component).length, 1);
  assert.match(nonblank(component)[0], /✓ bash.*1\.3s/);
  assert.equal(plain(component).length, 2); // Pi retains one inter-message blank line.
});

test("stable summaries survive result updates without skipping downstream renderers", () => {
  const args = { code: "tools.read({}); tools.bash({}); tools.read({}); " + "// padding\n".repeat(10000) };
  let calls = 0;
  let results = 0;
  const component = row("codemode", args, {
    renderCall() { calls++; return new Text("native call", 0, 0); },
    renderResult() { results++; return new Text("native result", 0, 0); },
  });
  const cached = component.rendererState.summary;
  const initialCalls = calls;
  let compact;
  for (let index = 0; index < 100; index++) {
    component.updateResult(output("updated"));
    if (index === 0) compact = component.rendererState.compactCall.component;
    else assert.equal(component.rendererState.compactCall.component, compact, "unchanged compact rows reuse their layout component");
  }
  assert.equal(component.rendererState.summary, cached, "unchanged arguments reuse the computed summary");
  assert.equal(calls - initialCalls, 100, "native lifecycle still runs for every update");
  assert.equal(results, 100);
  args.code = "tools.edit({}); tools.write({}); tools.bash({}); tools.read({}); tools.extra({});";
  component.updateArgs(args);
  assert.notEqual(component.rendererState.summary, cached, "in-place argument edits invalidate the summary");
  assert.match(nonblank(component, 200)[0], /edit, write, bash, read, …/);
  args.script = "tools.fallback({});";
  args.code = "";
  component.updateArgs(args);
  assert.match(nonblank(component)[0], /script/);
  delete args.code;
  component.updateArgs(args);
  assert.match(nonblank(component)[0], /fallback/, "empty code takes precedence but absent code uses script");
});

test("summary cache tracks selected fields, fallback keys and working directory", () => {
  const args = { description: "\n", path: join(scratch, "file.ts") };
  const component = row("read", args, {});
  assert.match(nonblank(component)[0], /file\.ts/);
  args.description = "changed description";
  component.updateArgs(args);
  assert.match(nonblank(component)[0], /changed description/);
  delete args.description; delete args.path;
  args.first = 1;
  component.updateArgs(args);
  assert.match(nonblank(component)[0], /first/);
  delete args.first; args.second = 2;
  component.updateArgs(args);
  assert.match(nonblank(component)[0], /second/);
  const renderers = resolver("read", () => undefined);
  const state = {};
  const context = { state, cwd: scratch, outputPad: 0, expanded: false, isPartial: false, isError: false };
  const path = join(scratch, "nested", "file.ts");
  assert.match(plain(renderers.renderCall({ path }, themeModule.theme, context))[0], /nested\/file\.ts/);
  context.cwd = join(scratch, "nested");
  assert.doesNotMatch(plain(renderers.renderCall({ path }, themeModule.theme, context))[0], /nested\//);
});

test("tool types have distinct full-width backgrounds in dark and light themes", () => {
  try {
    for (const appearance of ["dark", "light"]) {
      initTheme(appearance, false);
      const backgrounds = [];
      for (const tool of ["read", "bash", "edit", "write", "codemode", "Agent"]) {
        const component = row(tool, { path: "sample.ts", command: "echo test" });
        component.updateResult(output("done"));
        const lines = component.render(100);
        assert.equal(lines.length, 2);
        assert.equal(visibleWidth(lines[1]), 100);
        const background = lines[1].match(/\x1b\[48;[25];[\d;]+m/)?.[0];
        assert.ok(background, `${tool} needs a ${appearance} background`);
        backgrounds.push(background);
        assert.equal(component.render(40)[1].match(/\x1b\[48;[25];[\d;]+m/)?.[0], background);
        component.setExpanded(true);
        assert.ok(component.render(100).some(line => line.includes(background)));
      }
      assert.equal(new Set(backgrounds).size, backgrounds.length, `distinct ${appearance} colors`);
    }
  } finally { initTheme("dark", false); }
});

test("backgrounds can use status colors or be disabled", async () => {
  const path = join(scratch, "compact-tools.json");
  try {
    for (const backgrounds of ["status", "none"]) {
      writeFileSync(path, JSON.stringify({ backgrounds }));
      const configured = (await load()).toolRenderers[0];
      const component = row("bash", { command: "test" }, undefined, configured);
      component.updateResult(output("done"));
      const success = component.render(100)[1].match(/\x1b\[48;[25];[\d;]+m/)?.[0];
      component.updateResult({ ...output("failed"), isError: true });
      const failure = component.render(100)[1].match(/\x1b\[48;[25];[\d;]+m/)?.[0];
      if (backgrounds === "none") {
        assert.equal(success, undefined);
        assert.equal(failure, undefined);
      } else {
        assert.ok(success);
        assert.ok(failure);
        assert.notEqual(success, failure);
      }
      assert.equal(nonblank(component).length, 1);
    }
  } finally { rmSync(path, { force: true }); }
});

test("streaming results stay compact and native timers are cleared on completion", () => {
  const component = row("bash", { command: "stream" });
  component.markExecutionStarted();
  try {
    component.updateResult(output("partial output\n".repeat(100)), true);
    assert.equal(nonblank(component).length, 1);
    component.setExpanded(true);
    assert.match(plain(component).join("\n"), /partial output/);
    component.setExpanded(false);
  } finally { component.updateResult(output("finished")); }
  assert.equal(nonblank(component).length, 1);
  assert.equal(component.rendererState.nativeState.interval, undefined);
});

test("click expands and collapses the actual native shell component", () => {
  const component = row("bash", { command: "echo full-command" });
  component.updateResult(output("full-result"));
  const click = { type: "click", button: "left", x: 4, y: 1, width: 100, height: 2 };
  plain(component); // Calculates the hit region height.
  assert.equal(component.handleMouse(click)?.handled, true);
  assert.match(plain(component).join("\n"), /full-result/);
  component.handleMouse(click);
  assert.equal(nonblank(component).length, 1);
});

test("edit diffs and write contents are compact, with native details on expansion", () => {
  for (const tool of ["edit", "write"]) {
    const component = row(tool, { path: "sample.ts", content: "written-body\n".repeat(50) });
    component.updateResult({ ...output("done"), details: { diff: "-1 old-value\n+1 new-value", firstChangedLine: 1 } });
    assert.equal(nonblank(component).length, 1);
    component.setExpanded(true);
    assert.match(plain(component).join("\n"), tool === "edit" ? /new-value/ : /written-body/);
    component.setExpanded(false);
    assert.equal(nonblank(component).length, 1);
  }
});

test("codemode, MCP and subagent calls also use compact rows", () => {
  const code = "text(await tools.read({path:'x'})); text(await tools.bash({command:'ls'}));";
  for (const [tool, args] of [["codemode", { code }], ["mcp__example", { query: "search" }], ["Agent", { description: "Review implementation", prompt: "large prompt" }]]) {
    const component = row(tool, args);
    component.updateResult(output("large-result\n".repeat(100)));
    assert.equal(nonblank(component).length, 1);
    if (tool === "codemode") assert.match(nonblank(component)[0], /read, bash/);
    component.setExpanded(true);
    assert.match(plain(component).join("\n"), /large-result/);
  }
});

test("errors stay visibly failed but single-line by default", () => {
  const component = row("bash", { command: "false" });
  component.updateResult({ ...output("specific failure\nstack trace"), isError: true });
  assert.equal(nonblank(component).length, 1);
  assert.match(nonblank(component)[0], /✗ bash/);
  component.setExpanded(true);
  assert.match(plain(component).join("\n"), /specific failure/);
});

test("width constraints, unicode, partial args and terminal controls", () => {
  for (const args of [undefined, {}, { command: "😀界é\t\n\x1b[31mred\x1b[0m\x07".repeat(50) }]) {
    const component = row("bash", args);
    component.updateResult(output(""));
    for (const width of [1, 2, 5, 12, 40, 100]) {
      const lines = plain(component, width);
      assert.equal(lines.length, 2);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
        assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/);
      }
    }
  }
});

test("preserves downstream shared state and component reuse across toggles", () => {
  const states = [];
  const original = {
    renderCall(_args, _theme, context) {
      states.push(context.state);
      if (context.lastComponent) assert.ok(context.lastComponent instanceof Text);
      context.state.callSeen = true;
      const text = context.lastComponent ?? new Text("", 0, 0);
      text.setText("native call");
      return text;
    },
    renderResult(_result, _options, _theme, context) {
      assert.equal(context.state.callSeen, true);
      if (context.lastComponent) assert.ok(context.lastComponent instanceof Text);
      return context.lastComponent ?? new Text("native result", 0, 0);
    },
  };
  const component = row("custom", {}, original);
  component.updateResult(output("raw"));
  component.setExpanded(true);
  assert.match(plain(component).join("\n"), /native result/);
  component.setExpanded(false);
  assert.equal(nonblank(component).length, 1);
  assert.ok(states.every(state => state === states[0]));
});

test("broken custom renderers cannot force a giant collapsed fallback", () => {
  const broken = () => { throw new Error("renderer failed"); };
  const component = row("custom", { query: "query" }, { renderCall: broken, renderResult: broken });
  component.updateResult(output("raw-result"));
  assert.equal(nonblank(component).length, 1);
  component.setExpanded(true);
  assert.match(plain(component).join("\n"), /raw-result/);
});

test("settings load per-tool overrides and optional error previews", async () => {
  const path = join(scratch, "compact-tools.json");
  writeFileSync(path, JSON.stringify({ defaultMode: "compact", errorPreview: true, tools: { edit: "normal" } }));
  try {
    const configured = (await load()).toolRenderers[0];
    assert.equal(configured("edit", () => builtins.edit), builtins.edit);
    const component = row("bash", { command: "false" }, undefined, configured);
    component.updateResult({ ...output("visible failure\nmore detail"), isError: true });
    assert.equal(nonblank(component).length, 2);
    assert.match(nonblank(component)[1], /visible failure/);
  } finally { rmSync(path); }
});

test("settings dialog saves changes and reloads when idle", async () => {
  const path = join(scratch, "compact-tools.json");
  let reloaded = false;
  const notices = [];
  const command = extension.commands.get("dankhole");
  try {
    await command.handler("", {
      mode: "tui", isIdle: () => true, reload: async () => { reloaded = true; },
      ui: {
        notify: (...args) => notices.push(args),
        custom: factory => new Promise(resolve => {
          const component = factory({ requestRender() {} }, themeModule.theme, {}, resolve);
          const menu = nonblank(component);
          assert.match(menu[0], /Pi Dankhole settings/);
          assert.match(menu[2], /Keep awake while working \(macOS\).*off/);
          assert.match(menu.join("\n"), /Default tool view/);
          assert.match(menu.join("\n"), /Per-tool options/);
          assert.doesNotMatch(menu.join("\n"), /\bbash\b|\bread\b|\bcodemode\b/);
          component.handleInput("\x1b[B"); // keep-awake -> default view
          component.handleInput("\r"); // compact -> normal
          component.handleInput("\x1b"); // save and close
        }),
      },
    });
    assert.deepEqual(notices, []);
    assert.equal(reloaded, true);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).defaultMode, "normal");
  } finally { rmSync(path, { force: true }); }
});

test("settings save refuses a concurrent edit without overwriting it", async () => {
  const path = join(scratch, "compact-tools.json");
  const notices = [];
  const concurrent = JSON.stringify({ defaultMode: "normal", tools: { read: "compact" } });
  try {
    await extension.commands.get("dankhole").handler("", {
      mode: "tui", isIdle: () => true,
      reload: async () => { assert.fail("must not reload after a save conflict"); },
      ui: {
        notify: (...args) => notices.push(args),
        custom: factory => new Promise(resolve => {
          const component = factory({ requestRender() {} }, themeModule.theme, {}, resolve);
          component.handleInput("\x1b[A"); // keep-awake -> per-tool options
          component.handleInput("\r");
          component.handleInput("bash");
          component.handleInput("\r"); // default -> compact
          writeFileSync(path, concurrent);
          component.handleInput("\x1b"); // submenu only goes back
          assert.equal(readFileSync(path, "utf8"), concurrent);
          assert.deepEqual(notices, []);
          component.handleInput("\x1b"); // main menu attempts the save
        }),
      },
    });
    assert.match(notices[0][0], /changed in another session/);
    assert.equal(readFileSync(path, "utf8"), concurrent);
  } finally { rmSync(path, { force: true }); }
});

test("per-tool options search all tools, retain edits on reopen, and save only from the main menu", async () => {
  const path = join(scratch, "compact-tools.json");
  const raw = JSON.stringify({ defaultMode: "normal", tools: { unavailable_tool: "normal" } });
  writeFileSync(path, raw);
  let reloads = 0;
  let closes = 0;
  try {
    const configured = await load([
      ...Array.from({ length: 30 }, (_, index) => `remote_tool_${index}`),
      "bash", "bash", "__proto__",
    ]);
    await configured.commands.get("dankhole").handler("", {
      mode: "tui", isIdle: () => true, reload: async () => { reloads++; },
      ui: {
        notify: message => assert.fail(message),
        custom: factory => new Promise(resolve => {
          const component = factory({ requestRender() {} }, themeModule.theme, {}, () => { closes++; resolve(); });
          const view = () => nonblank(component, 120).map(line => line.trimEnd()).join("\n");
          const back = () => {
            component.handleInput("\x1b");
            assert.match(view(), /Pi Dankhole settings\n/);
            assert.match(view(), /Esc to save and close/);
            assert.equal(readFileSync(path, "utf8"), raw);
            assert.equal(reloads, 0);
            assert.equal(closes, 0);
          };
          const search = name => {
            component.handleInput("\r"); // reopen the selected submenu
            assert.match(view(), /^Per-tool options\n/);
            assert.match(view(), /Type to search.*Esc to go back/);
            assert.doesNotMatch(view(), /Esc to save|Esc to cancel|Pi Dankhole settings/);
            component.handleInput(name);
          };
          component.handleInput("\x1b[A"); // first -> last main-menu item
          component.handleInput("\r");
          assert.match(view(), /\(1\/37\)/); // builtins, unique registered names, and saved unavailable tools
          back();
          for (const name of ["read", "bash", "edit", "write", "codemode"]) {
            search(name);
            assert.match(view(), new RegExp(`${name} +default`));
            back();
          }
          search("remote_tool_29");
          assert.match(view(), /remote_tool_29 +default/);
          assert.doesNotMatch(view(), /remote_tool_28/);
          component.handleInput("\r");
          assert.match(view(), /remote_tool_29 +compact/);
          back();
          search("remote_tool_29");
          assert.match(view(), /remote_tool_29 +compact/); // unsaved edit survives reopening
          back();
          search("__proto__");
          assert.match(view(), /__proto__ +default/);
          component.handleInput("\r");
          assert.match(view(), /__proto__ +compact/);
          back();
          search("unavailable_tool");
          assert.match(view(), /unavailable_tool +normal/);
          component.handleInput("\r"); // normal -> default deletes the override
          assert.match(view(), /unavailable_tool +default/);
          back();
          search("unavailable_tool");
          assert.match(view(), /unavailable_tool +default/);
          back();
          component.handleInput("\x1b[B"); // wrap to keep-awake
          component.handleInput("\r");
          component.handleInput("\x1b");
        }),
      },
    });
    assert.equal(closes, 1);
    assert.equal(reloads, 1);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(settings.keepAwake, true);
    assert.equal(settings.defaultMode, "normal");
    assert.deepEqual(settings.tools, JSON.parse('{"remote_tool_29":"compact","__proto__":"compact"}'));
    assert.equal(Object.hasOwn(settings.tools, "unavailable_tool"), false);
    const reloaded = await load(["__proto__"]);
    assert.equal(reloaded.tools.size, 2); // both question tools load; the special-key override remains valid on disk
  } finally { rmSync(path, { force: true }); }
});

test("unchanged per-tool submenus never save or reload, including full value cycles", async () => {
  const path = join(scratch, "compact-tools.json");
  try {
    for (const raw of [undefined, '{ "tools": { "read": "normal" } }\n']) {
      if (raw !== undefined) writeFileSync(path, raw);
      for (const cycle of [false, true]) {
        let closes = 0;
        await extension.commands.get("dankhole").handler("", {
          mode: "tui", isIdle: () => true,
          reload: async () => assert.fail("unchanged settings must not reload"),
          ui: {
            notify: message => assert.fail(message),
            custom: factory => new Promise(resolve => {
              const component = factory({ requestRender() {} }, themeModule.theme, {}, () => { closes++; resolve(); });
              component.handleInput("\x1b[A");
              component.handleInput("\r");
              component.handleInput("no_such_tool");
              assert.match(plain(component).join("\n"), /No matching settings/);
              component.handleInput("\x1b");
              assert.equal(closes, 0);
              component.handleInput("\r");
              component.handleInput("read");
              if (cycle) for (let index = 0; index < 3; index++) component.handleInput("\r");
              component.handleInput("\x1b");
              assert.equal(closes, 0);
              component.handleInput("\x1b");
            }),
          },
        });
        assert.equal(closes, 1);
        assert.equal(existsSync(path), raw !== undefined);
        if (raw !== undefined) assert.equal(readFileSync(path, "utf8"), raw);
      }
    }
  } finally { rmSync(path, { force: true }); }
});

test("per-tool edits save without reloading if the agent becomes busy", async () => {
  const path = join(scratch, "compact-tools.json");
  const notices = [];
  let idle = true;
  try {
    await extension.commands.get("dankhole").handler("", {
      mode: "tui", isIdle: () => idle,
      reload: async () => assert.fail("must not reload a busy agent"),
      ui: {
        notify: (...args) => notices.push(args),
        custom: factory => new Promise(resolve => {
          const component = factory({ requestRender() {} }, themeModule.theme, {}, resolve);
          component.handleInput("\x1b[A");
          component.handleInput("\r");
          component.handleInput("bash");
          component.handleInput("\r");
          idle = false;
          component.handleInput("\x1b");
          assert.equal(existsSync(path), false);
          component.handleInput("\x1b");
        }),
      },
    });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).tools, { bash: "compact" });
    assert.equal(notices.length, 1);
    assert.match(notices[0][0], /Settings saved.*\/reload when idle/);
    assert.equal(notices[0][1], "info");
  } finally { rmSync(path, { force: true }); }
});

test("consecutive grouping defaults on and the settings dialog persists off", async () => {
  const path = join(scratch, "compact-tools.json");
  let reloaded = false;
  try {
    await extension.commands.get("dankhole").handler("", {
      mode: "tui", isIdle: () => true, reload: async () => { reloaded = true; },
      ui: {
        notify: message => assert.fail(message),
        custom: factory => new Promise(resolve => {
          const component = factory({ requestRender() {} }, themeModule.theme, {}, resolve);
          assert.match(plain(component).join("\n"), /Group consecutive tool calls.*on/);
          component.handleInput("\x1b[B"); // keep-awake -> default view
          component.handleInput("\x1b[B"); // default view -> grouping
          component.handleInput("\r"); // on -> off
          component.handleInput("\x1b"); // save and close
        }),
      },
    });
    assert.equal(reloaded, true);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).groupConsecutive, false);
  } finally { rmSync(path, { force: true }); }
});

test("invalid consecutive grouping settings leave native rendering in place", async () => {
  const path = join(scratch, "compact-tools.json");
  writeFileSync(path, JSON.stringify({ groupConsecutive: "yes" }));
  try {
    const invalid = await load();
    assert.equal(invalid.toolRenderers[0]("bash", () => builtins.bash), builtins.bash);
    assert.ok(invalid.handlers.has("session_start"));
  } finally { rmSync(path, { force: true }); }
});

test("new UI settings default on and persist independently", async () => {
  const path = join(scratch, "compact-tools.json");
  try {
    for (const [label, steps, key] of [
      ["Powerline input and status", 5, "powerlineStatus"],
      ["Interactive questions", 7, "questionUI"],
      ["Code block panels", 8, "textBlockPanels"],
      ["Conversation panels", 9, "assistantPanels"],
      ["Collapse finished thinking", 10, "collapseThinking"],
    ]) {
      let reloaded = false;
      await extension.commands.get("dankhole").handler("", {
        mode: "tui", isIdle: () => true, reload: async () => { reloaded = true; },
        ui: {
          notify: message => assert.fail(message),
          custom: factory => new Promise(resolve => {
            const component = factory({ requestRender() {} }, themeModule.theme, {}, resolve);
            assert.match(plain(component).join("\n"), new RegExp(`${label}.*on`));
            for (let index = 0; index < steps; index++) component.handleInput("\x1b[B");
            component.handleInput("\r");
            component.handleInput("\x1b");
          }),
        },
      });
      assert.equal(reloaded, true);
      const settings = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(settings[key], false);
      assert.equal(settings[key === "powerlineStatus" ? "questionUI" : "powerlineStatus"], true);
      rmSync(path);
    }
  } finally { rmSync(path, { force: true }); }
});

test("compaction countdown cutoff defaults to 20%, accepts custom bounds, and saves independently", async () => {
  const path = join(scratch, "compact-tools.json");
  try {
    for (const [configured, initial, next] of [[undefined, 20, 30], [0, 0, 5], [23, 23, 30], [100, 100, 0]]) {
      if (configured === undefined) rmSync(path, { force: true });
      else writeFileSync(path, JSON.stringify({ compactionNoticePercent: configured, tools: { read: "normal" } }));
      let reloads = 0;
      const loaded = await load();
      assert.equal(loaded.tools.size, 2);
      await loaded.commands.get("dankhole").handler("", {
        mode: "tui", isIdle: () => true, reload: async () => { reloads++; },
        ui: {
          notify: message => assert.fail(message),
          custom: factory => new Promise(resolve => {
            const component = factory({ requestRender() {} }, themeModule.theme, {}, resolve);
            assert.match(plain(component).join("\n"), new RegExp(`Compaction countdown cutoff +${initial}%`));
            for (let index = 0; index < 6; index++) component.handleInput("\x1b[B");
            component.handleInput("\r");
            assert.match(plain(component).join("\n"), new RegExp(`Compaction countdown cutoff +${next}%`));
            component.handleInput("\x1b");
          }),
        },
      });
      const saved = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(saved.compactionNoticePercent, next);
      assert.equal(saved.keepAwake, false);
      assert.equal(saved.questionUI, true);
      assert.deepEqual(saved.tools, configured === undefined ? {} : { read: "normal" });
      assert.equal(reloads, 1);
    }
  } finally { rmSync(path, { force: true }); }
});

test("invalid compaction countdown cutoffs fail safely without rewriting settings", async () => {
  const path = join(scratch, "compact-tools.json");
  try {
    for (const value of [-1, 101, 20.5, "20", null, true, {}, []]) {
      const raw = JSON.stringify({ compactionNoticePercent: value, keepAwake: true });
      writeFileSync(path, raw);
      const invalid = await load();
      assert.equal(invalid.toolRenderers[0]("bash", () => builtins.bash), builtins.bash);
      assert.equal(invalid.tools.size, 0);
      assert.equal(invalid.handlers.has("agent_settled"), false);
      assert.equal(readFileSync(path, "utf8"), raw);
    }
  } finally { rmSync(path, { force: true }); }
});

test("invalid new UI settings fail open without rewriting the config", async () => {
  const path = join(scratch, "compact-tools.json");
  try {
    for (const key of ["powerlineStatus", "questionUI", "textBlockPanels", "assistantPanels", "collapseThinking"]) {
      const raw = JSON.stringify({ [key]: "on" });
      writeFileSync(path, raw);
      const invalid = await load();
      assert.equal(invalid.toolRenderers[0]("bash", () => builtins.bash), builtins.bash);
      assert.equal(invalid.tools.size, 0);
      assert.equal(readFileSync(path, "utf8"), raw);
    }
  } finally { rmSync(path, { force: true }); }
});

test("keep-awake defaults off, saves independently, and only registers after reloading", async () => {
  const path = join(scratch, "compact-tools.json");
  const settledHandlers = extension.handlers.get("agent_settled")?.length ?? 0;
  let reloaded = false;
  try {
    await extension.commands.get("dankhole").handler("", {
      mode: "tui", isIdle: () => true, reload: async () => { reloaded = true; },
      ui: {
        notify: message => assert.fail(message),
        custom: factory => new Promise(resolve => {
          const component = factory({ requestRender() {} }, themeModule.theme, {}, resolve);
          assert.match(plain(component).join("\n"), /Keep awake while working \(macOS\).*off/);
          component.handleInput("\r"); // first main-menu setting
          component.handleInput("\x1b");
        }),
      },
    });
    assert.equal(reloaded, true);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(settings.keepAwake, true);
    assert.equal(settings.collapseThinking, true);
    assert.equal(extension.handlers.get("agent_settled")?.length ?? 0, settledHandlers);
    const configured = await load();
    assert.equal(configured.handlers.get("agent_settled")?.length ?? 0,
      settledHandlers + (process.platform === "darwin" ? 1 : 0));
  } finally { rmSync(path, { force: true }); }
});

test("invalid keep-awake or another invalid field never enables keep-awake or rewrites config", async () => {
  const path = join(scratch, "compact-tools.json");
  try {
    for (const value of ["on", 1, null, {}, []]) {
      const raw = JSON.stringify({ keepAwake: value });
      writeFileSync(path, raw);
      const invalid = await load();
      assert.equal(invalid.toolRenderers[0]("bash", () => builtins.bash), builtins.bash);
      assert.equal(invalid.handlers.has("agent_settled"), false);
      assert.equal(readFileSync(path, "utf8"), raw);
    }
    const raw = JSON.stringify({ keepAwake: true, groupConsecutive: "invalid" });
    writeFileSync(path, raw);
    const invalid = await load();
    assert.equal(invalid.handlers.has("agent_settled"), false);
    assert.equal(readFileSync(path, "utf8"), raw);
  } finally { rmSync(path, { force: true }); }
});

test("settings dialog refuses to reload a running agent", async () => {
  const notices = [];
  await extension.commands.get("dankhole").handler("", {
    mode: "tui", isIdle: () => false,
    ui: { notify: (...args) => notices.push(args) },
  });
  assert.match(notices[0][0], /idle/);
});

test("malformed settings fail back to native rendering, without overwriting", async () => {
  const path = join(scratch, "compact-tools.json");
  writeFileSync(path, "{bad json");
  try {
    const invalid = await load();
    assert.equal(invalid.toolRenderers[0]("bash", () => builtins.bash), builtins.bash);
    assert.equal(readFileSync(path, "utf8"), "{bad json");
    assert.ok(invalid.handlers.has("session_start"));
  } finally { rmSync(path); }
});
