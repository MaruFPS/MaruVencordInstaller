"use strict";
/* SPDX-License-Identifier: GPL-3.0-or-later */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoopbackTransport = exports.REQUEST_TIMEOUT_MS = exports.HEARTBEAT_MS = void 0;
const node_http_1 = require("node:http");
exports.HEARTBEAT_MS = 15_000;
exports.REQUEST_TIMEOUT_MS = 1_500;
/** Bounded, serialized, latest-value delivery. No sockets remain open between sends. */
class LoopbackTransport {
    port;
    token;
    current;
    queued;
    draining;
    closed = false;
    constructor(port, token) {
        this.port = port;
        this.token = token;
        if (!Number.isInteger(port) || port < 1024 || port > 65535)
            throw new Error("Invalid local bridge port");
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
            throw new Error("Invalid pairing token");
    }
    publish(activity) {
        if (this.closed)
            return;
        this.queued = activity;
        if (!this.draining) {
            this.draining = this.drain().finally(() => {
                this.draining = undefined;
                if (this.queued && !this.closed)
                    this.publish(this.queued);
            });
        }
    }
    async drain() {
        while (this.queued && !this.closed) {
            const activity = this.queued;
            this.queued = undefined;
            await this.send(activity);
        }
    }
    send(activity) {
        const body = JSON.stringify(activity);
        if (Buffer.byteLength(body) > 8192)
            return Promise.resolve();
        return new Promise(resolve => {
            let finished = false;
            const done = () => {
                if (finished)
                    return;
                finished = true;
                if (this.current === req)
                    this.current = undefined;
                resolve();
            };
            const req = (0, node_http_1.request)({
                hostname: "127.0.0.1",
                port: this.port,
                path: "/activity",
                method: "POST",
                agent: false,
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                    Connection: "close"
                }
            }, response => {
                response.resume();
                response.on("error", done);
                response.on("end", done);
            });
            this.current = req;
            // A deadline covers DNS/connect/response time; socket inactivity alone is insufficient.
            const deadline = setTimeout(() => req.destroy(), exports.REQUEST_TIMEOUT_MS);
            deadline.unref();
            req.on("error", done);
            req.on("close", () => { clearTimeout(deadline); done(); });
            req.end(body);
        });
    }
    async dispose(finalActivity) {
        if (this.closed)
            return;
        this.closed = true;
        this.queued = undefined;
        this.current?.destroy();
        await this.draining;
        if (finalActivity)
            await this.send(finalActivity);
        this.current?.destroy();
    }
}
exports.LoopbackTransport = LoopbackTransport;
