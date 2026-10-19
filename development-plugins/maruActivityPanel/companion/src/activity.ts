/* SPDX-License-Identifier: GPL-3.0-or-later */

/** Match this window's local VSCord RPC activity without sending formatted presence text. */
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

export interface Privacy {
    shareWorkspace: boolean;
    shareFile: boolean;
    shareCursor: boolean;
    shareDuration: boolean;
    shareRepository: boolean;
}

export interface EditorSnapshot {
    /** An internal identity only; it is never included in the payload. */
    workspaceKey: string;
    workspace?: string;
    focused: boolean;
    editor?: { file: string; language: string; line: number; column: number; };
    repository?: string;
}

/** Names are bounded, control-free basenames; no path can cross the bridge. */
export function basenameLabel(value: string | undefined): string | undefined {
    const label = value?.replace(/[\\/]+$/g, "").split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128);
    return label || undefined;
}

/** Only public-shaped HTTPS URLs survive; credentials, queries and fragments never do. */
export function normalizeRepository(value: string | undefined): string | undefined {
    if (!value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return;
    let candidate = value;
    const scp = /^git@([A-Za-z0-9.-]+):(.+)$/.exec(value);
    if (scp) candidate = `https://${scp[1]}/${scp[2]}`;
    let url: URL;
    try { url = new URL(candidate); } catch { return; }
    if (!["https:", "ssh:"].includes(url.protocol)) return;
    if (url.protocol === "ssh:" && url.username !== "git") return;
    const host = url.hostname.toLowerCase();
    // Repository links must not target local services or expose local paths.
    if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local") || host === "localhost" || /^\d+(\.\d+){3}$/.test(host) || host.includes(":")) return;
    if (url.port && !["443", "22"].includes(url.port)) return;
    if (url.pathname.includes("\\") || /%(?:2f|5c|00)/i.test(url.pathname)) return;
    const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    if (path.split("/").filter(Boolean).length < 2) return;
    return `https://${host}${path}`;
}

export function validPort(value: unknown): number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : 32145;
}

export function validIdleSeconds(value: unknown): number {
    return typeof value === "number" && Number.isInteger(value) && value >= 15 && value <= 3600 ? value : 120;
}

export class ActivityModel {
    private sequence = 0;
    private workspaceKey: string | undefined;
    private hasStarted = false;
    private startedAt: number;
    private lastActiveAt: number;

    constructor(readonly sessionId: string, now: number) {
        this.startedAt = this.lastActiveAt = now;
    }

    interact(now: number): void {
        this.lastActiveAt = now;
    }

    idleDeadline(idleSeconds: number): number {
        return this.lastActiveAt + idleSeconds * 1000;
    }

    snapshot(snapshot: EditorSnapshot, privacy: Privacy, idleSeconds: number, now: number): Activity {
        if (this.workspaceKey !== snapshot.workspaceKey) {
            this.workspaceKey = snapshot.workspaceKey;
            this.startedAt = now;
            this.hasStarted = false;
        }
        const editor = snapshot.editor;
        if (editor && !this.hasStarted) {
            this.startedAt = now;
            this.hasStarted = true;
        }
        if (!editor) return this.unavailable(now);
        const result: Activity = {
            sessionId: this.sessionId,
            sequence: ++this.sequence,
            status: snapshot.focused && now < this.idleDeadline(idleSeconds) ? "coding" : "idle",
            updatedAt: now,
            lastActiveAt: this.lastActiveAt,
            focused: snapshot.focused
        };
        if (privacy.shareWorkspace) result.workspace = basenameLabel(snapshot.workspace);
        if (privacy.shareDuration && editor) result.startedAt = this.startedAt;
        if (privacy.shareFile && editor) {
            result.file = basenameLabel(editor.file);
            if (/^[\w.+#-]{1,64}$/.test(editor.language)) result.language = editor.language;
        }
        if (privacy.shareCursor && editor) {
            result.line = editor.line;
            result.column = editor.column;
        }
        if (privacy.shareRepository) result.repository = normalizeRepository(snapshot.repository);
        return result;
    }

    unavailable(now: number): Activity {
        return { sessionId: this.sessionId, sequence: ++this.sequence, status: "unavailable", updatedAt: now, lastActiveAt: this.lastActiveAt, focused: false };
    }
}
