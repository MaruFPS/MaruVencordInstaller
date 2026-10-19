"use strict";
/* SPDX-License-Identifier: GPL-3.0-or-later */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActivityModel = void 0;
exports.basenameLabel = basenameLabel;
exports.normalizeRepository = normalizeRepository;
exports.validPort = validPort;
exports.validIdleSeconds = validIdleSeconds;
/** Names are bounded, control-free basenames; no path can cross the bridge. */
function basenameLabel(value) {
    const label = value?.replace(/[\\/]+$/g, "").split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128);
    return label || undefined;
}
/** Only public-shaped HTTPS URLs survive; credentials, queries and fragments never do. */
function normalizeRepository(value) {
    if (!value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value))
        return;
    let candidate = value;
    const scp = /^git@([A-Za-z0-9.-]+):(.+)$/.exec(value);
    if (scp)
        candidate = `https://${scp[1]}/${scp[2]}`;
    let url;
    try {
        url = new URL(candidate);
    }
    catch {
        return;
    }
    if (!["https:", "ssh:"].includes(url.protocol))
        return;
    if (url.protocol === "ssh:" && url.username !== "git")
        return;
    const host = url.hostname.toLowerCase();
    // Repository links must not target local services or expose local paths.
    if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local") || host === "localhost" || /^\d+(\.\d+){3}$/.test(host) || host.includes(":"))
        return;
    if (url.port && !["443", "22"].includes(url.port))
        return;
    if (url.pathname.includes("\\") || /%(?:2f|5c|00)/i.test(url.pathname))
        return;
    const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    if (path.split("/").filter(Boolean).length < 2)
        return;
    return `https://${host}${path}`;
}
function validPort(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : 32145;
}
function validIdleSeconds(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 15 && value <= 3600 ? value : 120;
}
class ActivityModel {
    sessionId;
    sequence = 0;
    workspaceKey;
    hasStarted = false;
    startedAt;
    lastActiveAt;
    constructor(sessionId, now) {
        this.sessionId = sessionId;
        this.startedAt = this.lastActiveAt = now;
    }
    interact(now) {
        this.lastActiveAt = now;
    }
    idleDeadline(idleSeconds) {
        return this.lastActiveAt + idleSeconds * 1000;
    }
    snapshot(snapshot, privacy, idleSeconds, now) {
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
        if (!editor)
            return this.unavailable(now);
        const result = {
            sessionId: this.sessionId,
            sequence: ++this.sequence,
            status: snapshot.focused && now < this.idleDeadline(idleSeconds) ? "coding" : "idle",
            updatedAt: now,
            lastActiveAt: this.lastActiveAt,
            focused: snapshot.focused
        };
        if (privacy.shareWorkspace)
            result.workspace = basenameLabel(snapshot.workspace);
        if (privacy.shareDuration && editor)
            result.startedAt = this.startedAt;
        if (privacy.shareFile && editor) {
            result.file = basenameLabel(editor.file);
            if (/^[\w.+#-]{1,64}$/.test(editor.language))
                result.language = editor.language;
        }
        if (privacy.shareCursor && editor) {
            result.line = editor.line;
            result.column = editor.column;
        }
        if (privacy.shareRepository)
            result.repository = normalizeRepository(snapshot.repository);
        return result;
    }
    unavailable(now) {
        return { sessionId: this.sessionId, sequence: ++this.sequence, status: "unavailable", updatedAt: now, lastActiveAt: this.lastActiveAt, focused: false };
    }
}
exports.ActivityModel = ActivityModel;
