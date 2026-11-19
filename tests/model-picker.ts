import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { ThinkingLevel as OmpThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUiComponent } from "@oh-my-pi/pi-coding-agent";
import type { Component, TUI, Theme, KeybindingsManager } from "@oh-my-pi/pi-tui";

const dir = await mkdtemp(join(tmpdir(), "omp-model-picker-test-"));
process.env.OMP_PROFILE = "default";
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_CONFIG_DIR = dir;
process.argv = [process.argv[0], fileURLToPath(import.meta.url), "--models", "anthropic/claude-sonnet-4-6:high,anthropic/claude-haiku-4-5:low"];

try {
    // OMP caches its directories on first import.
    const { ThinkingLevel } = await import("@oh-my-pi/pi-agent-core/thinking");
    const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
    const { getBundledModel } = await import("@oh-my-pi/pi-catalog/models");
    const { getKeybindings, getThemeByName, visibleWidth } = await import("@oh-my-pi/pi-tui");
    await Settings.init({ inMemory: true, cwd: dir, agentDir: dir });
    const { default: modelPicker } = await import("../extensions/model-picker.js");
    const theme = await getThemeByName("dark");
    assert(theme);
    const sonnet = getBundledModel("anthropic", "claude-sonnet-4-6");
    const haiku = getBundledModel("anthropic", "claude-haiku-4-5");
    const opus = getBundledModel("anthropic", "claude-opus-4-6");
    const models = [sonnet, haiku, opus, { ...haiku, id: "unknown-window", contextWindow: null }];
    const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
    let selected = sonnet;
    let thinking: OmpThinkingLevel | undefined = ThinkingLevel.High;
    let appliedThinking: OmpThinkingLevel | undefined;
    let interact: (component: Component) => void;
    // The test supplies only the API members the picker uses.
    modelPicker({
        registerCommand: (name, command) => commands.set(name, command),
        registerShortcut() {},
        on() {},
        getThinkingLevel: () => thinking,
        setThinkingLevel: (level) => { appliedThinking = level; },
        setModel: async (model) => { selected = model; return true; },
    } satisfies Pick<ExtensionAPI, "registerCommand" | "registerShortcut" | "on" | "getThinkingLevel" | "setThinkingLevel" | "setModel"> as unknown as ExtensionAPI);
    // Omit Pi-only context fields deliberately to catch OMP compatibility regressions.
    const context = {
        mode: "tui",
        get model() { return selected; },
        models: { list: () => models },
        modelRegistry: { getAvailable: () => models },
        ui: {
            notify() {},
            custom: async <T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: T) => void) => ExtensionUiComponent | Promise<ExtensionUiComponent>) => {
                let result!: T;
                // Rendering only requests redraws; it does not need a real terminal here.
                const tui = { requestRender() {} } as TUI;
                const component = await factory(tui, theme, getKeybindings(), (value) => { result = value; });
                interact(component);
                return result;
            },
        },
    } as unknown as ExtensionCommandContext;
    const frame = (component: Component, width = 140) => component.render(width).join("\n");
    const input = (component: Component, data: string) => component.handleInput!(data);

    // No Pi-only scopedModels, thinkingLevel, or provider-display-name API exists here.
    interact = (component) => {
        assert.match(frame(component), /2 models/);
        assert.match(frame(component), /high/);
        input(component, "\t");
        assert.match(frame(component), /4 models/);
        for (const width of [24, 80, 140]) {
            assert(component.render(width).every(line => visibleWidth(line) <= width));
        }
        input(component, "\t");
        for (const key of ["\x1b[104u", "a", "i", "k", "u"]) input(component, key);
        assert.match(frame(component), /1\/2 models/);
        assert.match(frame(component), /▸low/);
        input(component, "\x1b[C");
        input(component, "\r");
    };
    await commands.get("model-picker")!.handler("", context);
    assert.equal(selected.id, haiku.id);
    assert.equal(appliedThinking, "medium");
    // Selecting without an explicit level must not turn automatic/default thinking off.
    process.argv = process.argv.slice(0, 2);
    selected = sonnet;
    thinking = undefined;
    appliedThinking = undefined;
    interact = (component) => input(component, "\r");
    await commands.get("model-picker")!.handler("", context);
    assert.equal(selected.id, sonnet.id);
    assert.equal(appliedThinking, undefined);
    selected = opus;
    interact = (component) => {
        input(component, "\x1b[D");
        assert.match(frame(component), /▸max/);
        assert.match(stripVTControlCharacters(frame(component, 80)), /\bmax\b/);
        input(component, "\r");
    };
    await commands.get("model-picker")!.handler("", context);
    assert.equal(selected.id, opus.id);
    assert.equal(appliedThinking, "max");
    console.log("PASS: native OMP scope, rendering, filtering, max thinking selection, and default-thinking preservation");
} finally {
    await rm(dir, { recursive: true, force: true });
}
