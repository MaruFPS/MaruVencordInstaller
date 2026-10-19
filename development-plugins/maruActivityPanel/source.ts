/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { findStore } from "@webpack";

import { onSourceSettingsChanged, settings } from "./settings";
import { Activity, Snapshot } from "./shared";
import { MirroredPresence, selectVSCordPresence } from "./vscord";

interface LocalActivityStore {
    getApplicationActivities(): unknown;
    addChangeListener(listener: () => void): void;
    removeChangeListener(listener: () => void): void;
}

export type PanelSnapshot = Snapshot & { presence: MirroredPresence | null; };

const Native = VencordNative.pluginHelpers.MaruActivityPanel as PluginNative<typeof import("./native")>;
const listeners = new Set<() => void>();
let snapshot: PanelSnapshot = { revision: 0, activity: null, presence: null };
let localStore: LocalActivityStore | undefined;
let active = false;
let generation = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let operations = Promise.resolve();

function publish(next: Snapshot) {
    snapshot = { ...next, presence: readPresence(next.activity) };
    for (const listener of listeners) listener();
}

function detachLocalStore() {
    try { localStore?.removeChangeListener(localActivityChanged); } catch { /* The editor bridge remains independent. */ }
    localStore = undefined;
}

function readPresence(activity: Activity | null): MirroredPresence | null {
    if (!active || !activity?.vscord || activity.status === "unavailable") {
        detachLocalStore();
        return null;
    }
    try {
        if (!localStore) {
            // Read the raw local RPC socket map, before public presence/Invisible filtering.
            // Retry a missing store only on an existing companion update, never by polling.
            const candidate = findStore("LocalActivityStore") as LocalActivityStore | null;
            if (!candidate || typeof candidate.getApplicationActivities !== "function"
                || typeof candidate.addChangeListener !== "function"
                || typeof candidate.removeChangeListener !== "function") return null;
            localStore = candidate;
            localStore.addChangeListener(localActivityChanged);
        }
        return selectVSCordPresence(localStore.getApplicationActivities(), activity);
    } catch {
        detachLocalStore();
        return null;
    }
}

function localActivityChanged() {
    const presence = readPresence(snapshot.activity);
    if (JSON.stringify(presence) === JSON.stringify(snapshot.presence)) return;
    snapshot = { ...snapshot, presence };
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
