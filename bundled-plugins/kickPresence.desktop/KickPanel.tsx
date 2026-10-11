import { PluginNative } from "@utils/types";
import { ApplicationAssetUtils, React } from "@webpack/common";

const Native = VencordNative.pluginHelpers.KickPresence as PluginNative<
    typeof import("./native")
>;

type KickMode = "watching" | "moderating";

interface KickActivityData {
    channel: string;
    mode: KickMode;
    avatarUrl: string | null;
    extraStreams: number;
}

export function KickPanel() {
    const [activity, setActivity] =
        React.useState<KickActivityData | null>(null);

    const [rendered, setRendered] = React.useState(false);
    const [visible, setVisible] = React.useState(false);
    const [panelAvatarUrl, setPanelAvatarUrl] =
        React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        let hideTimer: number | null = null;
        let lastKey: string | null | undefined = undefined;

        async function checkActivity() {
            try {
                const data = await Native.getLatestActivity();

                if (cancelled) return;

                const key = data
                    ? `${data.channel}:${data.mode}:${data.extraStreams}:${data.avatarUrl ?? ""}`
                    : null;

                if (key === lastKey) {
                    return;
                }

                lastKey = key;

                if (data) {
                    if (hideTimer !== null) {
                        window.clearTimeout(hideTimer);
                        hideTimer = null;
                    }

                    setActivity(data);
                    setRendered(true);

                    window.requestAnimationFrame(() => {
                        window.requestAnimationFrame(() => {
                            if (!cancelled) {
                                setVisible(true);
                            }
                        });
                    });

                    return;
                }

                setVisible(false);

                hideTimer = window.setTimeout(() => {
                    if (!cancelled) {
                        setRendered(false);
                        setActivity(null);
                    }
                }, 280);
            } catch (error) {
                console.error(
                    "[KickPresence] Failed to update local Kick panel:",
                    error
                );
            }
        }

        checkActivity();

        const interval = window.setInterval(() => {
            checkActivity();
        }, 1000);

        return () => {
            cancelled = true;

            window.clearInterval(interval);

            if (hideTimer !== null) {
                window.clearTimeout(hideTimer);
            }
        };
    }, []);

    React.useEffect(() => {
        let cancelled = false;

        async function resolvePanelAvatar() {
            const rawAvatarUrl = activity?.avatarUrl ?? null;

            if (!rawAvatarUrl) {
                setPanelAvatarUrl(null);
                return;
            }

            try {
                const resolvedAsset = (
                    await ApplicationAssetUtils.fetchAssetIds(
                        "0",
                        [rawAvatarUrl]
                    )
                )[0];

                if (cancelled) return;

                if (resolvedAsset?.startsWith("mp:")) {
                    setPanelAvatarUrl(
                        `https://images-ext-1.discordapp.net/${resolvedAsset.slice(3)}`
                    );
                    return;
                }

                if (
                    resolvedAsset?.startsWith("http://") ||
                    resolvedAsset?.startsWith("https://")
                ) {
                    setPanelAvatarUrl(resolvedAsset);
                    return;
                }

                setPanelAvatarUrl(rawAvatarUrl);
            } catch (error) {
                console.error(
                    "[KickPresence] Failed to resolve compact-panel avatar:",
                    error
                );

                if (!cancelled) {
                    setPanelAvatarUrl(rawAvatarUrl);
                }
            }
        }

        void resolvePanelAvatar();

        return () => {
            cancelled = true;
        };
    }, [activity?.avatarUrl]);

    if (!rendered || !activity) {
        return null;
    }

    const streamUrl =
        `https://kick.com/${activity.channel}`;

    function openStream() {
        VencordNative.native.openExternal(streamUrl);
    }

    return (
        <div
            style={{
                display: "grid",
                gridTemplateRows: visible ? "1fr" : "0fr",
                transition:
                    "grid-template-rows 280ms cubic-bezier(0.22, 1, 0.36, 1)",
                willChange: "grid-template-rows",
                pointerEvents: visible ? "auto" : "none"
            }}
        >
            <div
                style={{
                    minHeight: 0,
                    overflow: "hidden"
                }}
            >
                <div
                    style={{
                        margin: 0,
                        padding: "8px 10px",
                        width: "100%",
                        boxSizing: "border-box",
                        borderRadius: "8px",
                        background: "#000000",
                        color: "var(--text-normal)",
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        minWidth: 0,

                        transform: visible
                            ? "translate3d(0, 0, 0)"
                            : "translate3d(0, 14px, 0)",

                        transition:
                            "transform 280ms cubic-bezier(0.22, 1, 0.36, 1)",

                        willChange: "transform",
                        backfaceVisibility: "hidden"
                    }}
                >
                    {panelAvatarUrl ? (
                        <img
                            src={panelAvatarUrl}
                            alt={activity.channel}
                            title={`Open ${activity.channel} on Kick`}
                            onClick={openStream}
                            style={{
                                width: "42px",
                                height: "42px",
                                borderRadius: "50%",
                                objectFit: "cover",
                                flexShrink: 0,
                                cursor: "pointer"
                            }}
                        />
                    ) : (
                        <div
                            style={{
                                width: "42px",
                                height: "42px",
                                borderRadius: "50%",
                                background:
                                    "var(--background-modifier-accent)",
                                flexShrink: 0
                            }}
                        />
                    )}

                    <div
                        style={{
                            minWidth: 0,
                            flex: 1
                        }}
                    >
                        <div
                            role="link"
                            tabIndex={0}
                            title={`Open ${activity.channel} on Kick`}
                            onClick={openStream}
                            onKeyDown={event => {
                                if (
                                    event.key === "Enter" ||
                                    event.key === " "
                                ) {
                                    event.preventDefault();
                                    openStream();
                                }
                            }}
                            style={{
                                fontWeight: 600,
                                fontSize: "14px",
                                color: "#ffffff",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                cursor: "pointer"
                            }}
                        >
                            {activity.channel}
                        </div>

                        <div
                            style={{
                                marginTop: "2px",
                                fontSize: "12px",
                                color: "#b5bac1",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis"
                            }}
                        >
                            Watching Kick
                        </div>

                        {activity.mode === "moderating" && (
                            <div
                                style={{
                                    marginTop: "2px",
                                    fontSize: "12px",
                                    color: "#b5bac1",
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis"
                                }}
                            >
                                Modding for {activity.channel}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
