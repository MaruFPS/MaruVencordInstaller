import { IpcMainInvokeEvent } from "electron";
import { createServer, Server } from "http";

const HOST = "127.0.0.1";
const PORT = 9864;

// The browser extension now explicitly tracks real Twitch tab
// lifecycle and re-announces open streams at least once per minute.
// This timeout is only a crash/failure safeguard, not normal liveness.
const STALE_AFTER_MS = 3 * 60 * 1000;

type TwitchMode = "watching" | "moderating";

interface TwitchActivity {
    channel: string;
    mode: TwitchMode;
    avatarUrl: string | null;
    extraStreams: number;
}

let server: Server | null = null;
let latestActivity: TwitchActivity | null = null;
let lastHeartbeatAt = 0;

function clearActivity() {
    latestActivity = null;
    lastHeartbeatAt = 0;
}

function getFreshActivity(): TwitchActivity | null {
    if (!latestActivity) {
        return null;
    }

    if (
        Date.now() -
            lastHeartbeatAt >
        STALE_AFTER_MS
    ) {
        clearActivity();

        return null;
    }

    return latestActivity;
}

export async function startBridge(
    _: IpcMainInvokeEvent
): Promise<boolean> {
    if (server) {
        return true;
    }

    return new Promise((resolve, reject) => {
        server = createServer((req, res) => {
            if (
                req.method === "GET" &&
                req.url === "/health"
            ) {
                res.writeHead(200, {
                    "Content-Type": "application/json"
                });

                res.end(
                    JSON.stringify({
                        ok: true,
                        latestActivity:
                            getFreshActivity()
                    })
                );

                return;
            }

            if (
                req.method === "DELETE" &&
                req.url === "/activity"
            ) {
                clearActivity();

                console.log(
                    "[TwitchPresence] Cleared Twitch activity."
                );

                res.writeHead(200, {
                    "Content-Type": "application/json"
                });

                res.end(
                    JSON.stringify({
                        ok: true
                    })
                );

                return;
            }

            if (
                req.method === "POST" &&
                req.url === "/activity"
            ) {
                let body = "";

                req.on("data", chunk => {
                    body +=
                        chunk.toString();

                    if (
                        body.length >
                        1024
                    ) {
                        req.destroy();
                    }
                });

                req.on("end", () => {
                    try {
                        const data =
                            JSON.parse(
                                body
                            );

                        const channel =
                            data?.channel;

                        const mode =
                            data?.mode;

                        const avatarUrl =
                            data?.avatarUrl ??
                            null;

                        const extraStreams =
                            data?.extraStreams ??
                            0;

                        if (
                            typeof channel !==
                                "string" ||
                            !/^[a-zA-Z0-9_]{1,25}$/.test(
                                channel
                            )
                        ) {
                            res.writeHead(
                                400,
                                {
                                    "Content-Type":
                                        "application/json"
                                }
                            );

                            res.end(
                                JSON.stringify({
                                    error:
                                        "Invalid channel"
                                })
                            );

                            return;
                        }

                        if (
                            mode !==
                                "watching" &&
                            mode !==
                                "moderating"
                        ) {
                            res.writeHead(
                                400,
                                {
                                    "Content-Type":
                                        "application/json"
                                }
                            );

                            res.end(
                                JSON.stringify({
                                    error:
                                        "Invalid mode"
                                })
                            );

                            return;
                        }

                        if (
                            avatarUrl !==
                            null
                        ) {
                            try {
                                const avatar =
                                    new URL(
                                        avatarUrl
                                    );

                                if (
                                    avatar.protocol !==
                                        "https:" ||
                                    avatar.hostname !==
                                        "static-cdn.jtvnw.net" ||
                                    !avatar.pathname.startsWith(
                                        "/jtv_user_pictures/"
                                    )
                                ) {
                                    throw new Error();
                                }
                            } catch {
                                res.writeHead(
                                    400,
                                    {
                                        "Content-Type":
                                            "application/json"
                                    }
                                );

                                res.end(
                                    JSON.stringify({
                                        error:
                                            "Invalid avatarUrl"
                                    })
                                );

                                return;
                            }
                        }

                        if (
                            !Number.isInteger(
                                extraStreams
                            ) ||
                            extraStreams <
                                0 ||
                            extraStreams >
                                24
                        ) {
                            res.writeHead(
                                400,
                                {
                                    "Content-Type":
                                        "application/json"
                                }
                            );

                            res.end(
                                JSON.stringify({
                                    error:
                                        "Invalid extraStreams"
                                })
                            );

                            return;
                        }

                        latestActivity = {
                            channel,
                            mode,
                            avatarUrl,
                            extraStreams
                        };

                        lastHeartbeatAt =
                            Date.now();

                        console.log(
                            "[TwitchPresence] Received Twitch activity:",
                            latestActivity
                        );

                        res.writeHead(
                            200,
                            {
                                "Content-Type":
                                    "application/json"
                            }
                        );

                        res.end(
                            JSON.stringify({
                                ok: true
                            })
                        );
                    } catch {
                        res.writeHead(
                            400,
                            {
                                "Content-Type":
                                    "application/json"
                            }
                        );

                        res.end(
                            JSON.stringify({
                                error:
                                    "Invalid JSON"
                            })
                        );
                    }
                });

                return;
            }

            res.writeHead(404, {
                "Content-Type": "application/json"
            });

            res.end(
                JSON.stringify({
                    error:
                        "Not found"
                })
            );
        });

        server.once(
            "error",
            error => {
                server = null;
                reject(error);
            }
        );

        server.listen(
            PORT,
            HOST,
            () => {
                resolve(true);
            }
        );
    });
}

export async function stopBridge(
    _: IpcMainInvokeEvent
): Promise<void> {
    clearActivity();

    if (!server) {
        return;
    }

    const currentServer =
        server;

    server = null;

    await new Promise<void>(
        (resolve, reject) => {
            currentServer.close(
                error => {
                    if (error) {
                        reject(
                            error
                        );

                        return;
                    }

                    resolve();
                }
            );
        }
    );
}

export async function getLatestActivity(
    _: IpcMainInvokeEvent
): Promise<TwitchActivity | null> {
    return getFreshActivity();
}

export async function getLatestChannel(
    _: IpcMainInvokeEvent
): Promise<string | null> {
    return (
        getFreshActivity()
            ?.channel ??
        null
    );
}
