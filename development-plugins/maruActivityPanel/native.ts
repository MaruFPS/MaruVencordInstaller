/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";

import type { IpcMainInvokeEvent, WebContents } from "electron";

import { Activity, DEFAULT_PORT, isPairingToken, MAX_BODY_BYTES, parseActivity, Snapshot, STALE_AFTER_MS } from "./shared";

interface Session {
    sequence: number;
    receivedAt: number;
    activity: Activity | null;
}

interface Waiter {
    finish: (snapshot: Snapshot) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface Bridge {
    owner: WebContents;
    token: Buffer;
    port: number;
    server: Server;
    sockets: Set<Socket>;
    sessions: Map<string, Session>;
    waiters: Set<Waiter>;
    activity: Activity | null;
    expiry?: ReturnType<typeof setInterval>;
    onDestroyed: () => void;
    disposed: boolean;
    rateStartedAt: number;
    rateRequests: number;
    error?: string;
    closing?: Promise<void>;
}

let bridge: Bridge | undefined;
let revision = 0;
let operation = Promise.resolve();

function serialize<T>(callback: () => Promise<T>): Promise<T> {
    const next = operation.then(callback, callback);
    operation = next.then(() => { }, () => { });
    return next;
}

function snapshot(state?: Bridge): Snapshot {
    return {
        revision,
        activity: state && !state.disposed && state.activity ? { ...state.activity } : null,
        ...(state?.error ? { error: state.error } : {})
    };
}

function notify(state: Bridge) {
    revision++;
    const value = snapshot(state);
    for (const waiter of state.waiters) waiter.finish(value);
}

function selectActivity(state: Bridge, now = performance.now()) {
    for (const [id, session] of state.sessions) {
        if (now - session.receivedAt >= STALE_AFTER_MS) state.sessions.delete(id);
    }
    const candidates = [...state.sessions.values()].filter(session => session.activity !== null);
    candidates.sort((a, b) => Number(b.activity!.focused) - Number(a.activity!.focused)
        || b.activity!.lastActiveAt - a.activity!.lastActiveAt || b.receivedAt - a.receivedAt);
    const selected = candidates[0]?.activity ?? null;
    if (selected !== state.activity) {
        state.activity = selected;
        notify(state);
    }
}

function response(res: ServerResponse, code: number) {
    if (!res.writableEnded && !res.destroyed) {
        if (code >= 400) res.setHeader("Connection", "close");
        res.writeHead(code, { "Cache-Control": "no-store", "Content-Length": "0" }).end();
    }
}

function receive(state: Bridge, req: IncomingMessage, res: ServerResponse) {
    // No browser origin is accepted; this endpoint is for the paired local extension host.
    if (state.disposed) return response(res, 503);
    if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${state.port}`) return response(res, 403);
    if (req.url !== "/activity") return response(res, 404);
    if (req.method !== "POST") return response(res, 405);
    const { authorization } = req.headers;
    const supplied = Buffer.from(typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
    if (supplied.length !== state.token.length || !timingSafeEqual(supplied, state.token)) return response(res, 401);
    const requestedAt = performance.now();
    if (requestedAt - state.rateStartedAt >= 1000 || requestedAt < state.rateStartedAt) {
        state.rateStartedAt = requestedAt;
        state.rateRequests = 0;
    }
    if (++state.rateRequests > 120) return response(res, 429);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) return response(res, 415);
    if (req.headers["content-encoding"] !== undefined) return response(res, 415);
    const length = req.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return response(res, 413);
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
        else response(res, 413);
    });
    req.on("error", () => response(res, 400));
    req.on("end", () => {
        if (res.writableEnded || state.disposed) return response(res, 503);
        let activity: Activity | null;
        try {
            activity = parseActivity(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
            return response(res, 400);
        }
        if (!activity) return response(res, 400);
        const now = performance.now();
        selectActivity(state, now);
        const previous = state.sessions.get(activity.sessionId);
        if (previous && previous.sequence >= activity.sequence) return response(res, 202);
        if (!previous && state.sessions.size >= 64) return response(res, 429);
        // Tombstones preserve ordering after an explicit close, preventing old in-flight posts from resurrecting it.
        state.sessions.set(activity.sessionId, {
            sequence: activity.sequence,
            receivedAt: now,
            activity: activity.status === "unavailable" ? null : activity
        });
        selectActivity(state, now);
        response(res, 204);
    });
}

function dispose(state: Bridge): Promise<void> {
    if (state.closing) return state.closing;
    state.disposed = true;
    if (bridge === state) bridge = undefined;
    if (state.expiry) clearInterval(state.expiry);
    state.owner.removeListener("destroyed", state.onDestroyed);
    state.activity = null;
    state.sessions.clear();
    state.token.fill(0);
    notify(state);
    state.closing = new Promise(resolve => {
        state.server.close(() => resolve());
        for (const socket of state.sockets) socket.destroy();
        state.sockets.clear();
    });
    return state.closing;
}

function requireOwner(event: IpcMainInvokeEvent, state: Bridge) {
    if (event.sender !== state.owner || event.sender.isDestroyed()) throw new Error("This activity bridge belongs to another Discord window.");
}

/** Only these three functions are exported: Vencord exposes every native export over IPC. */
export function start(event: IpcMainInvokeEvent, token: string, port = DEFAULT_PORT): Promise<Snapshot> {
    return serialize(async () => {
        if (bridge) requireOwner(event, bridge);
        if (!isPairingToken(token)) {
            if (bridge) await dispose(bridge);
            return { revision: ++revision, activity: null, error: "Enter a pairing token containing 32–256 printable characters without spaces." };
        }
        if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
            if (bridge) await dispose(bridge);
            return { revision: ++revision, activity: null, error: "The local port must be an integer from 1024 to 65535." };
        }
        if (event.sender.isDestroyed()) return { revision: ++revision, activity: null, error: "Discord window was closed." };
        if (bridge) {
            if (bridge.port === port && bridge.token.equals(Buffer.from(token))) return snapshot(bridge);
            await dispose(bridge);
        }
        const state: Bridge = {
            owner: event.sender,
            token: Buffer.from(token),
            port,
            server: createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, connectionsCheckingInterval: 1000 }),
            sockets: new Set(),
            sessions: new Map(),
            waiters: new Set(),
            activity: null,
            disposed: false,
            rateStartedAt: performance.now(),
            rateRequests: 0,
            onDestroyed: () => { void dispose(state); }
        };
        bridge = state;
        state.owner.once("destroyed", state.onDestroyed);
        state.server.keepAliveTimeout = 1000;
        state.server.maxRequestsPerSocket = 100;
        state.server.on("request", (req, res) => receive(state, req, res));
        state.server.on("connection", socket => {
            if (state.disposed || state.sockets.size >= 32) return socket.destroy();
            state.sockets.add(socket);
            socket.setTimeout(5000, () => socket.destroy());
            socket.once("close", () => state.sockets.delete(socket));
        });
        try {
            await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    state.server.removeListener("error", failed);
                    state.server.removeListener("close", closed);
                };
                const failed = (error: Error) => { cleanup(); reject(error); };
                const closed = () => failed(new Error("Activity bridge closed during startup."));
                state.server.once("error", failed);
                state.server.once("close", closed);
                state.server.listen(port, "127.0.0.1", () => {
                    cleanup();
                    resolve();
                });
            });
        } catch {
            if (!state.disposed) state.error = "Could not open the local activity port. Check that the port is free and matches VS Code.";
            await dispose(state);
            return snapshot(state);
        }
        state.server.on("error", () => {
            state.error = "The local activity bridge stopped unexpectedly. Restart MaruActivityPanel.";
            void dispose(state);
        });
        if (state.disposed) {
            state.server.close();
            return snapshot(state);
        }
        state.expiry = setInterval(() => selectActivity(state), 1000);
        state.expiry.unref();
        notify(state);
        return snapshot(state);
    });
}

export function waitForActivity(event: IpcMainInvokeEvent, afterRevision: number): Promise<Snapshot> {
    const state = bridge;
    if (!state) return Promise.resolve({ ...snapshot(), error: "The local activity bridge is not running." });
    requireOwner(event, state);
    selectActivity(state);
    if (afterRevision !== revision) return Promise.resolve(snapshot(state));
    // One subscriber is sufficient for the single owning renderer. Superseded waits are resolved immediately.
    for (const waiter of state.waiters) waiter.finish(snapshot(state));
    return new Promise(resolve => {
        const waiter: Waiter = {
            finish(value) {
                clearTimeout(waiter.timer);
                state.waiters.delete(waiter);
                resolve(value);
            },
            timer: setTimeout(() => waiter.finish(snapshot(state)), 25_000)
        };
        state.waiters.add(waiter);
    });
}

export function stop(event: IpcMainInvokeEvent): Promise<void> {
    return serialize(async () => {
        if (!bridge) return;
        requireOwner(event, bridge);
        await dispose(bridge);
    });
}
