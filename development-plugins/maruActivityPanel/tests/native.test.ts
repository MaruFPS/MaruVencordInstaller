/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, request } from "node:http";
import { performance } from "node:perf_hooks";
import test, { afterEach } from "node:test";

import { start, stop, waitForActivity } from "../src/userplugins/maruActivityPanel/native";
import { Activity, parseActivity, STALE_AFTER_MS } from "../src/userplugins/maruActivityPanel/shared";

const token = "a-paired-test-secret-012345678901234567890";
class Sender extends EventEmitter {
    destroyed = false;
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("destroyed"); }
}
const sender = new Sender();
const event = { sender } as unknown as Parameters<typeof start>[0];

async function freePort() {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number; };
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
}

function activity(overrides: Partial<Activity> = {}): Activity {
    const now = Date.now();
    return {
        sessionId: "test-session-1", sequence: 1, status: "coding", updatedAt: now,
        lastActiveAt: now, focused: true, startedAt: now - 120_000,
        workspace: "MaruActivityPanel", file: "index.tsx", language: "typescriptreact", line: 42, column: 3,
        repository: "https://github.com/example/project", ...overrides
    };
}

function post(port: number, data: unknown, headers: Record<string, string> = {}, method = "POST", path = "/activity") {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    return new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, method, agent: false, headers: {
            "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), ...headers
        } }, res => {
            res.resume();
            res.once("end", () => resolve(res.statusCode!));
        });
        req.once("error", reject);
        req.end(body);
    });
}

afterEach(async () => {
    await stop(event);
    sender.destroyed = false;
    assert.equal(sender.listenerCount("destroyed"), 0, "native helper must detach the owner listener");
});

test("exact metadata schema rejects editor contents, paths, invalid dates and unsafe links", () => {
    assert.equal(parseActivity({ ...activity(), contents: "secret source" }), null);
    assert.equal(parseActivity(activity({ file: "C:\\private\\index.tsx" })), null);
    assert.equal(parseActivity(activity({ repository: "javascript:alert(1)" })), null);
    assert.equal(parseActivity(activity({ repository: "https://secret@github.com/example/project" })), null);
    assert.equal(parseActivity(activity({ updatedAt: Date.now() - 120_000 })), null);
    assert.equal(parseActivity(activity({ updatedAt: Date.now() + 60_000 })), null);
    assert.equal(parseActivity(activity({ lastActiveAt: Date.now() + 60_000 })), null);
    assert.equal(parseActivity(activity({ line: 0 })), null);
    const clean = parseActivity(activity({ repository: "https://github.com/example/project?token=secret#fragment" }))!;
    assert.equal(clean.repository, "https://github.com/example/project");
    const noEditor = parseActivity(activity({ file: undefined, line: undefined, column: undefined, language: undefined }))!;
    assert.equal(noEditor.line, undefined);
    assert.equal(noEditor.column, undefined);
    assert.equal(noEditor.language, undefined);
});

test("invalid configuration never opens a listener", async () => {
    const port = await freePort();
    assert.match((await start(event, "short", port)).error!, /pairing token/);
    assert.match((await start(event, token, 80)).error!, /port/);
    assert.equal((await start(event, token, port)).error, undefined);
});

test("waiting without a bridge reports an error instead of allowing a renderer retry loop", async () => {
    const idle = await waitForActivity(event, -1);
    assert.equal(idle.activity, null);
    assert.match(idle.error!, /not running/);
    const port = await freePort();
    const running = await start(event, token, port);
    const pending = waitForActivity(event, running.revision);
    await stop(event);
    assert.equal((await pending).activity, null);
    const stopped = await waitForActivity(event, running.revision);
    assert.match(stopped.error!, /not running/);
});

test("real loopback server requires authentication and rejects browser origins and oversized requests", async () => {
    const port = await freePort();
    await start(event, token, port);
    assert.equal(await post(port, activity(), { Authorization: "Bearer wrong" }), 401);
    assert.equal(await post(port, activity(), { Origin: "https://example.com" }), 403);
    assert.equal(await post(port, activity(), { Host: `evil.example:${port}` }), 403);
    assert.equal(await post(port, activity(), { "Content-Type": "text/plain" }), 415);
    assert.equal(await post(port, activity(), {}, "GET"), 405);
    assert.equal(await post(port, activity(), {}, "POST", "/other"), 404);
    assert.equal(await post(port, "x".repeat(8193)), 413);
    assert.equal(await post(port, "{broken"), 400);
    assert.equal(await post(port, { ...activity(), sourceCode: "not allowed" }), 400);
    assert.equal(await post(port, activity()), 204);
});

test("activity updates resolve IPC waits and editor changes remove unavailable fields", async () => {
    const port = await freePort();
    const initial = await start(event, token, port);
    const waiting = waitForActivity(event, initial.revision);
    assert.equal(await post(port, activity()), 204);
    const first = await waiting;
    assert.equal(first.activity?.file, "index.tsx");
    assert.equal(first.activity?.workspace, "MaruActivityPanel");
    assert.equal(first.activity?.line, 42);
    const nextWait = waitForActivity(event, first.revision);
    assert.equal(await post(port, activity({ sequence: 2, status: "idle", file: undefined, line: undefined, column: undefined, language: undefined })), 204);
    const second = await nextWait;
    assert.equal(second.activity?.file, undefined);
    assert.equal(second.activity?.line, undefined);
    assert.equal(second.activity?.status, "idle");
});

test("older posts cannot roll back current activity or resurrect an explicitly closed session", async () => {
    const port = await freePort();
    await start(event, token, port);
    assert.equal(await post(port, activity({ sequence: 2, file: "new.ts" })), 204);
    assert.equal(await post(port, activity({ sequence: 1, file: "old.ts" })), 202);
    assert.equal((await waitForActivity(event, -1)).activity?.file, "new.ts");
    assert.equal(await post(port, activity({ sequence: 3, status: "unavailable" })), 204);
    assert.equal((await waitForActivity(event, -1)).activity, null);
    assert.equal(await post(port, activity({ sequence: 2 })), 202);
    assert.equal((await waitForActivity(event, -1)).activity, null);
});

test("multiple windows prefer focus then recent editing and preserve the unfocused editor", async () => {
    const port = await freePort();
    await start(event, token, port);
    await post(port, activity({ sessionId: "window-one", file: "one.ts", lastActiveAt: Date.now() - 10_000 }));
    await post(port, activity({ sessionId: "window-two", focused: false, file: "two.ts" }));
    assert.equal((await waitForActivity(event, -1)).activity?.file, "one.ts");
    await post(port, activity({ sessionId: "window-one", sequence: 2, focused: false, file: "one.ts", lastActiveAt: Date.now() - 10_000 }));
    assert.equal((await waitForActivity(event, -1)).activity?.file, "two.ts");
    await post(port, activity({ sessionId: "window-two", sequence: 2, status: "unavailable" }));
    assert.equal((await waitForActivity(event, -1)).activity?.file, "one.ts");
});

test("missed close or crashed VS Code expires within the 45 second lease", async t => {
    const port = await freePort();
    await start(event, token, port);
    await post(port, activity());
    const current = await waitForActivity(event, -1);
    const pending = waitForActivity(event, current.revision);
    const elapsed = performance.now() + STALE_AFTER_MS + 1;
    t.mock.method(performance, "now", () => elapsed);
    assert.equal((await waitForActivity(event, -1)).activity, null);
    assert.equal((await pending).activity, null);
});

test("idempotent starts share one server; stop clears pending waits and allows port reuse", async () => {
    const port = await freePort();
    const initial = await start(event, token, port);
    assert.equal((await start(event, token, port)).revision, initial.revision);
    assert.equal(sender.listenerCount("destroyed"), 1);
    const pending = waitForActivity(event, initial.revision);
    await stop(event);
    assert.equal((await pending).activity, null);
    assert.equal(sender.listenerCount("destroyed"), 0);
    const restarted = await start(event, token, port);
    assert.equal(restarted.error, undefined);
    assert.ok(restarted.revision > initial.revision);
    assert.equal(await post(port, activity()), 204);
});

test("superseded waits resolve and every long poll has a 25 second bound", async t => {
    const port = await freePort();
    const current = await start(event, token, port);
    const first = waitForActivity(event, current.revision);
    const second = waitForActivity(event, current.revision);
    assert.equal((await first).revision, current.revision);
    await stop(event);
    assert.equal((await second).activity, null);
    const restarted = await start(event, token, port);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const timed = waitForActivity(event, restarted.revision);
    t.mock.timers.tick(25_000);
    assert.equal((await timed).revision, restarted.revision);
    t.mock.timers.reset();
});

test("another renderer cannot read or alter the owning renderer bridge", async () => {
    const port = await freePort();
    await start(event, token, port);
    const stranger = { sender: new Sender() } as unknown as Parameters<typeof start>[0];
    assert.throws(() => waitForActivity(stranger, -1), /another Discord window/);
    await assert.rejects(stop(stranger), /another Discord window/);
    await assert.rejects(start(stranger, token, port), /another Discord window/);
    assert.equal(await post(port, activity()), 204);
});

test("renderer destruction closes native resources, settles subscribers, and permits restart", async () => {
    const port = await freePort();
    const current = await start(event, token, port);
    const pending = waitForActivity(event, current.revision);
    sender.destroy();
    assert.equal((await pending).activity, null);
    sender.destroyed = false;
    assert.equal((await start(event, token, port)).error, undefined);
    assert.equal(await post(port, activity()), 204);
});

test("destroying a renderer during startup settles startup and does not block future operations", { timeout: 2000 }, async () => {
    const port = await freePort();
    const pending = start(event, token, port);
    queueMicrotask(() => sender.destroy());
    assert.equal((await pending).activity, null);
    sender.destroyed = false;
    assert.equal(sender.listenerCount("destroyed"), 0);
    assert.equal((await start(event, token, port)).error, undefined);
});

test("occupied port reports a safe error and leaves no listeners before retry", async () => {
    const port = await freePort();
    const blocker = createServer();
    blocker.listen(port, "127.0.0.1");
    await once(blocker, "listening");
    const failed = await start(event, token, port);
    assert.match(failed.error!, /port/);
    assert.equal(failed.activity, null);
    assert.equal(sender.listenerCount("destroyed"), 0);
    assert.ok(!JSON.stringify(failed).includes(token));
    await new Promise<void>(resolve => blocker.close(() => resolve()));
    assert.equal((await start(event, token, port)).error, undefined);
});

test("concurrent enable, reconfigure, and disable operations serialize without duplicate listeners", async () => {
    const firstPort = await freePort();
    const secondPort = await freePort();
    await Promise.all([start(event, token, firstPort), start(event, token, secondPort), stop(event)]);
    assert.equal(sender.listenerCount("destroyed"), 0);
    assert.equal((await start(event, token, firstPort)).error, undefined);
    await stop(event);
    assert.equal((await start(event, token, secondPort)).error, undefined);
});

test("the session table is bounded even when an authenticated client invents window identities", async () => {
    const port = await freePort();
    await start(event, token, port);
    for (let index = 0; index < 64; index++) {
        assert.equal(await post(port, activity({ sessionId: `window-id-${index}`, focused: false })), 204);
    }
    assert.equal(await post(port, activity({ sessionId: "window-id-extra" })), 429);
    assert.equal(await post(port, activity({ sessionId: "window-id-1", sequence: 2, file: "updated.ts" })), 204);
    assert.equal((await waitForActivity(event, -1)).activity?.file, "updated.ts");
});

test("authenticated request bursts are bounded before JSON processing", async t => {
    const port = await freePort();
    let elapsed = performance.now();
    t.mock.method(performance, "now", () => elapsed);
    await start(event, token, port);
    for (let index = 1; index <= 120; index++) {
        assert.equal(await post(port, activity({ sequence: index })), 204);
    }
    assert.equal(await post(port, activity({ sequence: 121 })), 429);
    elapsed += 1001;
    assert.equal(await post(port, activity({ sequence: 122 })), 204);
});
