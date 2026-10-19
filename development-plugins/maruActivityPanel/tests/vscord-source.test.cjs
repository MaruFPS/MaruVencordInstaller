/* SPDX-License-Identifier: GPL-3.0-or-later */

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

const vencordRoot = process.env.VENCORD_ROOT ?? "C:/Users/User/Documents/Vencord";
const sourceRoot = process.env.MARU_PLUGIN_ROOT ?? path.join(vencordRoot, "src/userplugins/maruActivityPanel");
const requireFromVencord = createRequire(path.join(vencordRoot, "package.json"));
const ts = requireFromVencord("typescript");
const settle = () => new Promise(resolve => setImmediate(resolve));
const applicationId = "123456789012345678";
const pid = 1234;

function editor(changes = {}) {
    return {
        sessionId: "source_fixture", sequence: 1, status: "coding", updatedAt: Date.now(),
        lastActiveAt: Date.now(), focused: true, file: "example.ts", workspace: "Example",
        vscord: {
            applicationId, pid, allowText: true, allowImages: true,
            allowTimestamp: true, allowButtons: true
        },
        ...changes
    };
}

function rpc(details = "Custom project label") {
    return { application_id: applicationId, name: "Visual Studio Code", details, state: "Working on example.ts" };
}

function fakeStore() {
    const listeners = new Set();
    return {
        listeners, sessions: { socket: [pid, rpc(), 0] }, adds: 0, removes: 0, reads: 0,
        getApplicationActivities() { this.reads++; return this.sessions; },
        addChangeListener(listener) { this.adds++; listeners.add(listener); },
        removeChangeListener(listener) { this.removes++; listeners.delete(listener); },
        emit(sessions) {
            if (sessions !== undefined) this.sessions = sessions;
            for (const listener of [...listeners]) listener();
        }
    };
}

function fakeNative() {
    const pending = new Set();
    const calls = { start: [], stop: 0, wait: [] };
    let revision = 0;
    return {
        pending, calls,
        async start(token, port) {
            calls.start.push({ token, port });
            return { revision: ++revision, activity: null };
        },
        async stop() {
            calls.stop++;
            const stale = [...pending];
            pending.clear();
            for (const finish of stale) finish({ revision: ++revision, activity: null });
        },
        waitForActivity(after) {
            calls.wait.push(after);
            return new Promise(resolve => pending.add(resolve));
        },
        emit(activity) {
            const next = { revision: ++revision, activity };
            const awaiting = [...pending];
            pending.clear();
            for (const finish of awaiting) finish(next);
            return next;
        }
    };
}

function loadHarness(t, { available = true } = {}) {
    const store = fakeStore();
    const native = fakeNative();
    let settingsChanged = () => {};
    const harness = {
        store, native, availableStore: available ? store : null, lookups: [],
        settings: { store: {
            showPanel: true, bridgePort: 32145, bridgeToken: "fixture-pairing-token-01234567890123456789"
        } },
        changeSettings(update) {
            Object.assign(this.settings.store, update);
            settingsChanged();
        }
    };
    const mocks = {
        "@webpack": {
            findStore(name) {
                assert.equal(name, "LocalActivityStore", "only the raw local RPC store may be accessed");
                harness.lookups.push(name);
                return harness.availableStore;
            }
        },
        "./settings": {
            settings: harness.settings,
            onSourceSettingsChanged(listener) { settingsChanged = listener; }
        }
    };
    const modules = new Map();
    function loadFile(filename) {
        if (modules.has(filename)) return modules.get(filename).exports;
        const module = { exports: {} };
        modules.set(filename, module);
        const source = readFileSync(filename, "utf8");
        const compiled = ts.transpileModule(source, {
            fileName: filename,
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
        }).outputText;
        const hostRequire = name => {
            if (Object.hasOwn(mocks, name)) return mocks[name];
            assert.ok(["./shared", "./vscord"].includes(name), `unexpected host dependency: ${name}`);
            return loadFile(path.join(sourceRoot, `${name.slice(2)}.ts`));
        };
        // Execute TypeScript-transpiled modules entirely in memory. This creates
        // neither Vencord bundles nor generated files and never touches Discord.
        const run = new Function("exports", "require", "module", "VencordNative", compiled);
        run(module.exports, hostRequire, module, { pluginHelpers: { MaruActivityPanel: native } });
        return module.exports;
    }
    const { activitySource } = loadFile(path.join(sourceRoot, "source.ts"));
    t.after(async () => {
        activitySource.stop();
        await settle();
        assert.equal(store.listeners.size, 0, "source teardown must remove the raw RPC listener");
        assert.equal(native.pending.size, 0, "source teardown must cancel native waits");
    });
    return Object.assign(harness, { activitySource });
}

async function startWithEditor(t, options) {
    const harness = loadHarness(t, options);
    harness.activitySource.start();
    await settle();
    harness.native.emit(editor());
    await settle();
    return harness;
}

test("the first identified companion frame attaches one local listener and subsequent frames reuse it", async t => {
    const harness = loadHarness(t);
    harness.activitySource.start();
    await settle();
    assert.equal(harness.lookups.length, 0);
    harness.native.emit(editor());
    await settle();
    assert.equal(harness.store.listeners.size, 1);
    assert.equal(harness.store.adds, 1);
    assert.equal(harness.activitySource.getSnapshot().presence.details, "Custom project label");
    harness.native.emit(editor({ sequence: 2 }));
    await settle();
    assert.equal(harness.store.adds, 1);
    assert.equal(harness.lookups.length, 1);
});

test("local RPC changes update mirrored text immediately without a new companion revision", async t => {
    const { activitySource, store, native } = await startWithEditor(t);
    const previous = activitySource.getSnapshot();
    const waitCalls = native.calls.wait.length;
    let notifications = 0;
    const unsubscribe = activitySource.subscribe(() => notifications++);
    store.emit({ socket: [pid, rpc("Updated VSCord global label"), 0] });
    assert.equal(activitySource.getSnapshot().presence.details, "Updated VSCord global label");
    assert.equal(activitySource.getSnapshot().revision, previous.revision);
    assert.equal(activitySource.getSnapshot().activity, previous.activity);
    assert.equal(native.calls.wait.length, waitCalls);
    assert.equal(notifications, 1);
    store.emit();
    assert.equal(notifications, 1, "equivalent raw RPC emissions must not rerender the panel");
    unsubscribe();
});

test("unassociated PID retains editor fallback and disconnect clears only mirroring immediately", async t => {
    const { activitySource, store } = await startWithEditor(t);
    const current = activitySource.getSnapshot().activity;
    store.emit({ otherWindow: [pid + 1, rpc("Another workspace"), 0] });
    assert.equal(activitySource.getSnapshot().presence, null);
    assert.equal(activitySource.getSnapshot().activity, current);
    store.emit({ socket: [pid, rpc(), 0] });
    assert.equal(activitySource.getSnapshot().presence.details, "Custom project label");
    store.emit({});
    assert.equal(activitySource.getSnapshot().presence, null);
    assert.equal(activitySource.getSnapshot().activity, current);
    assert.equal(store.listeners.size, 1, "stay subscribed for VSCord to reconnect while the editor lives");
});

test("missing VSCord identity and unavailable editor frames dispose of the local listener", async t => {
    const { activitySource, store, native } = await startWithEditor(t);
    native.emit(editor({ vscord: undefined, sequence: 2 }));
    await settle();
    assert.equal(store.listeners.size, 0);
    assert.equal(activitySource.getSnapshot().presence, null);
    native.emit(editor({ sequence: 3 }));
    await settle();
    assert.equal(store.listeners.size, 1);
    native.emit(editor({ status: "unavailable", sequence: 4 }));
    await settle();
    assert.equal(activitySource.getSnapshot().presence, null);
    assert.equal(store.listeners.size, 0);
});

test("stopping disposes listeners and late callbacks cannot reattach or notify", async t => {
    const { activitySource, store, native } = await startWithEditor(t);
    const late = [...store.listeners][0];
    activitySource.stop();
    await settle();
    assert.equal(activitySource.isRunning(), false);
    assert.equal(store.listeners.size, 0);
    assert.equal(native.pending.size, 0);
    let notifications = 0;
    const unsubscribe = activitySource.subscribe(() => notifications++);
    late();
    assert.equal(store.listeners.size, 0);
    assert.equal(activitySource.getSnapshot().presence, null);
    assert.equal(notifications, 0);
    unsubscribe();
});

test("rapid settings changes remove old listeners and reconnect only the newest configuration", async t => {
    const harness = await startWithEditor(t);
    const { activitySource, store, native } = harness;
    const staleNativeFrame = [...native.pending][0];
    harness.changeSettings({ bridgePort: 32146 });
    harness.changeSettings({ bridgePort: 32147 });
    assert.equal(store.listeners.size, 0);
    await settle();
    assert.equal(native.calls.start.length, 2);
    assert.equal(native.calls.start.at(-1).port, 32147);
    staleNativeFrame({ revision: 999, activity: editor() });
    await settle();
    assert.equal(activitySource.getSnapshot().activity, null);
    assert.equal(store.listeners.size, 0);
    native.emit(editor({ sequence: 2 }));
    await settle();
    assert.equal(store.listeners.size, 1);
    assert.equal(store.adds, 2);
    assert.equal(native.pending.size, 1);
    assert.equal(activitySource.getSnapshot().presence.details, "Custom project label");
});

test("a missing local store retries only on a later companion frame", async t => {
    const timeout = t.mock.method(globalThis, "setTimeout", () => 0);
    const harness = await startWithEditor(t, { available: false });
    assert.equal(harness.lookups.length, 1);
    assert.equal(harness.activitySource.getSnapshot().presence, null);
    assert.equal(harness.store.listeners.size, 0);
    await settle();
    await settle();
    assert.equal(harness.lookups.length, 1, "a missing optional store must not cause background polling");
    assert.equal(timeout.mock.calls.length, 0, "a missing optional store must not schedule retry timers");
    harness.availableStore = harness.store;
    harness.native.emit(editor({ sequence: 2 }));
    await settle();
    assert.equal(harness.lookups.length, 2);
    assert.equal(harness.store.listeners.size, 1);
    assert.equal(harness.activitySource.getSnapshot().presence.details, "Custom project label");
});

test("an incompatible or failing local store cannot interrupt the independent authenticated bridge", async t => {
    const harness = loadHarness(t);
    harness.availableStore = { getApplicationActivities() { return {}; } };
    harness.activitySource.start();
    await settle();
    harness.native.emit(editor());
    await settle();
    assert.equal(harness.activitySource.getSnapshot().activity.file, "example.ts");
    assert.equal(harness.activitySource.getSnapshot().presence, null);
    harness.availableStore = harness.store;
    harness.store.getApplicationActivities = () => { throw new Error("RPC store unavailable"); };
    harness.native.emit(editor({ sequence: 2 }));
    await settle();
    assert.equal(harness.store.listeners.size, 0);
    assert.equal(harness.activitySource.getSnapshot().activity.file, "example.ts");
    assert.equal(harness.activitySource.getSnapshot().presence, null);
    assert.equal(harness.native.pending.size, 1);
});
