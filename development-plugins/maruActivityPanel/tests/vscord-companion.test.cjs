/* SPDX-License-Identifier: GPL-3.0-or-later */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "../companion"), process.env.VENCORD_ROOT ?? "C:/Users/User/Documents/Vencord", process.cwd()] }));

// Compile in memory so these focused source checks never rebuild the extension or VSIX.
function loadSource(name, mocks) {
    const filename = path.resolve(__dirname, `../companion/src/${name}.ts`);
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod.require = request => {
        if (Object.hasOwn(mocks, request)) return mocks[request];
        if (request.startsWith("./")) return loadSource(request.slice(2), mocks);
        return require(request);
    };
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    const timers = name === "extension" ? 'const { setTimeout, setInterval, clearTimeout, clearInterval } = require("maru:test");\n' : "";
    mod._compile(timers + compiled, filename);
    return mod.exports;
}

const privacy = { shareWorkspace: true, shareFile: true, shareCursor: true, shareDuration: true, shareRepository: true };

function identitySource(active = true, values = {}) {
    const scopes = [];
    const vscode = {
        extensions: { getExtension(id) { assert.equal(id, "LeonardSSH.vscord"); return active === undefined ? undefined : { isActive: active }; } },
        workspace: { getConfiguration(...args) { scopes.push(args); return { get: (key, fallback) => values[key] ?? fallback }; } }
    };
    return { ...loadSource("vscord", { vscode }), scopes };
}

test("identity selects VSCord's effective application, custom IDs and this extension host without activation", () => {
    const source = identitySource(true, { "app.name": "Code" });
    const result = source.readVSCordIdentity(privacy);
    assert.equal(result.applicationId, "782685898163617802");
    assert.equal(result.pid, process.pid);
    assert.deepEqual(source.scopes, [["vscord"]]);
    assert.equal(identitySource().readVSCordIdentity(privacy).applicationId, "810516608442695700");
    assert.equal(identitySource(true, { "app.name": "Custom", "app.id": "123456789012345678" }).readVSCordIdentity(privacy).applicationId, "123456789012345678");
    assert.equal(identitySource(false).readVSCordIdentity(privacy), undefined);
    assert.equal(identitySource(true, { "app.name": "Custom", "app.id": "invalid" }).readVSCordIdentity(privacy), undefined);
});

test("every sharing restriction prevents arbitrary formatted text and preserves individual metadata gates", () => {
    const source = identitySource();
    for (const key of Object.keys(privacy)) {
        const result = source.readVSCordIdentity({ ...privacy, [key]: false });
        assert.equal(result.allowText, false, key);
        assert.equal(result.allowImages, key !== "shareFile", key);
        assert.equal(result.allowTimestamp, key !== "shareDuration", key);
        assert.equal(result.allowButtons, key !== "shareRepository", key);
        assert.deepEqual(Object.keys(result).sort(), ["allowButtons", "allowImages", "allowText", "allowTimestamp", "applicationId", "pid"]);
    }
    assert.equal(source.readVSCordIdentity(privacy).allowText, true);
});

function companionSource() {
    const events = new Map();
    const timers = new Set();
    const activities = [];
    const values = { "app.name": "Visual Studio Code" };
    let active = true;
    const event = name => {
        const listeners = new Set();
        events.set(name, listeners);
        return callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; };
    };
    const uri = { path: "/private/project/index.ts", toString: () => "file:///private/project/index.ts" };
    const folder = { name: "project", uri };
    const document = { uri, languageId: "typescript" };
    const fakeTimer = (callback, milliseconds) => {
        const timer = { callback, milliseconds, unref() {} };
        timers.add(timer);
        return timer;
    };
    const vscode = {
        UIKind: { Desktop: 1 }, env: { uiKind: 1 },
        extensions: { getExtension: () => active ? { isActive: true } : undefined, onDidChange: event("extensions") },
        commands: { registerCommand: () => ({ dispose() {} }) },
        window: {
            state: { focused: true }, activeTextEditor: { document, selection: { active: { line: 0, character: 0 } } },
            onDidChangeActiveTextEditor: event("editor"), onDidChangeTextEditorSelection: event("selection"), onDidChangeWindowState: event("window")
        },
        workspace: {
            workspaceFolders: [folder], name: "project", getWorkspaceFolder: () => folder,
            getConfiguration: scope => ({ get: (key, fallback) => scope === "vscord" ? values[key] ?? fallback : fallback }),
            onDidChangeTextDocument: event("document"), onDidChangeWorkspaceFolders: event("workspace"), onDidChangeConfiguration: event("configuration")
        }
    };
    const context = { subscriptions: [], secrets: { get: async () => "t".repeat(43), onDidChange: event("secret") } };
    const result = loadSource("extension", {
        vscode,
        "maru:test": { setTimeout: fakeTimer, setInterval: fakeTimer, clearTimeout: timer => timers.delete(timer), clearInterval: timer => timers.delete(timer) },
        "./git": { RepositorySource: class { async initialize() {} getRemote() {} dispose() {} } },
        "./transport": { HEARTBEAT_MS: 15000, LoopbackTransport: class { publish(activity) { activities.push(activity); } async dispose() {} } }
    });
    return {
        ...result, context, activities, values, vscode,
        setActive(value) { active = value; },
        emit(name, value) { for (const callback of events.get(name)) callback(value); },
        debounce() { const timer = [...timers].find(timer => timer.milliseconds === 200); assert.ok(timer); timers.delete(timer); timer.callback(); }
    };
}

test("configuration and extension changes refresh identity without activity resets; unavailable snapshots carry none", async () => {
    const app = companionSource();
    await app.activate(app.context);
    await new Promise(resolve => setImmediate(resolve));
    const first = app.activities.at(-1);
    assert.equal(first.vscord.applicationId, "810516608442695700");
    app.values["app.name"] = "Code";
    app.emit("configuration", { affectsConfiguration: scope => scope === "vscord" });
    app.debounce();
    const refreshed = app.activities.at(-1);
    assert.equal(refreshed.vscord.applicationId, "782685898163617802");
    assert.equal(refreshed.lastActiveAt, first.lastActiveAt);
    assert.equal(refreshed.startedAt, first.startedAt);
    app.setActive(false);
    app.emit("extensions");
    app.debounce();
    assert.equal(app.activities.at(-1).vscord, undefined);
    app.setActive(true);
    app.vscode.window.activeTextEditor = undefined;
    app.emit("editor");
    app.debounce();
    assert.equal(app.activities.at(-1).status, "unavailable");
    assert.equal(app.activities.at(-1).vscord, undefined);
    await app.deactivate();
});

function transportSource() {
    const sent = [];
    const open = new Set();
    let maximumOpen = 0;
    const result = loadSource("transport", {
        "node:http": { request(options, callback) {
            const req = new EventEmitter();
            const close = () => { if (open.delete(req)) req.emit("close"); };
            req.end = body => {
                sent.push({ options, body: JSON.parse(body), req });
                open.add(req);
                maximumOpen = Math.max(maximumOpen, open.size);
            };
            req.destroy = () => { close(); return req; };
            req.headers = statusCode => {
                const response = new EventEmitter();
                response.statusCode = statusCode;
                response.resume = () => { response.resumed = true; };
                callback(response);
                response.finish = () => { response.emit("end"); close(); };
                return response;
            };
            return req;
        } }
    });
    return { ...result, sent, maximumOpen: () => maximumOpen };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const mirrored = {
    sessionId: "test-session", sequence: 1, status: "coding", updatedAt: 1000, lastActiveAt: 1000,
    focused: true, file: "index.ts", workspace: "Project", line: 1, column: 1, startedAt: 1000,
    vscord: { applicationId: "810516608442695700", pid: process.pid, allowText: true, allowImages: true, allowTimestamp: true, allowButtons: true }
};

test("an older bridge's 400 retries the exact raw snapshot after response end and preserves the latest queue", async () => {
    const source = transportSource();
    const token = "t".repeat(43);
    const transport = new source.LoopbackTransport(32145, token);
    transport.publish(mirrored);
    transport.publish({ ...mirrored, sequence: 2 });
    transport.publish({ ...mirrored, sequence: 3 });
    const response = source.sent[0].req.headers(400);
    assert.equal(response.resumed, true);
    assert.equal(source.sent.length, 1, "No retry before the response is drained");
    response.finish();
    await flush();
    assert.equal(source.sent.length, 2);
    const { vscord, ...raw } = mirrored;
    assert.deepEqual(source.sent[1].body, raw);
    assert.equal(source.sent[1].options.headers.Authorization, `Bearer ${token}`);
    source.sent[1].req.headers(204).finish();
    await flush();
    assert.equal(source.sent.length, 3);
    assert.equal(source.sent[2].body.sequence, 3);
    assert.deepEqual(source.sent[2].body.vscord, mirrored.vscord, "Legacy mode is never persisted");
    source.sent[2].req.headers(204).finish();
    await flush();
    assert.equal(source.maximumOpen(), 1);
    await transport.dispose();
});

test("compatibility fallback is single-shot and excludes authentication failures, other errors and original snapshots", async () => {
    for (const status of [401, 403, 404, 500]) {
        const source = transportSource();
        const transport = new source.LoopbackTransport(32145, "t".repeat(43));
        transport.publish(mirrored);
        source.sent[0].req.headers(status).finish();
        await flush();
        assert.equal(source.sent.length, 1, `No compatibility retry for HTTP ${status}`);
        await transport.dispose();
    }
    const source = transportSource();
    const transport = new source.LoopbackTransport(32145, "t".repeat(43));
    transport.publish(mirrored);
    source.sent[0].req.headers(400).finish();
    await flush();
    source.sent[1].req.headers(400).finish();
    await flush();
    assert.equal(source.sent.length, 2);
    const { vscord, ...raw } = mirrored;
    transport.publish({ ...raw, sequence: 2 });
    source.sent[2].req.headers(400).finish();
    await flush();
    assert.equal(source.sent.length, 3);
    await transport.dispose();
});
