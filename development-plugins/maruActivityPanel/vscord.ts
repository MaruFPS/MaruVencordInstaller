/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Activity, STALE_AFTER_MS, VSCordIdentity } from "./shared";

export interface MirroredPresence {
    name?: string;
    details?: string;
    state?: string;
    startedAt?: number;
    image?: { asset: string; title?: string; };
    buttons?: { label: string; url: string; }[];
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, max: number): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= max
        && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function validIdentity(value: VSCordIdentity): boolean {
    return typeof value.applicationId === "string" && /^\d{1,20}$/.test(value.applicationId)
        && Number.isSafeInteger(value.pid) && value.pid > 0;
}

function imageAsset(value: unknown): string | undefined {
    const asset = boundedText(value, 2048);
    if (!asset) return;
    if (/^\d{1,24}$/.test(asset)) return asset;
    // Discord has already resolved these paths through its own media proxy. Do not
    // accept direct URLs, protocol-relative paths, or arbitrary image fetch targets.
    if (/^mp:[A-Za-z0-9][A-Za-z0-9/_%.,~!$&'()*+;=@-]*$/.test(asset)
        && !asset.slice(3).split("/").some(part => part === "." || part === "..")) return asset;
}

function safeButtonUrl(value: unknown): string | undefined {
    const text = boundedText(value, 2048);
    if (!text) return;
    try {
        const url = new URL(text);
        if (url.protocol === "https:" && url.hostname && !url.username && !url.password) return url.href;
    } catch {
        // An invalid optional button must not interrupt the working editor panel.
    }
}

/**
 * Read only the finalized RPC activity for this companion's extension host.
 * Regular Discord's LocalActivityStore retains socketId -> [pid, activity,
 * partyPrivacy] while Invisible; SelfPresenceStore filters it later. The RPC
 * handler has already resolved image assets, milliseconds, and button metadata.
 * We neither read public presence nor publish/modify any activity or user status.
 */
export function selectVSCordPresence(sessions: unknown, activity: Activity | null): MirroredPresence | null {
    const now = Date.now();
    if (!activity || activity.status === "unavailable" || !activity.vscord
        || !validIdentity(activity.vscord) || !Number.isSafeInteger(activity.updatedAt)
        || activity.updatedAt < now - STALE_AFTER_MS || activity.updatedAt > now + 5000) return null;
    const entries = record(sessions);
    if (!entries) return null;
    const identity = activity.vscord;
    const matches: Record<string, unknown>[] = [];
    for (const tuple of Object.values(entries)) {
        if (!Array.isArray(tuple) || tuple.length < 2 || tuple[0] !== identity.pid) continue;
        const presence = record(tuple[1]);
        if (presence?.application_id === identity.applicationId) matches.push(presence);
    }
    // A reused application ID from another VS Code window must never override
    // this window's editor information. Ambiguous hosts use the existing fallback.
    if (matches.length !== 1) return null;
    const [presence] = matches;
    const mirror: MirroredPresence = {};
    if (identity.allowText) {
        mirror.name = boundedText(presence.name, 256);
        mirror.details = boundedText(presence.details, 512);
        mirror.state = boundedText(presence.state, 512);
    }
    if (identity.allowImages) {
        const assets = record(presence.assets);
        const asset = imageAsset(assets?.large_image);
        if (asset) {
            mirror.image = { asset };
            if (identity.allowText) mirror.image.title = boundedText(assets?.large_text, 512);
        }
    }
    if (identity.allowTimestamp) {
        const startedAt = record(presence.timestamps)?.start;
        if (typeof startedAt === "number" && Number.isSafeInteger(startedAt) && startedAt > 0 && startedAt <= now)
            mirror.startedAt = startedAt;
    }
    if (identity.allowButtons && Array.isArray(presence.buttons)) {
        const urls = record(presence.metadata)?.button_urls;
        if (Array.isArray(urls)) {
            mirror.buttons = [];
            for (let i = 0; i < Math.min(presence.buttons.length, urls.length, 2); i++) {
                const label = boundedText(presence.buttons[i], 64);
                const url = safeButtonUrl(urls[i]);
                if (label && url) mirror.buttons.push({ label, url });
            }
        }
    }
    // Empty optional fields are meaningful: VSCord may deliberately omit text,
    // timestamps, imagery, or buttons. Only a missing/invalid match uses fallback.
    return mirror;
}
