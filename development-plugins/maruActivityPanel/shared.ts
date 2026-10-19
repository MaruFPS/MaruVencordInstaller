/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const DEFAULT_PORT = 32145;
export const STALE_AFTER_MS = 45_000;
export const MAX_BODY_BYTES = 8192;

export interface VSCordIdentity {
    applicationId: string;
    pid: number;
    allowText: boolean;
    allowImages: boolean;
    allowTimestamp: boolean;
    allowButtons: boolean;
}

export interface Activity {
    sessionId: string;
    sequence: number;
    status: "coding" | "idle" | "unavailable";
    updatedAt: number;
    lastActiveAt: number;
    focused: boolean;
    startedAt?: number;
    workspace?: string;
    file?: string;
    language?: string;
    line?: number;
    column?: number;
    repository?: string;
    vscord?: VSCordIdentity;
}

export interface Snapshot {
    revision: number;
    activity: Activity | null;
    error?: string;
}

const allowedKeys = new Set([
    "sessionId", "sequence", "status", "updatedAt", "lastActiveAt", "focused",
    "startedAt", "workspace", "file", "language", "line", "column", "repository", "vscord"
]);

const identityKeys = new Set(["applicationId", "pid", "allowText", "allowImages", "allowTimestamp", "allowButtons"]);

function parseVSCordIdentity(value: unknown): VSCordIdentity | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (Object.keys(data).some(key => !identityKeys.has(key))
        || typeof data.applicationId !== "string" || !/^\d{17,20}$/.test(data.applicationId)
        || !integer(data.pid, 1, 0xffffffff)
        || [data.allowText, data.allowImages, data.allowTimestamp, data.allowButtons].some(flag => typeof flag !== "boolean")) return null;
    return {
        applicationId: data.applicationId,
        pid: data.pid,
        allowText: data.allowText as boolean,
        allowImages: data.allowImages as boolean,
        allowTimestamp: data.allowTimestamp as boolean,
        allowButtons: data.allowButtons as boolean
    };
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function text(value: unknown, max: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= max
        && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Reject unknown fields rather than inadvertently accepting editor contents or paths. */
export function parseActivity(value: unknown, now = Date.now()): Activity | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (Object.keys(data).some(key => !allowedKeys.has(key))) return null;
    if (!text(data.sessionId, 128) || !/^[A-Za-z0-9_-]{8,128}$/.test(data.sessionId)) return null;
    if (!integer(data.sequence, 1) || !integer(data.updatedAt, now - 60_000, now + 5000)
        || !integer(data.lastActiveAt, 0, data.updatedAt) || typeof data.focused !== "boolean"
        || !["coding", "idle", "unavailable"].includes(data.status as string)) return null;
    if (data.startedAt !== undefined && !integer(data.startedAt, 0, data.updatedAt)) return null;
    if (data.workspace !== undefined && !text(data.workspace, 256)) return null;
    if (data.file !== undefined && (!text(data.file, 256) || /[/\\]/.test(data.file))) return null;
    if (data.language !== undefined && (!text(data.language, 64) || !/^[\w.+#-]+$/.test(data.language))) return null;
    if (data.line !== undefined && !integer(data.line, 1, 100_000_000)) return null;
    if (data.column !== undefined && !integer(data.column, 1, 100_000_000)) return null;
    const vscord = data.vscord === undefined ? undefined : parseVSCordIdentity(data.vscord);
    if (vscord === null) return null;
    let repository: string | undefined;
    if (data.repository !== undefined) {
        if (!text(data.repository, 2048)) return null;
        try {
            const url = new URL(data.repository);
            if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
            url.search = "";
            url.hash = "";
            repository = url.toString();
        } catch {
            return null;
        }
    }
    const activity: Activity = {
        sessionId: data.sessionId,
        sequence: data.sequence,
        status: data.status as Activity["status"],
        updatedAt: data.updatedAt,
        lastActiveAt: data.lastActiveAt,
        focused: data.focused
    };
    if (activity.status === "unavailable") return activity;
    if (data.startedAt !== undefined) activity.startedAt = data.startedAt as number;
    if (data.workspace !== undefined) activity.workspace = data.workspace as string;
    if (data.file !== undefined) activity.file = data.file as string;
    if (data.language !== undefined) activity.language = data.language as string;
    if (data.line !== undefined) activity.line = data.line as number;
    if (data.column !== undefined) activity.column = data.column as number;
    if (repository) activity.repository = repository;
    if (vscord) activity.vscord = vscord;
    return activity;
}

export function isPairingToken(value: unknown): value is string {
    return typeof value === "string" && /^[\x21-\x7e]{32,256}$/.test(value);
}
