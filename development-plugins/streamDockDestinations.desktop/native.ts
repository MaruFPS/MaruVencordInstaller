import type { IpcMainInvokeEvent, WebContents } from "electron";
import { createServer, type Server } from "http";

import type { Snapshot } from "./catalog";

let server: Server | undefined;
let owner: WebContents | undefined;
let snapshot: Snapshot | null = null;
let updatedAt = 0;
let starting: Promise<string> | undefined;
let ownerDestroyed: (() => void) | undefined;
let finishStart: ((state: string) => void) | undefined;

function closeServer() {
    snapshot = null;
    updatedAt = 0;
    if (owner && ownerDestroyed) owner.removeListener("destroyed", ownerDestroyed);
    ownerDestroyed = undefined;
    owner = undefined;
    server?.closeAllConnections();
    server?.close();
    server = undefined;
    finishStart?.("stopped");
    finishStart = undefined;
}

export async function start(event: IpcMainInvokeEvent): Promise<string> {
    if (owner && !owner.isDestroyed() && owner.id !== event.sender.id) return "another_window";
    if (starting) return starting;
    if (server?.listening) return "listening";
    owner = event.sender;
    const currentOwner = owner;
    ownerDestroyed = () => { if (owner === currentOwner) closeServer(); };
    currentOwner.once("destroyed", ownerDestroyed);
    starting = new Promise(resolve => {
        finishStart = resolve;
        const current = createServer((request, response) => {
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Content-Type", "application/json");
            // No CORS; browser requests (including DNS rebinding) cannot read this endpoint.
            if (request.headers.host !== "127.0.0.1:26433" || request.headers.origin ||
                Object.keys(request.headers).some(key => key.startsWith("sec-fetch-")) ||
                request.headers["x-streamdock-destinations"] !== "1") {
                response.writeHead(403).end('{"error":"forbidden"}');
                return;
            }
            if (request.method !== "GET" || request.url !== "/v1/destinations") {
                response.writeHead(404).end('{"error":"not_found"}');
                return;
            }
            if (!owner || owner.isDestroyed() || !snapshot || Date.now() - updatedAt > 15000) {
                response.writeHead(503).end('{"error":"stores_unavailable"}');
                return;
            }
            response.end(JSON.stringify(snapshot));
        });
        server = current;
        current.requestTimeout = 3000;
        current.headersTimeout = 3000;
        current.keepAliveTimeout = 1000;
        current.maxConnections = 8;
        current.on("error", () => {
            resolve("port_unavailable");
            if (server === current) closeServer();
        });
        current.listen(26433, "127.0.0.1", () => resolve("listening"));
    });
    try { return await starting; }
    finally { starting = undefined; finishStart = undefined; }
}

export function publish(event: IpcMainInvokeEvent, value: Snapshot | null): void {
    if (owner?.id !== event.sender.id) return;
    if (value === null) { snapshot = null; updatedAt = 0; return; }
    if (value.version !== 1 || !/^\d{16,22}$/.test(value.accountId) ||
        !Array.isArray(value.privateChannels) || !Array.isArray(value.favorites) ||
        value.privateChannels.length + value.favorites.length > 20000) return;
    // Explicit projection: the local endpoint can never expose arbitrary renderer state.
    const clean = (rows: Snapshot["favorites"]) => rows.map(row => ({
        id: String(row.id).slice(0, 22), name: String(row.name).slice(0, 240),
        type: row.type, guildId: String(row.guildId).slice(0, 22),
        guildName: String(row.guildName).slice(0, 100)
    }));
    snapshot = { version: 1, accountId: value.accountId,
        privateAvailable: value.privateAvailable === true, favoritesAvailable: value.favoritesAvailable === true,
        privateChannels: clean(value.privateChannels), favorites: clean(value.favorites) };
    updatedAt = Date.now();
}

export function stop(event: IpcMainInvokeEvent): void {
    if (owner?.id === event.sender.id) closeServer();
}
