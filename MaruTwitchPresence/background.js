const twitchTabs = new Map();

const RECONCILE_ALARM_NAME =
    "twitch-presence-reconcile";

let publishQueue = Promise.resolve();
let reconcilePromise = null;
let reconcileRequestedWhileRunning = false;

function normalizeActivityPayload(data) {
    const channel =
        typeof data?.channel === "string"
            ? data.channel.trim()
            : "";

    const mode = data?.mode;

    if (
        !/^[a-zA-Z0-9_]{1,25}$/.test(channel) ||
        (mode !== "watching" && mode !== "moderating")
    ) {
        return null;
    }

    return {
        channel,
        mode,
        avatarUrl:
            typeof data?.avatarUrl === "string" &&
            data.avatarUrl.length > 0
                ? data.avatarUrl
                : null
    };
}

function upsertTrackedTab(tabId, activity) {
    const existing =
        twitchTabs.get(tabId);

    const sameChannel =
        existing?.channel?.toLowerCase() ===
        activity.channel.toLowerCase();

    twitchTabs.set(tabId, {
        tabId,
        channel:
            activity.channel,
        mode:
            activity.mode,

        // Keep a previously discovered avatar only while this
        // exact tab is still showing the same Twitch channel.
        avatarUrl:
            activity.avatarUrl ||
            (sameChannel
                ? existing?.avatarUrl
                : null) ||
            null,

        // Chrome tab IDs are stable for a tab's lifetime and
        // normally increase as tabs are created. Using the tab
        // ID as the fallback order keeps the same "oldest stream
        // is primary" behavior even if the MV3 service worker
        // is suspended and later reconstructed.
        order:
            existing?.order ??
            tabId
    });
}

async function publishPrimaryToVencord(
    reason = "state-change"
) {
    const streams =
        [...twitchTabs.values()]
            .sort(
                (a, b) =>
                    a.order - b.order
            );

    if (streams.length === 0) {
        try {
            const response =
                await fetch(
                    "http://127.0.0.1:9864/activity",
                    {
                        method:
                            "DELETE"
                    }
                );

            if (!response.ok) {
                throw new Error(
                    `Bridge returned HTTP ${response.status}`
                );
            }

            console.log(
                "Cleared Twitch presence:",
                reason
            );
        } catch (error) {
            console.debug(
                "Twitch presence bridge is not available for clear:",
                error
            );
        }

        return;
    }

    const primary =
        streams[0];

    const extraStreams =
        Math.max(
            0,
            streams.length - 1
        );

    try {
        const response =
            await fetch(
                "http://127.0.0.1:9864/activity",
                {
                    method:
                        "POST",
                    headers: {
                        "Content-Type":
                            "application/json"
                    },
                    body:
                        JSON.stringify({
                            channel:
                                primary.channel,
                            mode:
                                primary.mode,
                            avatarUrl:
                                primary.avatarUrl,
                            extraStreams
                        })
                }
            );

        if (!response.ok) {
            throw new Error(
                `Bridge returned HTTP ${response.status}`
            );
        }

        console.log(
            "Published Twitch presence:",
            {
                reason,
                channel:
                    primary.channel,
                mode:
                    primary.mode,
                avatarUrl:
                    primary.avatarUrl,
                extraStreams
            }
        );
    } catch (error) {
        console.debug(
            "Twitch presence bridge is not available yet:",
            error
        );
    }
}

function queuePublish(
    reason
) {
    publishQueue =
        publishQueue
            .catch(() => {})
            .then(
                () =>
                    publishPrimaryToVencord(
                        reason
                    )
            );

    return publishQueue;
}

function getActivityFromTabUrl(url) {
    if (typeof url !== "string") {
        return null;
    }

    try {
        const parsed =
            new URL(url);

        if (
            parsed.protocol !== "https:" ||
            parsed.hostname !== "www.twitch.tv"
        ) {
            return null;
        }

        const pathParts =
            parsed.pathname
                .split("/")
                .filter(Boolean);

        if (
            pathParts[0] === "moderator" &&
            pathParts[1]
        ) {
            const channel =
                pathParts[1];

            if (
                /^[a-zA-Z0-9_]{1,25}$/.test(
                    channel
                )
            ) {
                return {
                    channel,
                    mode:
                        "moderating",
                    avatarUrl:
                        null
                };
            }

            return null;
        }

        const channel =
            pathParts[0] ?? "";

        if (
            !/^[a-zA-Z0-9_]{1,25}$/.test(
                channel
            )
        ) {
            return null;
        }

        return {
            channel,
            mode:
                "watching",
            avatarUrl:
                null
        };
    } catch {
        return null;
    }
}

async function requestTabActivity(
    tabId
) {
    try {
        return await chrome.tabs.sendMessage(
            tabId,
            {
                type:
                    "TWITCH_PRESENCE_REQUEST_STATE"
            }
        );
    } catch {
        // The tab may still be loading or may predate the
        // extension being loaded. Do not destroy known state
        // solely because a content-script request failed.
        return undefined;
    }
}

async function reconcileTwitchTabs(
    reason = "periodic-reconcile"
) {
    if (reconcilePromise) {
        // A lifecycle event may arrive while an earlier reconcile is
        // still querying Chrome. Remember that we owe Chrome one more
        // pass after the current one finishes so a close/navigation
        // cannot be lost to a race.
        reconcileRequestedWhileRunning =
            true;

        return reconcilePromise;
    }

    reconcilePromise =
        (async () => {
            let passReason =
                reason;

            do {
                reconcileRequestedWhileRunning =
                    false;

                const tabs =
                    await chrome.tabs.query({
                        url: [
                            "https://www.twitch.tv/*"
                        ]
                    });

                const currentTwitchTabIds =
                    new Set();

                for (const tab of tabs) {
                    const tabId =
                        tab.id;

                    if (
                        typeof tabId !==
                        "number"
                    ) {
                        continue;
                    }

                    currentTwitchTabIds.add(
                        tabId
                    );

                    const response =
                        await requestTabActivity(
                            tabId
                        );

                    if (
                        response ===
                        undefined
                    ) {
                        // A frozen/discarded/background tab may not answer
                        // a content-script message. The tab URL is still
                        // authoritative enough to preserve basic presence.
                        const urlActivity =
                            getActivityFromTabUrl(
                                tab.url
                            );

                        if (urlActivity) {
                            upsertTrackedTab(
                                tabId,
                                urlActivity
                            );
                        }

                        continue;
                    }

                    if (
                        response?.active !==
                        true
                    ) {
                        twitchTabs.delete(
                            tabId
                        );

                        continue;
                    }

                    const activity =
                        normalizeActivityPayload(
                            response
                        );

                    if (!activity) {
                        twitchTabs.delete(
                            tabId
                        );

                        continue;
                    }

                    upsertTrackedTab(
                        tabId,
                        activity
                    );
                }

                // Anything we still remember that Chrome no longer
                // reports as a Twitch tab is definitely gone or has
                // navigated away from Twitch.
                for (
                    const tabId of
                    [...twitchTabs.keys()]
                ) {
                    if (
                        !currentTwitchTabIds.has(
                            tabId
                        )
                    ) {
                        twitchTabs.delete(
                            tabId
                        );
                    }
                }

                await queuePublish(
                    passReason
                );

                passReason =
                    "queued-lifecycle-reconcile";
            } while (
                reconcileRequestedWhileRunning
            );
        })()
            .finally(() => {
                reconcilePromise = null;
            });

    return reconcilePromise;
}

async function ensureReconcileAlarm() {
    try {
        const existing =
            await chrome.alarms.get(
                RECONCILE_ALARM_NAME
            );

        if (existing) {
            return;
        }

        await chrome.alarms.create(
            RECONCILE_ALARM_NAME,
            {
                periodInMinutes:
                    1
            }
        );
    } catch (error) {
        console.error(
            "Failed to create Twitch presence reconcile alarm:",
            error
        );
    }
}

chrome.runtime.onMessage.addListener(
    (
        message,
        sender
    ) => {
        const tabId =
            sender.tab?.id;

        if (
            typeof tabId !==
            "number"
        ) {
            return;
        }

        if (
            message?.type ===
            "TWITCH_CHANNEL"
        ) {
            const activity =
                normalizeActivityPayload(
                    message
                );

            if (!activity) {
                return;
            }

            upsertTrackedTab(
                tabId,
                activity
            );

            void queuePublish(
                "content-script-update"
            );

            return;
        }

        if (
            message?.type ===
            "TWITCH_TAB_GONE"
        ) {
            twitchTabs.delete(
                tabId
            );

            // Never trust the in-memory Map alone here. MV3 can wake a
            // brand-new service worker for this event with an empty Map.
            void reconcileTwitchTabs(
                "content-script-pagehide"
            );
        }
    }
);

chrome.tabs.onRemoved.addListener(
    tabId => {
        twitchTabs.delete(
            tabId
        );

        // Always reconcile after ANY tab closes. A Manifest V3 service
        // worker can be suspended between events, so its in-memory Map
        // may be empty even when the closed tab was our Twitch tab.
        void reconcileTwitchTabs(
            "tab-closed"
        );
    }
);

chrome.tabs.onUpdated.addListener(
    (
        _tabId,
        changeInfo
    ) => {
        if (
            typeof changeInfo.url !==
            "string"
        ) {
            return;
        }

        // Reconcile on top-level navigation as well. This catches a
        // Twitch tab navigating away even if the worker lost its RAM
        // state before the navigation event arrived.
        void reconcileTwitchTabs(
            "tab-url-changed"
        );
    }
);

chrome.alarms.onAlarm.addListener(
    alarm => {
        if (
            alarm.name !==
            RECONCILE_ALARM_NAME
        ) {
            return;
        }

        void reconcileTwitchTabs(
            "alarm"
        );
    }
);

chrome.runtime.onInstalled.addListener(
    () => {
        void ensureReconcileAlarm();
        void reconcileTwitchTabs(
            "extension-installed-or-updated"
        );
    }
);

chrome.runtime.onStartup.addListener(
    () => {
        void ensureReconcileAlarm();
        void reconcileTwitchTabs(
            "browser-startup"
        );
    }
);

// MV3 service workers may be suspended at any time. Every time
// this worker is started again, make sure the alarm exists and
// reconstruct current Twitch tabs instead of trusting old RAM.
void ensureReconcileAlarm();
void reconcileTwitchTabs(
    "service-worker-start"
);
