import assert from "node:assert/strict";
import { test } from "node:test";

import { activityDisplay } from "../src/userplugins/maruActivityPanel/presentation";
import { Activity, parseActivity } from "../src/userplugins/maruActivityPanel/shared";
import { MirroredPresence } from "../src/userplugins/maruActivityPanel/vscord";

const config = { showFile: true, showWorkspace: true, showCursor: true, showDuration: true, showRepository: true };
const editor: Activity = {
    sessionId: "example-session", sequence: 1, status: "coding", updatedAt: Date.now(), lastActiveAt: Date.now(),
    focused: true, file: "example.ts", workspace: "Folder", language: "typescript", line: 3, column: 1,
    startedAt: Date.now() - 60_000, repository: "https://example.com/raw-repository",
    vscord: { applicationId: "810516608442695700", pid: 1234, allowText: true, allowImages: true, allowTimestamp: true, allowButtons: true }
};
const presence: MirroredPresence = {
    name: "Visual Studio Code", state: "Working on example.ts:3:1", details: "Customized global label",
    startedAt: Date.now() - 300_000, image: { asset: "987654321098765432", title: "TypeScript" },
    buttons: [{ label: "My Repository", url: "https://example.com/custom-repository" }]
};

test("formatted VSCord fields occupy the existing slots and use its timer and buttons", () => {
    const display = activityDisplay(editor, presence, config);
    assert.equal(display.application, presence.name);
    assert.equal(display.file, presence.state);
    assert.equal(display.workspace, presence.details);
    assert.equal(display.startedAt, presence.startedAt);
    assert.deepEqual(display.image, presence.image);
    assert.deepEqual(display.buttons, presence.buttons);
});

test("missing RPC restores the original editor display and timer without mutating them", () => {
    const before = JSON.stringify(editor);
    const display = activityDisplay(editor, null, config);
    assert.equal(display.application, "VS Code");
    assert.equal(display.file, editor.file);
    assert.equal(display.workspace, editor.workspace);
    assert.equal(display.startedAt, editor.startedAt);
    assert.deepEqual(display.buttons, [{ label: "View Repository", url: editor.repository }]);
    assert.equal(JSON.stringify(editor), before);
});

test("a genuine payload that omits optional fields does not fabricate raw counterparts", () => {
    const display = activityDisplay(editor, {}, config);
    assert.equal(display.file, undefined);
    assert.equal(display.workspace, undefined);
    assert.equal(display.startedAt, undefined);
    assert.deepEqual(display.buttons, []);
});

test("each panel visibility setting prevents free-form templates from revealing a hidden field", () => {
    for (const field of Object.keys(config)) {
        const display = activityDisplay(editor, presence, { ...config, [field]: false });
        assert.notEqual(display.file, presence.state, field);
        assert.notEqual(display.workspace, presence.details, field);
        assert.equal(display.image?.title, undefined, field);
        assert.notDeepEqual(display.buttons, presence.buttons, field);
    }
});

test("source privacy flags cannot be bypassed by customized text, images, timestamps or links", () => {
    const masked = { ...editor, file: undefined, workspace: undefined, startedAt: undefined, repository: undefined,
        vscord: { ...editor.vscord!, allowText: false, allowImages: false, allowTimestamp: false, allowButtons: false } };
    const display = activityDisplay(masked, presence, config);
    assert.equal(display.file, undefined);
    assert.equal(display.workspace, undefined);
    assert.equal(display.startedAt, undefined);
    assert.equal(display.image, undefined);
    assert.deepEqual(display.buttons, []);
});

test("wire validator accepts old metadata and the bounded identity without accepting arbitrary RPC text", () => {
    assert.deepEqual(parseActivity(editor)?.vscord, editor.vscord);
    assert.equal(parseActivity({ ...editor, vscord: undefined })?.file, editor.file);
    for (const vscord of [null, { ...editor.vscord, pid: 0 }, { ...editor.vscord, applicationId: "not-an-id" },
        { ...editor.vscord, allowText: "true" }, { ...editor.vscord, details: "unexpected formatted text" }]) {
        assert.equal(parseActivity({ ...editor, vscord }), null);
    }
    assert.equal(parseActivity({ ...editor, status: "unavailable" })?.vscord, undefined);
});
