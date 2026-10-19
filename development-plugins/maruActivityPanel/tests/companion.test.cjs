/* SPDX-License-Identifier: GPL-3.0-or-later */
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const { ActivityModel, basenameLabel, normalizeRepository, validPort, validIdleSeconds } = require("../companion/out/activity.js");

const privacy = { shareWorkspace: true, shareFile: true, shareCursor: true, shareDuration: true, shareRepository: true };
const editor = { file: "naat.v3.css", language: "css", line: 1620, column: 2 };
const snapshot = { workspaceKey: "file:///private/NotAnotherAnimeTheme", workspace: "NotAnotherAnimeTheme", focused: true, editor, repository: "git@github.com:owner/repository.git" };
const flush = () => new Promise(resolve => setImmediate(resolve));

test("session timing survives file changes, resets on project changes, and excludes private identities", () => {
    const model = new ActivityModel("test-session", 1000);
    const first = model.snapshot(snapshot, privacy, 120, 1000);
    model.interact(2500);
    const second = model.snapshot({ ...snapshot, editor: { ...editor, file: "index.ts", language: "typescript" } }, privacy, 120, 2500);
    assert.equal(first.status, "coding");
    assert.equal(second.startedAt, 1000);
    assert.equal(second.lastActiveAt, 2500);
    assert.equal(second.file, "index.ts");
    assert.equal(second.repository, "https://github.com/owner/repository");
    assert.equal(JSON.stringify(second).includes("file:///private"), false);
    assert.equal(second.sequence, first.sequence + 1);
    assert.equal(model.snapshot({ ...snapshot, workspaceKey: "other" }, privacy, 120, 3000).startedAt, 3000);
});

test("no active editor clears file, language, cursor and duration instead of retaining stale editor metadata", () => {
    const model = new ActivityModel("test-session", 1000);
    model.snapshot(snapshot, privacy, 120, 1000);
    const empty = model.snapshot({ ...snapshot, editor: undefined }, privacy, 120, 2000);
    assert.equal(empty.status, "unavailable");
    for (const field of ["file", "language", "line", "column", "startedAt", "workspace", "repository"]) assert.equal(empty[field], undefined);
    assert.equal(model.snapshot(snapshot, privacy, 120, 3000).startedAt, 1000);
});

test("opening the first editor after an empty window starts the session at that moment", () => {
    const model = new ActivityModel("test-session", 1000);
    model.snapshot({ ...snapshot, editor: undefined }, privacy, 120, 1000);
    assert.equal(model.snapshot(snapshot, privacy, 120, 5000).startedAt, 5000);
});

test("idle threshold, focus changes and heartbeats do not fabricate editor interactions", () => {
    const model = new ActivityModel("test-session", 1000);
    assert.equal(model.snapshot(snapshot, privacy, 120, 120999).status, "coding");
    assert.equal(model.snapshot(snapshot, privacy, 120, 121000).status, "idle");
    assert.equal(model.snapshot({ ...snapshot, focused: false }, privacy, 120, 1001).status, "idle");
    assert.equal(model.snapshot(snapshot, privacy, 120, 121001).lastActiveAt, 1000);
    model.interact(121002);
    assert.equal(model.snapshot(snapshot, privacy, 120, 121002).status, "coding");
    const unavailable = model.unavailable(122000);
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.focused, false);
    assert.equal(unavailable.file, undefined);
});

test("each source privacy switch removes metadata before transport serialization", () => {
    const model = new ActivityModel("test-session", 1000);
    const hidden = model.snapshot(snapshot, Object.fromEntries(Object.keys(privacy).map(key => [key, false])), 120, 1000);
    for (const field of ["workspace", "file", "language", "line", "column", "startedAt", "repository"]) assert.equal(hidden[field], undefined);
    const fileHidden = model.snapshot(snapshot, { ...privacy, shareFile: false }, 120, 1001);
    assert.equal(fileHidden.file, undefined);
    assert.equal(fileHidden.language, undefined);
    assert.equal(fileHidden.line, 1620);
});

test("repository URL normalization strips credentials and rejects local or executable targets", () => {
    assert.equal(normalizeRepository("https://username:secret@github.com/owner/repo.git?token=secret#readme"), "https://github.com/owner/repo");
    assert.equal(normalizeRepository("ssh://git@gitlab.com/group/repo.git"), "https://gitlab.com/group/repo");
    for (const value of ["C:\\private\\repo", "file:///private/repo", "javascript:alert(1)", "http://github.com/a/b", "https://localhost/a/b", "https://127.0.0.1/a/b", "https://192.168.1.1/a/b", "https://git.local/a/b", "https://[::1]/a/b", "https://github.com:1234/a/b", "ssh://root@github.com/a/b", "https://github.com/a%2fb/c", "https://github.com/only-owner"]) {
        assert.equal(normalizeRepository(value), undefined, value);
    }
});

test("path labels are bounded and control-free; configuration and unknown languages are validated", () => {
    assert.equal(basenameLabel("C:\\private\\project\\file.ts"), "file.ts");
    assert.equal(basenameLabel("/private/project/"), "project");
    assert.equal(basenameLabel("file\r\n.ts"), "file.ts");
    assert.equal(basenameLabel("x".repeat(1000)).length, 128);
    assert.equal(validPort(0), 32145);
    assert.equal(validPort(65536), 32145);
    assert.equal(validPort("32145"), 32145);
    assert.equal(validPort(45000), 45000);
    assert.equal(validIdleSeconds(2), 120);
    assert.equal(validIdleSeconds(3601), 120);
    assert.equal(validIdleSeconds(15), 15);
    const model = new ActivityModel("test-session", 1000);
    assert.equal(model.snapshot({ ...snapshot, editor: { ...editor, language: "unsafe language" } }, privacy, 120, 1000).language, undefined);
});

function loadTransport() {
    const sent = [];
    const requests = [];
    const filename = path.resolve(__dirname, "../companion/out/transport.js");
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod.require = function (name) {
        if (name !== "node:http") return require(name);
        return { request(options, callback) {
            const req = new EventEmitter();
            req.destroyed = false;
            req.end = body => { sent.push({ options, body: JSON.parse(body) }); };
            req.destroy = () => { if (!req.destroyed) { req.destroyed = true; req.emit("close"); } return req; };
            req.respond = () => {
                const response = new EventEmitter();
                response.resume = () => {};
                callback(response);
                response.emit("end");
                req.emit("close");
            };
            requests.push(req);
            return req;
        } };
    };
    mod._compile(fs.readFileSync(filename, "utf8"), filename);
    return { ...mod.exports, sent, requests };
}

test("transport sends authenticated loopback metadata and keeps only the latest queued update", async () => {
    const { LoopbackTransport, sent, requests } = loadTransport();
    const token = "t".repeat(43);
    const transport = new LoopbackTransport(32145, token);
    const model = new ActivityModel("test-session", 1000);
    transport.publish(model.snapshot(snapshot, privacy, 120, 1000));
    transport.publish(model.snapshot(snapshot, privacy, 120, 2000));
    transport.publish(model.snapshot(snapshot, privacy, 120, 3000));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].options.hostname, "127.0.0.1");
    assert.equal(sent[0].options.path, "/activity");
    assert.equal(sent[0].options.headers.Authorization, `Bearer ${token}`);
    assert.equal(sent[0].options.headers.Origin, undefined);
    assert.equal(sent[0].options.agent, false);
    requests[0].respond();
    await flush();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body.sequence, 3);
    requests[1].respond();
    await flush();
    await transport.dispose();
});

test("transport recovers after connection failure, shuts down in-flight sends, and withdraws its session", async () => {
    const { LoopbackTransport, sent, requests } = loadTransport();
    const transport = new LoopbackTransport(32145, "t".repeat(43));
    const model = new ActivityModel("test-session", 1000);
    transport.publish(model.snapshot(snapshot, privacy, 120, 1000));
    requests[0].emit("error", new Error("ECONNREFUSED"));
    requests[0].emit("close");
    await flush();
    transport.publish(model.snapshot(snapshot, privacy, 120, 15000));
    assert.equal(sent.length, 2);
    const closed = transport.dispose(model.unavailable(16000));
    await flush();
    assert.equal(requests[1].destroyed, true);
    assert.equal(sent.at(-1).body.status, "unavailable");
    requests.at(-1).respond();
    await closed;
    transport.publish(model.snapshot(snapshot, privacy, 120, 17000));
    assert.equal(sent.length, 3);
});

test("transport rejects invalid credentials/ports and bounds the metadata payload", async () => {
    const { LoopbackTransport, sent } = loadTransport();
    assert.throws(() => new LoopbackTransport(80, "t".repeat(43)), /port/);
    assert.throws(() => new LoopbackTransport(32145, "short"), /token/);
    const transport = new LoopbackTransport(32145, "t".repeat(43));
    transport.publish({ sessionId: "test-session", workspace: "x".repeat(9000) });
    await flush();
    assert.equal(sent.length, 0);
    await transport.dispose();
});

function loadExtension() {
    const events = new Map();
    const timers = new Set();
    const transports = [];
    const commands = new Map();
    const secrets = new Map();
    const settings = {};
    const event = name => {
        const listeners = new Set();
        events.set(name, listeners);
        return callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; };
    };
    const uri = value => ({ path: value.replace(/^file:\/\//, ""), toString: () => value });
    const folder = { name: "Project", uri: uri("file:///private/Project") };
    const document = { uri: uri("file:///private/Project/index.ts"), languageId: "typescript" };
    const editor = { document, selection: { active: { line: 4, character: 2 } } };
    let clipboard;
    let now = 1000;
    const fakeTimer = (callback, milliseconds, repeat) => {
        const timer = { callback, milliseconds, repeat, unref() {} };
        timers.add(timer);
        return timer;
    };
    const vscode = {
        UIKind: { Desktop: 1 },
        env: { uiKind: 1, clipboard: { async writeText(value) { clipboard = value; } } },
        window: {
            state: { focused: true }, activeTextEditor: editor,
            onDidChangeActiveTextEditor: event("activeEditor"), onDidChangeTextEditorSelection: event("selection"),
            onDidChangeWindowState: event("focus"), showInformationMessage: async () => undefined, showWarningMessage: async () => undefined
        },
        workspace: {
            workspaceFolders: [folder], name: "Project", getWorkspaceFolder: () => folder,
            getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
            onDidChangeTextDocument: event("document"), onDidChangeWorkspaceFolders: event("workspace"),
            onDidChangeConfiguration: event("configuration")
        },
        extensions: { onDidChange: event("extensions"), getExtension: () => undefined },
        commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose: () => commands.delete(name) }; } }
    };
    const context = {
        subscriptions: [], secrets: {
            get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); },
            onDidChange: event("secret")
        }
    };
    let repositoryDisposed = false;
    const injected = {
        now: () => now,
        setTimeout: (callback, ms) => fakeTimer(callback, ms, false),
        setInterval: (callback, ms) => fakeTimer(callback, ms, true),
        clearTimer: timer => timers.delete(timer)
    };
    const filename = path.resolve(__dirname, "../companion/out/extension.js");
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod.require = name => {
        if (name === "vscode") return vscode;
        if (name === "maru:test") return injected;
        if (name === "./activity") return require("../companion/out/activity.js");
        if (name === "./git") return { RepositorySource: class {
            async initialize() {}
            getRemote() { return "git@github.com:owner/Project.git"; }
            dispose() { repositoryDisposed = true; }
        } };
        if (name === "./transport") return { HEARTBEAT_MS: 15000, LoopbackTransport: class {
            constructor(port, token) { this.port = port; this.token = token; this.activities = []; transports.push(this); }
            publish(activity) { this.activities.push(activity); }
            async dispose(activity) { this.final = activity; this.disposed = true; }
        } };
        return require(name);
    };
    mod._compile('const injected = require("maru:test"); const Date = { now: injected.now }; const setTimeout = injected.setTimeout; const setInterval = injected.setInterval; const clearTimeout = injected.clearTimer; const clearInterval = injected.clearTimer;\n' + fs.readFileSync(filename, "utf8"), filename);
    return {
        ...mod.exports, context, timers, transports, commands, settings, vscode,
        setNow: value => { now = value; }, clipboard: () => clipboard,
        emit(name, value) { for (const listener of events.get(name)) listener(value); },
        runTimer(milliseconds) {
            const timer = [...timers].find(timer => timer.milliseconds === milliseconds);
            assert.ok(timer, `Expected a ${milliseconds}ms timer`);
            if (!timer.repeat) timers.delete(timer);
            timer.callback();
        },
        listeners: () => [...events.values()].reduce((sum, listeners) => sum + listeners.size, 0),
        repositoryDisposed: () => repositoryDisposed
    };
}

test("extension pairs through SecretStorage, streams real editor events, honors privacy and disposes every resource", async () => {
    const app = loadExtension();
    await app.activate(app.context);
    assert.equal(app.transports.length, 0, "Unpaired activation sends no metadata");
    assert.equal(app.timers.size, 0);
    await app.commands.get("maruActivity.pair")();
    await flush();
    assert.match(app.clipboard(), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(app.transports.length, 1);
    const transport = app.transports[0];
    assert.equal(transport.token, app.clipboard());
    assert.equal(transport.activities[0].file, "index.ts");
    assert.equal(transport.activities[0].line, 5);
    assert.equal(transport.activities[0].column, 3);
    app.setNow(2000);
    app.vscode.window.activeTextEditor.document = { uri: { path: "/private/Project/style.css", toString: () => "file:///private/Project/style.css" }, languageId: "css" };
    app.emit("activeEditor", app.vscode.window.activeTextEditor);
    app.runTimer(200);
    assert.equal(transport.activities.at(-1).file, "style.css");
    assert.equal(transport.activities.at(-1).startedAt, 1000);
    app.vscode.window.state.focused = false;
    app.emit("focus", { focused: false });
    assert.equal(transport.activities.at(-1).status, "idle");
    for (const key of Object.keys(privacy)) app.settings[key] = false;
    app.emit("configuration", { affectsConfiguration: () => true });
    const hidden = transport.activities.at(-1);
    for (const field of ["workspace", "file", "language", "line", "column", "startedAt", "repository"]) assert.equal(hidden[field], undefined);
    const sequence = hidden.sequence;
    app.runTimer(15000);
    assert.equal(transport.activities.at(-1).sequence, sequence + 1);
    assert.equal(transport.activities.at(-1).lastActiveAt, 2000);
    await app.deactivate();
    assert.equal(transport.final.status, "unavailable");
    assert.equal(app.listeners(), 0);
    assert.equal(app.commands.size, 0);
    assert.equal(app.timers.size, 0);
    assert.equal(app.repositoryDisposed(), true);
});

test("disabling the companion withdraws its session; re-enabling restarts one heartbeat without duplication", async () => {
    const app = loadExtension();
    await app.activate(app.context);
    await app.commands.get("maruActivity.pair")();
    await flush();
    app.settings.enabled = false;
    app.emit("configuration", { affectsConfiguration: () => true });
    await flush();
    assert.equal(app.transports[0].final.status, "unavailable");
    assert.equal(app.timers.size, 0);
    app.settings.enabled = true;
    app.emit("configuration", { affectsConfiguration: () => true });
    await flush();
    assert.equal(app.transports.length, 2);
    assert.equal([...app.timers].filter(timer => timer.repeat).length, 1);
    await app.deactivate();
    assert.equal(app.timers.size, 0);
});

test("secure storage or clipboard failures leave the extension available without an unhandled rejection", async () => {
    const app = loadExtension();
    app.context.secrets.get = async () => { throw new Error("keychain unavailable"); };
    await app.activate(app.context);
    assert.equal(app.transports.length, 0);
    await app.commands.get("maruActivity.pair")();
    assert.equal(app.transports.length, 0);
    await app.deactivate();
    assert.equal(app.listeners(), 0);
});

test("closing the last editor withdraws its session immediately after the event debounce", async () => {
    const app = loadExtension();
    await app.activate(app.context);
    await app.commands.get("maruActivity.pair")();
    await flush();
    app.vscode.window.activeTextEditor = undefined;
    app.emit("activeEditor", undefined);
    app.runTimer(200);
    const activity = app.transports[0].activities.at(-1);
    assert.equal(activity.status, "unavailable");
    assert.equal(activity.file, undefined);
    assert.equal(activity.workspace, undefined);
    assert.equal(activity.repository, undefined);
    await app.deactivate();
});
