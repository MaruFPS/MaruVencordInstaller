/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vencordRoot = process.env.VENCORD_ROOT ?? "C:/Users/User/Documents/Vencord";
const require = createRequire(path.join(vencordRoot, "package.json"));
const { build } = require("esbuild");
const workRoot = path.resolve(process.env.MARU_TEST_WORK ?? path.join(bundleRoot, "../../work"));
const sourceRoot = path.join(bundleRoot, "src/userplugins/maruActivityPanel");
const settle = () => new Promise(resolve => setImmediate(resolve));
let harnessId = 0;

function settingsDefaults() {
    return {
        showPanel: true, expanded: false, showWorkspace: true, showFile: true,
        showCursor: true, showDuration: true, showRepository: true, hideInactive: true,
        position: "above", bridgeToken: "test-paired-secret-012345678901234567890", bridgePort: 32145
    };
}

function fakeNative(options = {}) {
    const pending = new Set();
    const calls = { start: [], stop: 0, wait: [] };
    let revision = 0;
    return {
        calls, pending,
        async start(token, port) {
            calls.start.push({ token, port });
            if (options.start) return options.start(token, port);
            return { revision: ++revision, activity: null };
        },
        async stop() {
            calls.stop++;
            for (const finish of pending) finish({ revision: ++revision, activity: null });
            pending.clear();
        },
        waitForActivity(after) {
            calls.wait.push(after);
            if (options.wait) return options.wait(after);
            return new Promise(resolve => pending.add(resolve));
        },
        emit(change) {
            const value = { revision: ++revision, activity: null, ...change };
            for (const finish of pending) finish(value);
            pending.clear();
            return value;
        }
    };
}

async function loadHarness(t, { panel = false, native = fakeNative(), config = {} } = {}) {
    mkdirSync(workRoot, { recursive: true });
    const directory = mkdtempSync(path.join(workRoot, "renderer-tests-"));
    const key = `__maruRendererHarness${++harnessId}`;
    let changed = () => {};
    const harness = {
        running: true,
        snapshot: { revision: 0, activity: null },
        snapshotReads: 0,
        cleanups: [],
        stateUpdates: [],
        settings: { store: { ...settingsDefaults(), ...config }, use() { return this.store; } },
        onSettingsChanged(listener) { changed = listener; },
        changeSettings(update) { Object.assign(this.settings.store, update); changed(); },
        createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
        useEffect(effect) { const cleanup = effect(); if (cleanup) harness.cleanups.push(cleanup); },
        useState(initial) { return [typeof initial === "function" ? initial() : initial, value => harness.stateUpdates.push(value)]; }
    };
    globalThis[key] = harness;
    const outfile = path.join(directory, "renderer.cjs");
    await build({
        entryPoints: [path.join(sourceRoot, panel ? "Panel.tsx" : "source.ts")],
        outfile, bundle: true, platform: "node", format: "cjs", target: "node22",
        jsx: "transform", jsxFactory: "React.createElement", jsxFragment: "React.Fragment",
        logLevel: "silent",
        plugins: [{
            name: "actual-renderer-with-host-boundaries-mocked",
            setup(builder) {
                builder.onResolve({ filter: /^@utils\/types$/ }, () => ({ path: "types", namespace: "maru-test" }));
                builder.onResolve({ filter: /^\.\/settings$/ }, () => ({ path: "settings", namespace: "maru-test" }));
                if (panel) {
                    builder.onResolve({ filter: /^@webpack\/common$/ }, () => ({ path: "react", namespace: "maru-test" }));
                    builder.onResolve({ filter: /^\.\/source$/ }, () => ({ path: "source", namespace: "maru-test" }));
                }
                builder.onLoad({ filter: /.*/, namespace: "maru-test" }, args => {
                    const prelude = `const harness = globalThis[${JSON.stringify(key)}];`;
                    const modules = {
                        types: "export const PluginNative = undefined;",
                        settings: "export const settings = harness.settings; export const onSourceSettingsChanged = listener => harness.onSettingsChanged(listener);",
                        react: "export const React = { createElement: harness.createElement, useSyncExternalStore: (_subscribe, get) => get() }; export const useEffect = harness.useEffect; export const useState = harness.useState;",
                        source: "export const activitySource = { isRunning: () => harness.running, subscribe: () => () => {}, getSnapshot: () => { harness.snapshotReads++; return harness.snapshot; } };"
                    };
                    return { contents: prelude + modules[args.path], loader: "js" };
                });
            }
        }]
    });
    const previousNative = globalThis.VencordNative;
    globalThis.VencordNative = { pluginHelpers: { MaruActivityPanel: native } };
    let module;
    try { module = require(outfile); }
    finally {
        if (previousNative === undefined) delete globalThis.VencordNative;
        else globalThis.VencordNative = previousNative;
    }
    t.after(async () => {
        module.activitySource?.stop();
        await settle();
        for (const cleanup of harness.cleanups.splice(0)) cleanup();
        delete globalThis[key];
        delete require.cache[outfile];
        // The checked temporary target is a direct child of the intended work directory.
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), workRoot);
        assert.ok(path.basename(resolved).startsWith("renderer-tests-"));
        rmSync(resolved, { recursive: true, force: true });
    });
    return { ...module, harness, native };
}

test("actual renderer source reports missing desktop native helpers and stops cleanly", async t => {
    const { activitySource: source } = await loadHarness(t, { native: null });
    source.start();
    await settle();
    assert.equal(source.isRunning(), true);
    assert.match(source.getSnapshot().error, /Desktop native bridge unavailable/);
    source.stop();
    await settle();
    assert.equal(source.isRunning(), false);
    assert.equal(source.getSnapshot().activity, null);
});

test("actual source publishes live changes, suppresses unchanged timeouts, and unsubscribes", async t => {
    const { activitySource: source, native } = await loadHarness(t);
    let notifications = 0;
    const unsubscribe = source.subscribe(() => notifications++);
    source.start();
    await settle();
    assert.equal(native.calls.start.length, 1);
    assert.equal(native.pending.size, 1);
    const genuine = { file: "source.ts", workspace: "project", status: "coding" };
    native.emit({ activity: genuine });
    await settle();
    assert.equal(source.getSnapshot().activity, genuine);
    const before = notifications;
    const timeout = { ...source.getSnapshot() };
    native.emit(timeout);
    await settle();
    assert.equal(notifications, before, "unchanged long-poll timeout should not rerender the panel");
    unsubscribe();
    native.emit({ activity: { ...genuine, file: "other.ts" } });
    await settle();
    assert.equal(notifications, before);
    source.stop();
    await settle();
    assert.equal(native.pending.size, 0);
    assert.equal(source.isRunning(), false);
});

test("rapid settings changes cancel outstanding waits and only start the newest configuration", async t => {
    const { activitySource: source, native, harness } = await loadHarness(t);
    source.start();
    await settle();
    const late = [...native.pending][0];
    harness.changeSettings({ bridgePort: 32146 });
    harness.changeSettings({ bridgePort: 32147, bridgeToken: "replacement-paired-secret-0123456789012345" });
    await settle();
    assert.equal(native.calls.start.length, 2);
    assert.equal(native.calls.start.at(-1).port, 32147);
    assert.equal(native.calls.start.at(-1).token, harness.settings.store.bridgeToken);
    assert.equal(native.pending.size, 1);
    late({ revision: 999, activity: { file: "stale-private-file.ts" } });
    await settle();
    assert.equal(source.getSnapshot().activity, null);
    assert.notEqual(source.getSnapshot().revision, 999);
});

test("a delayed native start cannot republish activity after the plugin stops", async t => {
    let finishStart;
    const native = fakeNative({ start: () => new Promise(resolve => { finishStart = resolve; }) });
    const { activitySource: source } = await loadHarness(t, { native });
    source.start();
    await settle();
    assert.equal(typeof finishStart, "function");
    source.stop();
    finishStart({ revision: 123, activity: { file: "stale.ts" } });
    await settle();
    assert.equal(source.isRunning(), false);
    assert.equal(source.getSnapshot().activity, null);
    assert.equal(native.calls.wait.length, 0);
    assert.ok(native.calls.stop >= 2);
});

test("turning off the panel stops the bridge and turning it back on reconnects once", async t => {
    const { activitySource: source, native, harness } = await loadHarness(t);
    source.start();
    await settle();
    harness.changeSettings({ showPanel: false });
    await settle();
    assert.equal(native.pending.size, 0);
    assert.equal(native.calls.start.length, 1);
    harness.changeSettings({ showPanel: true });
    await settle();
    assert.equal(native.calls.start.length, 2);
    assert.equal(native.pending.size, 1);
});

test("empty pairing settings show the pairing instruction without starting a bridge", async t => {
    const { activitySource: source, native } = await loadHarness(t, { config: { bridgeToken: "" } });
    source.start();
    await settle();
    assert.equal(native.calls.start.length, 0);
    assert.equal(native.calls.wait.length, 0);
    assert.match(source.getSnapshot().error, /Pair using Maru Activity/);
});

test("native startup errors retry after five seconds and disabling cancels the retry", async t => {
    const native = fakeNative({ start: async () => ({ revision: 1, activity: null, error: "port unavailable" }) });
    const { activitySource: source } = await loadHarness(t, { native });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    source.start();
    await settle();
    assert.equal(native.calls.start.length, 1);
    assert.equal(native.calls.wait.length, 0);
    t.mock.timers.tick(4999);
    await settle();
    assert.equal(native.calls.start.length, 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(native.calls.start.length, 2);
    source.stop();
    await settle();
    t.mock.timers.tick(20_000);
    await settle();
    assert.equal(native.calls.start.length, 2);
});

test("an immediately resolved native error cannot create a busy polling loop", async t => {
    const native = fakeNative({ wait: async () => ({ revision: 2, activity: null, error: "bridge not running" }) });
    const { activitySource: source } = await loadHarness(t, { native });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    source.start();
    await settle();
    assert.equal(native.calls.wait.length, 1);
    assert.match(source.getSnapshot().error, /not running/);
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(native.calls.wait.length, 1);
    t.mock.timers.tick(4000);
    await settle();
    assert.equal(native.calls.start.length, 2);
    assert.equal(native.calls.wait.length, 2);
});

test("rejected native operations show a connection error and can recover", async t => {
    let reject = true;
    const native = fakeNative({ start: async () => {
        if (reject) throw new Error("IPC disconnected");
        return { revision: 3, activity: null };
    } });
    const { activitySource: source } = await loadHarness(t, { native });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    source.start();
    await settle();
    assert.match(source.getSnapshot().error, /Local editor connection unavailable/);
    reject = false;
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(source.getSnapshot().error, undefined);
    assert.equal(native.pending.size, 1);
});

function materialize(node) {
    if (node == null || node === false || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(materialize);
    if (typeof node.type === "function") return materialize(node.type(node.props));
    return { ...node, props: { ...node.props, children: node.props.children.map(materialize) } };
}

function nodes(node) {
    if (node == null || node === false || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props.children)];
}

function visibleText(node) {
    if (node == null || node === false) return "";
    if (typeof node !== "object") return String(node);
    if (Array.isArray(node)) return node.map(visibleText).join(" ");
    return visibleText(node.props.children);
}

const editor = {
    sessionId: "render-session", sequence: 1, focused: true, status: "coding", updatedAt: Date.now(), lastActiveAt: Date.now(),
    workspace: "Maru workspace", file: "active-file.ts", language: "typescript", line: 41, column: 7,
    startedAt: Date.now() - 120_000, repository: "https://github.com/example/project"
};

test("actual compact and expanded components obey field switches and persist expansion", async t => {
    const { ActivityPanel, harness } = await loadHarness(t, { panel: true, config: { showDuration: false } });
    harness.snapshot = { revision: 1, activity: editor };
    let tree = materialize(ActivityPanel());
    assert.match(visibleText(tree), /active-file\.ts/);
    assert.match(visibleText(tree), /Maru workspace/);
    assert.doesNotMatch(visibleText(tree), /Line\s+41|View Repository/);
    nodes(tree).find(node => node.type === "button").props.onClick();
    assert.equal(harness.settings.store.expanded, true);
    tree = materialize(ActivityPanel());
    assert.match(visibleText(tree), /Line\s+41/);
    const link = nodes(tree).find(node => node.type === "a");
    assert.equal(link.props.href, editor.repository);
    assert.equal(link.props.rel, "noreferrer noopener");
    harness.changeSettings({ showFile: false, showWorkspace: false, showCursor: false, showRepository: false });
    tree = materialize(ActivityPanel());
    assert.doesNotMatch(visibleText(tree), /active-file\.ts|Maru workspace|Line\s+41|View Repository/);
    assert.equal(nodes(tree).some(node => node.type === "a"), false);
});

test("actual component hides inactive and disabled panels but surfaces connection errors", async t => {
    const { ActivityPanel, harness } = await loadHarness(t, { panel: true });
    assert.equal(ActivityPanel(), null);
    harness.changeSettings({ hideInactive: false });
    assert.match(visibleText(materialize(ActivityPanel())), /No active VS Code editor/);
    harness.changeSettings({ hideInactive: true });
    harness.snapshot = { revision: 2, activity: null, error: "Pairing required" };
    assert.match(visibleText(materialize(ActivityPanel())), /Pairing required/);
    harness.running = false;
    harness.changeSettings({ hideInactive: false });
    assert.equal(ActivityPanel(), null, "stopped plugin must disappear even when inactive cards are configured");
    harness.running = true;
    harness.snapshot = { revision: 3, activity: editor };
    harness.changeSettings({ showPanel: false });
    assert.equal(ActivityPanel(), null);
});

test("missing editor fields render gracefully without fabricated labels or repository links", async t => {
    const { ActivityPanel, harness } = await loadHarness(t, { panel: true, config: { expanded: true } });
    harness.snapshot = { revision: 1, activity: { status: "idle", focused: false } };
    const tree = materialize(ActivityPanel());
    const rendered = nodes(tree);
    assert.match(visibleText(tree), /Idle/);
    assert.doesNotMatch(visibleText(tree), /undefined|Line|session|View Repository/);
    assert.equal(rendered.some(node => node.type === "a"), false);
    assert.equal(rendered.some(node => node.props.className === "maru-activity-panel-file"), false);
    assert.equal(rendered.some(node => node.props.className === "maru-activity-panel-workspace"), false);
});

test("the actual duration child owns its timer and cleanup removes it without reading activity again", async t => {
    const { ActivityPanel, harness } = await loadHarness(t, { panel: true });
    const timers = new Map();
    let timerId = 0;
    t.mock.timers.enable({ apis: ["Date"], now: editor.startedAt + 125_000 });
    t.mock.method(globalThis, "setTimeout", (callback, delay) => {
        timers.set(++timerId, { callback, delay });
        return timerId;
    });
    t.mock.method(globalThis, "clearTimeout", id => timers.delete(id));
    harness.snapshot = { revision: 1, activity: editor };
    const tree = materialize(ActivityPanel());
    assert.match(visibleText(tree), /2m\s+session/);
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].delay, 55_000, "updates align with the next elapsed minute");
    const reads = harness.snapshotReads;
    const [id, timer] = [...timers.entries()][0];
    timers.delete(id);
    t.mock.timers.tick(55_000);
    timer.callback();
    assert.equal(harness.snapshotReads, reads, "duration ticks must not reread and rerender the parent source");
    assert.ok(harness.stateUpdates.length >= 2);
    assert.equal(harness.stateUpdates.at(-1), "3m");
    for (const cleanup of harness.cleanups.splice(0)) cleanup();
    assert.equal(timers.size, 0);
});
