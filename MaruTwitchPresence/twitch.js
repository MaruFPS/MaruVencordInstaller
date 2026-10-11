let avatarRetryTimer = null;
let routeCheckTimer = null;
let heartbeatTimer = null;
let lastPublishedKey = null;

const ROUTE_CHECK_MS = 2000;
const HEARTBEAT_MS = 30000;

function getStreamerAvatar(channelName) {
    const normalizedChannel =
        channelName.toLowerCase();

    const avatar =
        [...document.images].find(
            img => {
                const src =
                    img.src;

                const href =
                    img.closest("a")
                        ?.getAttribute(
                            "href"
                        );

                if (
                    !src ||
                    !src.includes(
                        "jtv_user_pictures"
                    ) ||
                    !src.includes(
                        "profile_image"
                    )
                ) {
                    return false;
                }

                if (href) {
                    try {
                        const url =
                            new URL(
                                href,
                                window.location.origin
                            );

                        if (
                            url.hostname ===
                                "www.twitch.tv" &&
                            url.pathname
                                .toLowerCase() ===
                                `/${normalizedChannel}`
                        ) {
                            return true;
                        }
                    } catch {
                        // Ignore malformed links.
                    }
                }

                return (
                    img.alt
                        ?.toLowerCase() ===
                    normalizedChannel
                );
            }
        );

    return avatar?.src ?? null;
}

function getCurrentTwitchActivity() {
    const pathParts =
        window.location.pathname
            .split("/")
            .filter(Boolean);

    let channelName = null;
    let mode = "watching";

    if (
        pathParts[0] ===
            "moderator" &&
        pathParts[1]
    ) {
        channelName =
            pathParts[1];

        mode =
            "moderating";
    } else if (
        pathParts[0]
    ) {
        channelName =
            pathParts[0];
    }

    if (!channelName) {
        return null;
    }

    return {
        channelName,
        mode
    };
}

function getCurrentActivitySnapshot() {
    const current =
        getCurrentTwitchActivity();

    if (!current) {
        return {
            active: false
        };
    }

    const {
        channelName,
        mode
    } = current;

    return {
        active: true,
        channel:
            channelName,
        mode,
        avatarUrl:
            getStreamerAvatar(
                channelName
            )
    };
}

function safelySendRuntimeMessage(
    message
) {
    try {
        const pending =
            chrome.runtime.sendMessage(
                message
            );

        if (
            pending &&
            typeof pending.catch ===
                "function"
        ) {
            pending.catch(
                () => {}
            );
        }
    } catch {
        // Extension may be reloading.
    }
}

function sendTabGone() {
    safelySendRuntimeMessage({
        type:
            "TWITCH_TAB_GONE"
    });
}

function sendActivitySnapshot(
    snapshot,
    force = false
) {
    if (
        snapshot?.active !==
        true
    ) {
        if (
            force ||
            lastPublishedKey !==
                null
        ) {
            lastPublishedKey =
                null;

            sendTabGone();
        }

        return;
    }

    const key =
        `${snapshot.channel.toLowerCase()}:` +
        `${snapshot.mode}:` +
        `${snapshot.avatarUrl ?? ""}`;

    if (
        !force &&
        key === lastPublishedKey
    ) {
        return;
    }

    lastPublishedKey =
        key;

    safelySendRuntimeMessage({
        type:
            "TWITCH_CHANNEL",
        channel:
            snapshot.channel,
        mode:
            snapshot.mode,
        avatarUrl:
            snapshot.avatarUrl
    });
}

function startFastAvatarRetry(
    channelName,
    mode
) {
    if (
        avatarRetryTimer !==
        null
    ) {
        clearInterval(
            avatarRetryTimer
        );

        avatarRetryTimer =
            null;
    }

    let attempts = 0;

    avatarRetryTimer =
        setInterval(
            () => {
                attempts++;

                const current =
                    getCurrentTwitchActivity();

                // Stop if we changed channels/pages while waiting.
                if (
                    !current ||
                    current.channelName
                        .toLowerCase() !==
                        channelName.toLowerCase() ||
                    current.mode !==
                        mode
                ) {
                    clearInterval(
                        avatarRetryTimer
                    );

                    avatarRetryTimer =
                        null;

                    return;
                }

                const avatarUrl =
                    getStreamerAvatar(
                        channelName
                    );

                if (avatarUrl) {
                    sendActivitySnapshot(
                        {
                            active:
                                true,
                            channel:
                                channelName,
                            mode,
                            avatarUrl
                        },
                        true
                    );

                    clearInterval(
                        avatarRetryTimer
                    );

                    avatarRetryTimer =
                        null;

                    return;
                }

                // Retry for up to 15 seconds.
                if (
                    attempts >=
                    60
                ) {
                    clearInterval(
                        avatarRetryTimer
                    );

                    avatarRetryTimer =
                        null;
                }
            },
            250
        );
}

function sendCurrentTwitchActivity(
    force = false
) {
    const snapshot =
        getCurrentActivitySnapshot();

    sendActivitySnapshot(
        snapshot,
        force
    );

    if (
        snapshot.active ===
            true &&
        !snapshot.avatarUrl
    ) {
        startFastAvatarRetry(
            snapshot.channel,
            snapshot.mode
        );
    }
}

chrome.runtime.onMessage.addListener(
    (
        message,
        _sender,
        sendResponse
    ) => {
        if (
            message?.type !==
            "TWITCH_PRESENCE_REQUEST_STATE"
        ) {
            return;
        }

        sendResponse(
            getCurrentActivitySnapshot()
        );
    }
);

document.addEventListener(
    "visibilitychange",
    () => {
        sendCurrentTwitchActivity(
            true
        );
    }
);

window.addEventListener(
    "focus",
    () => {
        sendCurrentTwitchActivity(
            true
        );
    }
);

window.addEventListener(
    "pageshow",
    () => {
        sendCurrentTwitchActivity(
            true
        );
    }
);

window.addEventListener(
    "pagehide",
    () => {
        sendTabGone();
    }
);

sendCurrentTwitchActivity(
    true
);

// This timer only watches for Twitch SPA route/channel changes.
// It is NOT the source of truth for whether a background tab is
// still alive, so Chrome throttling it cannot kill the presence.
routeCheckTimer =
    setInterval(
        () => {
            sendCurrentTwitchActivity(
                false
            );
        },
        ROUTE_CHECK_MS
    );

// A modest direct heartbeat gives a fast reconnect when the
// Discord bridge restarts. The service worker's chrome.alarms
// reconciliation is the authoritative background-tab fallback.
heartbeatTimer =
    setInterval(
        () => {
            sendCurrentTwitchActivity(
                true
            );
        },
        HEARTBEAT_MS
    );
