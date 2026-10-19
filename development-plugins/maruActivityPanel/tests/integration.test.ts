import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { IpcMainInvokeEvent } from "electron";

import { start, stop, waitForActivity } from "../src/userplugins/maruActivityPanel/native";

const require = createRequire(import.meta.url);
const { ActivityModel } = require("../companion/out/activity.js");
const { LoopbackTransport } = require("../companion/out/transport.js");

test("compiled companion delivers editor changes and withdrawal through the real native HTTP bridge", async () => {
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    const event = { sender: owner } as unknown as IpcMainInvokeEvent;
    const token = "integration-pairing-secret-32-characters";
    const transport = new LoopbackTransport(port, token);
    const model = new ActivityModel("integration-window", Date.now());
    const privacy = { shareFile: true, shareWorkspace: true, shareCursor: true, shareDuration: true, shareRepository: true };
    const editor = { workspaceKey: "internal-private-key", workspace: "Test workspace", focused: true, editor: { file: "test.ts", language: "typescript", line: 42, column: 7 }, repository: "git@github.com:example/test.git" };
    try {
        const initial = await start(event, token, port);
        assert.equal(initial.error, undefined);
        const pending = waitForActivity(event, initial.revision);
        transport.publish(model.snapshot(editor, privacy, 120, Date.now()));
        const first = await pending;
        assert.equal(first.activity?.file, "test.ts");
        assert.equal(first.activity?.line, 42);
        assert.equal(first.activity?.repository, "https://github.com/example/test");
        assert.equal(JSON.stringify(first).includes("internal-private-key"), false);
        const changed = waitForActivity(event, first.revision);
        transport.publish(model.snapshot({ ...editor, editor: { file: "style.css", language: "css", line: 10, column: 1 } }, { ...privacy, shareFile: false, shareRepository: false }, 120, Date.now()));
        const second = await changed;
        assert.equal(second.activity?.file, undefined);
        assert.equal(second.activity?.repository, undefined);
        assert.equal(second.activity?.line, 10);
        const withdrawn = waitForActivity(event, second.revision);
        await transport.dispose(model.unavailable(Date.now()));
        assert.equal((await withdrawn).activity, null);
    } finally {
        await transport.dispose();
        await stop(event);
        assert.equal(owner.listenerCount("destroyed"), 0);
    }
});
