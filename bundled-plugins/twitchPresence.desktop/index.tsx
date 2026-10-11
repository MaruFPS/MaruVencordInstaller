import { plugins } from "@api/PluginManager";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { PluginNative } from "@utils/types";
import { Activity } from "@vencord/discord-types";
import {
    ActivityStatusDisplayType,
    ActivityType
} from "@vencord/discord-types/enums";
import {
    ApplicationAssetUtils,
    FluxDispatcher
} from "@webpack/common";

import { TwitchPanel } from "./TwitchPanel";

const Native = VencordNative.pluginHelpers.TwitchPresence as PluginNative<
    typeof import("./native")
>;

type TwitchMode = "watching" | "moderating";

interface TwitchActivityData {
    channel: string;
    mode: TwitchMode;
    avatarUrl: string | null;
    extraStreams: number;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastActivityKey: string | null | undefined = undefined;

let originalSpotifyPanelWrapper: any = null;

function installPanelWrapper() {
    const spotifyPlugin = plugins.SpotifyControls as any;

    if (!spotifyPlugin?.PanelWrapper) {
        console.error(
            "[TwitchPresence] SpotifyControls PanelWrapper was not found."
        );
        return;
    }

    if (originalSpotifyPanelWrapper) {
        return;
    }

    originalSpotifyPanelWrapper = spotifyPlugin.PanelWrapper;

    spotifyPlugin.PanelWrapper = function (props: any) {
        return (
            <>
                <ErrorBoundary
                    fallback={() => (
                        <div style={{ padding: "8px" }}>
                            Failed to render TwitchPresence
                        </div>
                    )}
                >
                    <TwitchPanel />
                </ErrorBoundary>

                {originalSpotifyPanelWrapper(props)}
            </>
        );
    };
}

function uninstallPanelWrapper() {
    if (!originalSpotifyPanelWrapper) {
        return;
    }

    const spotifyPlugin = plugins.SpotifyControls as any;

    spotifyPlugin.PanelWrapper = originalSpotifyPanelWrapper;
    originalSpotifyPanelWrapper = null;
}

async function getApplicationAsset(
    url: string
): Promise<string | undefined> {
    try {
        return (
            await ApplicationAssetUtils.fetchAssetIds(
                "0",
                [url]
            )
        )[0];
    } catch (error) {
        console.error(
            "[TwitchPresence] Failed to resolve streamer avatar:",
            error
        );

        return undefined;
    }
}

async function setActivity(data: TwitchActivityData | null) {
    if (!data) {
        FluxDispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity: null,
            socketId: "TwitchPresence"
        });

        return;
    }

    const streamUrl = `https://www.twitch.tv/${data.channel}`;

    const resolvedAvatar = data.avatarUrl
        ? await getApplicationAsset(data.avatarUrl)
        : undefined;

    const activity: Activity = {
        application_id: "0",
        name: "Twitch",

        details: data.channel,
        details_url: streamUrl,

        status_display_type: ActivityStatusDisplayType.DETAILS,

        ...(data.mode === "moderating"
            ? {
                state: `Modding for ${data.channel}`
            }
            : data.extraStreams > 0
                ? {
                    state: `Watching +${data.extraStreams} ${
                        data.extraStreams === 1 ? "stream" : "streams"
                    }`
                }
                : {}),

        ...(resolvedAvatar
            ? {
                assets: {
                    large_image: resolvedAvatar,
                    large_text: data.channel,
                    large_url: streamUrl
                }
            }
            : {}),

        type: ActivityType.WATCHING,
        flags: 1 << 0
    };

    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity,
        socketId: "TwitchPresence"
    });
}

async function checkLatestActivity() {
    try {
        const data = await Native.getLatestActivity();

        const activityKey = data
            ? `${data.channel}:${data.mode}:${data.extraStreams}:${data.avatarUrl ?? ""}`
            : null;

        if (activityKey !== lastActivityKey) {
            lastActivityKey = activityKey;

            console.log(
                "[TwitchPresence] Current Twitch activity:",
                data
            );

            await setActivity(data);
        }
    } catch (error) {
        console.error(
            "[TwitchPresence] Failed to read Twitch activity:",
            error
        );
    }
}

export default definePlugin({
    name: "TwitchPresence",
    description: "Shows the Twitch stream you're watching as Discord Rich Presence.",
    authors: [{ name: "Maru", id: 0n }],

    dependencies: ["SpotifyControls"],

    async start() {
        console.log("[TwitchPresence] Plugin started.");

        installPanelWrapper();

        try {
            await Native.startBridge();

            console.log(
                "[TwitchPresence] Local bridge started on 127.0.0.1:9864."
            );

            await checkLatestActivity();

            pollTimer = setInterval(() => {
                checkLatestActivity();
            }, 1000);
        } catch (error) {
            console.error(
                "[TwitchPresence] Failed to start local bridge:",
                error
            );
        }
    },

    stop() {
        console.log("[TwitchPresence] Plugin stopped.");

        uninstallPanelWrapper();

        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }

        lastActivityKey = undefined;

        void setActivity(null);

        Native.stopBridge().catch(error => {
            console.error(
                "[TwitchPresence] Failed to stop local bridge:",
                error
            );
        });
    }
});