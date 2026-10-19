/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";

import { onSourceSettingsChanged, settings } from "./settings";
import { Snapshot } from "./shared";

const Native = VencordNative.pluginHelpers.MaruActivityPanel as PluginNative<typeof import("./native")>;
const listeners = new Set<() => void>();
let snapshot: Snapshot = { revision: 0, activity: null };
let active = false;
let generation = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let operations = Promise.resolve();

function publish(next: Snapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
}

export const activitySource = {
    isRunning: () => active,
    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
    start() {
        active = true;
        onSourceSettingsChanged(reconfigure);
        reconfigure();
    },
    stop() {
        active = false;
        onSourceSettingsChanged(() => {});
        reconfigure();
    }
};

function reconfigure() {
    const current = ++generation;
    clearTimeout(retry);
    publish({ revision: 0, activity: null });
    // Serialize native changes, including settings changes during an outstanding long poll.
    operations = operations.catch(() => {}).then(async () => {
        if (!Native) {
            if (active) publish({ revision: 0, activity: null, error: "Desktop native bridge unavailable. Fully restart Discord after building." });
            return;
        }
        await Native.stop();
        if (!active || current !== generation || !settings.store.showPanel) return;
        if (!settings.store.bridgeToken) {
            publish({ revision: 0, activity: null, error: "Pair using Maru Activity: Pair with Discord in VS Code." });
            return;
        }
        try {
            const initial = await Native.start(settings.store.bridgeToken, settings.store.bridgePort);
            if (current !== generation) return;
            publish(initial);
            if (initial.error) scheduleRetry(current);
            else void listen(current, initial.revision);
        } catch {
            failed(current);
        }
    }).catch(() => failed(current));
}

async function listen(current: number, revision: number) {
    while (active && current === generation) {
        try {
            const next = await Native.waitForActivity(revision);
            if (current !== generation || !active) return;
            if (next.revision !== revision || next.error !== snapshot.error) publish(next);
            revision = next.revision;
            if (next.error) { scheduleRetry(current); return; }
        } catch {
            failed(current);
            return;
        }
    }
}

function failed(current: number) {
    if (current !== generation || !active) return;
    publish({ revision: 0, activity: null, error: "Local editor connection unavailable. Check the port and restart Discord if needed." });
    scheduleRetry(current);
}

function scheduleRetry(current: number) {
    if (current !== generation || !active) return;
    retry = setTimeout(() => { if (current === generation && active) reconfigure(); }, 5000);
}
