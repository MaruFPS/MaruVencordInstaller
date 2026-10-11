let avatarRetryTimer = null;
let routeCheckTimer = null;
let heartbeatTimer = null;
let lastPublishedKey = null;

const ROUTE_CHECK_MS = 2000;
const HEARTBEAT_MS = 30000;

const KICK_CHANNEL_PATTERN =
    /^[a-zA-Z0-9_-]{1,25}$/;

const KICK_CHANNEL_HOSTS =
    new Set([
        "kick.com",
        "www.kick.com"
    ]);

const KICK_NON_CHANNEL_ROUTES =
    new Set([
        "browse",
        "category",
        "categories",
        "search",
        "following",
        "subscriptions",
        "settings",
        "privacy-policy",
        "terms-of-service",
        "community-guidelines",
        "dmca-policy",
        "cookie-policy",
        "partner-terms-and-conditions",
        "advertising-policy",
        "channel-points-terms-and-conditions",
        "auth"
    ]);

function isKickAvatarUrl(value) {
    try {
        const url =
            new URL(value);

        if (
            url.protocol !==
            "https:"
        ) {
            return false;
        }

        if (
            url.hostname ===
                "files.kick.com" &&
            url.pathname.startsWith(
                "/images/user/"
            ) &&
            url.pathname.includes(
                "/profile_image/"
            )
        ) {
            return true;
        }

        return (
            KICK_CHANNEL_HOSTS.has(
                url.hostname
            ) &&
            url.pathname.startsWith(
                "/img/default-profile-pictures/"
            )
        );
    } catch {
        return false;
    }
}

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
                    !isKickAvatarUrl(
                        src
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
                            KICK_CHANNEL_HOSTS.has(
                                url.hostname
                            ) &&
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

function getCurrentKickActivity() {
    const hostname =
        window.location.hostname
            .toLowerCase();

    const pathParts =
        window.location.pathname
            .split("/")
            .filter(Boolean);

    let channelName = null;
    let mode = "watching";

    if (
        hostname ===
        "dashboard.kick.com"
    ) {
        if (
            pathParts[0]
                ?.toLowerCase() !==
                "moderator" ||
            !pathParts[1]
        ) {
            return null;
        }

        channelName =
            pathParts[1];

        mode =
            "moderating";
    } else if (
        KICK_CHANNEL_HOSTS.has(
            hostname
        ) &&
        pathParts[0] &&
        !KICK_NON_CHANNEL_ROUTES.has(
            pathParts[0]
                .toLowerCase()
        )
    ) {
        channelName =
            pathParts[0];
    }

    if (
        !channelName ||
        !KICK_CHANNEL_PATTERN.test(
            channelName
        )
    ) {
        return null;
    }

    return {
        channelName,
        mode
    };
}

function getCurrentActivitySnapshot() {
    const current =
        getCurrentKickActivity();

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
            "KICK_TAB_GONE"
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
            "KICK_CHANNEL",
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
                    getCurrentKickActivity();

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

function sendCurrentKickActivity(
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
            "KICK_PRESENCE_REQUEST_STATE"
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
        sendCurrentKickActivity(
            true
        );
    }
);

window.addEventListener(
    "focus",
    () => {
        sendCurrentKickActivity(
            true
        );
    }
);

window.addEventListener(
    "pageshow",
    () => {
        sendCurrentKickActivity(
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

sendCurrentKickActivity(
    true
);

// This timer only watches for Kick SPA route/channel changes.
// It is NOT the source of truth for whether a background tab is
// still alive, so Chrome throttling it cannot kill the presence.
routeCheckTimer =
    setInterval(
        () => {
            sendCurrentKickActivity(
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
            sendCurrentKickActivity(
                true
            );
        },
        HEARTBEAT_MS
    );
