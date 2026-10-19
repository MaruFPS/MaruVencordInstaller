import assert from "node:assert/strict";
import { test } from "node:test";

import { Activity, STALE_AFTER_MS, VSCordIdentity } from "../src/userplugins/maruActivityPanel/shared";
import { selectVSCordPresence } from "../src/userplugins/maruActivityPanel/vscord";

const applicationId = "123456789012345678";
const pid = 1234;
const startedAt = Date.now() - 60000;

function editor(identity: Partial<VSCordIdentity> = {}, changes: Partial<Activity> = {}): Activity {
    return {
        sessionId: "example_session", sequence: 1, status: "coding", updatedAt: Date.now(),
        lastActiveAt: Date.now(), focused: true, file: "example.ts", workspace: "Example",
        vscord: {
            applicationId, pid, allowText: true, allowImages: true,
            allowTimestamp: true, allowButtons: true, ...identity
        },
        ...changes
    };
}

function rpc(overrides: Record<string, unknown> = {}) {
    return {
        application_id: applicationId, name: "Visual Studio Code", details: "Custom project label",
        state: "Working on example.ts:10:2", timestamps: { start: startedAt },
        assets: { large_image: "987654321098765432", large_text: "TypeScript" },
        buttons: ["View Repository"], metadata: { button_urls: ["https://example.com/project"] },
        ...overrides
    };
}

function socket(presence: Record<string, unknown> = rpc()) {
    return { socket: [pid, presence, 0] };
}

test("mirrors finalized local RPC text, assets, milliseconds, and buttons", () => {
    assert.deepEqual(selectVSCordPresence(socket(), editor()), {
        name: "Visual Studio Code", details: "Custom project label", state: "Working on example.ts:10:2",
        startedAt, image: { asset: "987654321098765432", title: "TypeScript" },
        buttons: [{ label: "View Repository", url: "https://example.com/project" }]
    });
});

test("does not take Discord status or public SelfPresenceStore as input", () => {
    // LocalActivityStore has the same shape while Online, DND, and Invisible.
    // This fixture checks the selector contract; it is not a live status test.
    for (const status of ["online", "dnd", "invisible"]) {
        const raw = { ...socket(), status };
        assert.equal(selectVSCordPresence(raw, editor())?.details, "Custom project label");
    }
});

test("requires the exact companion PID and VSCord application ID", () => {
    assert.equal(selectVSCordPresence({ otherWindow: [pid + 1, rpc(), 0] }, editor()), null);
    assert.equal(selectVSCordPresence(socket(rpc({ application_id: "999999999999999999" })), editor()), null);
    assert.equal(selectVSCordPresence({ wrong: [pid, null] }, editor()), null);
    assert.equal(selectVSCordPresence(socket(), editor({ pid: 0 })), null);
    assert.equal(selectVSCordPresence(socket(), editor({ applicationId: "not-an-id" })), null);
});

test("ambiguous matching sockets retain the independent editor fallback", () => {
    assert.equal(selectVSCordPresence({ first: [pid, rpc()], second: [pid, rpc()] }, editor()), null);
});

test("disconnect, unavailable editor, missing identity, and stale bridge data never mirror", () => {
    assert.equal(selectVSCordPresence({}, editor()), null);
    assert.equal(selectVSCordPresence(null, editor()), null);
    assert.equal(selectVSCordPresence(socket(), null), null);
    assert.equal(selectVSCordPresence(socket(), editor({}, { status: "unavailable" })), null);
    assert.equal(selectVSCordPresence(socket(), editor({}, { vscord: undefined })), null);
    assert.equal(selectVSCordPresence(socket(), editor({}, { updatedAt: Date.now() - STALE_AFTER_MS - 1000 })), null);
    assert.equal(selectVSCordPresence(socket(), editor({}, { updatedAt: Date.now() + 6000 })), null);
});

test("privacy controls suppress arbitrary formatted text, image tooltips, duration, and links", () => {
    const mirror = selectVSCordPresence(socket(), editor({
        allowText: false, allowTimestamp: false, allowButtons: false
    }));
    assert.deepEqual(mirror, { image: { asset: "987654321098765432" } });
    assert.deepEqual(selectVSCordPresence(socket(), editor({
        allowText: false, allowImages: false, allowTimestamp: false, allowButtons: false
    })), {});
});

test("VSCord omissions do not invent text, buttons, or a fallback session timestamp", () => {
    const mirror = selectVSCordPresence(socket({ application_id: applicationId }), editor({}, { startedAt }));
    assert.equal(mirror?.startedAt, undefined);
    assert.equal(mirror?.details, undefined);
    assert.equal(mirror?.state, undefined);
    assert.equal(mirror?.image, undefined);
    assert.equal(mirror?.buttons, undefined);
    assert.notEqual(mirror, null);
});

test("images only accept Discord-resolved assets", () => {
    assert.equal(selectVSCordPresence(socket(rpc({ assets: { large_image: "mp:external/example/https/example.com/image.png" } })), editor())?.image?.asset,
        "mp:external/example/https/example.com/image.png");
    for (const asset of ["https://example.com/image.png", "mp://example.com/image.png", "mp:../image.png", "javascript:alert(1)", "typescript"]) {
        assert.equal(selectVSCordPresence(socket(rpc({ assets: { large_image: asset } })), editor())?.image, undefined);
    }
});

test("invalid or future timestamps are omitted rather than converted or fabricated", () => {
    for (const start of [undefined, null, "1234", NaN, Infinity, -1, Date.now() + 60000]) {
        assert.equal(selectVSCordPresence(socket(rpc({ timestamps: { start } })), editor())?.startedAt, undefined);
    }
});

test("button labels and URLs stay paired and unsafe destinations are rejected", () => {
    assert.deepEqual(selectVSCordPresence(socket(rpc({
        buttons: ["Unsafe", "Repository", "Extra"],
        metadata: { button_urls: ["javascript:alert(1)", "https://example.com/repo", "https://example.com/extra"] }
    })), editor())?.buttons, [{ label: "Repository", url: "https://example.com/repo" }]);
    for (const url of ["http://example.com", "https://user:secret@example.com", "file:///private", "invalid"]) {
        assert.deepEqual(selectVSCordPresence(socket(rpc({ metadata: { button_urls: [url] } })), editor())?.buttons, []);
    }
});

test("oversized and control-character optional strings are omitted safely", () => {
    const mirror = selectVSCordPresence(socket(rpc({
        name: "Bad\nname", details: "x".repeat(513), state: { text: "Unexpected" },
        assets: { large_image: "987654321098765432", large_text: "Bad\rtooltip" }
    })), editor());
    assert.equal(mirror?.name, undefined);
    assert.equal(mirror?.details, undefined);
    assert.equal(mirror?.state, undefined);
    assert.equal(mirror?.image?.title, undefined);
});
