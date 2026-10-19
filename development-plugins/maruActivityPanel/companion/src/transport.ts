/* SPDX-License-Identifier: GPL-3.0-or-later */

import { request, ClientRequest } from "node:http";
import type { Activity } from "./activity";

export const HEARTBEAT_MS = 15_000;
export const REQUEST_TIMEOUT_MS = 1_500;

/** Bounded, serialized, latest-value delivery. No sockets remain open between sends. */
export class LoopbackTransport {
    private current: ClientRequest | undefined;
    private queued: Activity | undefined;
    private draining: Promise<void> | undefined;
    private closed = false;

    constructor(private readonly port: number, private readonly token: string) {
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local bridge port");
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Invalid pairing token");
    }

    publish(activity: Activity): void {
        if (this.closed) return;
        this.queued = activity;
        if (!this.draining) {
            this.draining = this.drain().finally(() => {
                this.draining = undefined;
                if (this.queued && !this.closed) this.publish(this.queued);
            });
        }
    }

    private async drain(): Promise<void> {
        while (this.queued && !this.closed) {
            const activity = this.queued;
            this.queued = undefined;
            await this.send(activity);
        }
    }

    private async send(activity: Activity): Promise<void> {
        const status = await this.sendOnce(activity);
        // Older plugin validators reject the new optional identity. Preserve raw tracking
        // without remembering a legacy mode, so a plugin update enables mirroring itself.
        if (status === 400 && activity.vscord && !this.closed) {
            const legacy = { ...activity };
            delete legacy.vscord;
            await this.sendOnce(legacy);
        }
    }

    private sendOnce(activity: Activity): Promise<number | undefined> {
        const body = JSON.stringify(activity);
        if (Buffer.byteLength(body) > 8192) return Promise.resolve(undefined);
        return new Promise(resolve => {
            let finished = false;
            const done = (status?: number) => {
                if (finished) return;
                finished = true;
                if (this.current === req) this.current = undefined;
                resolve(status);
            };
            const req = request({
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
                response.on("error", () => done());
                response.on("end", () => done(response.statusCode));
            });
            this.current = req;
            // A deadline covers DNS/connect/response time; socket inactivity alone is insufficient.
            const deadline = setTimeout(() => req.destroy(), REQUEST_TIMEOUT_MS);
            deadline.unref();
            req.on("error", () => done());
            req.on("close", () => { clearTimeout(deadline); done(); });
            req.end(body);
        });
    }

    async dispose(finalActivity?: Activity): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.queued = undefined;
        this.current?.destroy();
        await this.draining;
        if (finalActivity) await this.send(finalActivity);
        this.current?.destroy();
    }
}
