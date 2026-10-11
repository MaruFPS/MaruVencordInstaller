import * as DataStore from "@api/DataStore";
import { PluginNative } from "@utils/types";
import { React } from "@webpack/common";
import { io, Socket } from "socket.io-client";

const Native = VencordNative.pluginHelpers.YTMDesktopControls as PluginNative<typeof import("./native")>;

const API_BASE = "http://127.0.0.1:9863/api/v1";
const REALTIME_URL = "http://127.0.0.1:9863/api/v1/realtime";
const TOKEN_KEY = "YTMDesktopControls_token";

interface Thumbnail {
    url: string;
    width: number;
    height: number;
}

interface YTMState {
    player?: {
        trackState?: number;
        videoProgress?: number;
        volume?: number;

        queue?: {
            repeatMode?: -1 | 0 | 1 | 2;
        } | null;
    };

    video?: {
        id?: string;
        channelId?: string;
        title?: string;
        author?: string;
        album?: string;
        likeStatus?: -1 | 0 | 1 | 2 | null;
        durationSeconds?: number;
        thumbnails?: Thumbnail[];
    };
}

type PlaybackCommand =
    | "previous"
    | "playPause"
    | "next"
    | "shuffle"
    | "repeatMode"
    | "toggleLike"
    | "toggleDislike"
    | "seekTo";

async function sendCommand(
    command: PlaybackCommand,
    data?: number
): Promise<boolean> {
    try {
        const token = await DataStore.get<string>(TOKEN_KEY);

        if (!token) {
            throw new Error("No YTMDesktop authorization token found.");
        }

        const body: {
            command: PlaybackCommand;
            data?: number;
        } = {
            command
        };

        if (data !== undefined) {
            body.data = data;
        }

        const response = await fetch(`${API_BASE}/command`, {
            method: "POST",
            headers: {
                Authorization: token,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw new Error(
                `Command "${command}" failed: HTTP ${response.status}`
            );
        }

        return true;
    } catch (error) {
        console.error(
            `[YTMDesktopControls] Failed to send "${command}" command:`,
            error
        );

        return false;
    }
}

function ShuffleIcon() {
    return (
        <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M16 3h5v5" />
            <path d="M4 20 21 3" />
            <path d="M21 16v5h-5" />
            <path d="m15 15 6 6" />
            <path d="m4 4 5 5" />
        </svg>
    );
}

function PreviousIcon() {
    return (
        <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <path d="M6 5h2v14H6z" />
            <path d="m18 6-8 6 8 6z" />
        </svg>
    );
}

function PlayIcon() {
    return (
        <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <path d="M8 5v14l11-7z" />
        </svg>
    );
}

function PauseIcon() {
    return (
        <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <path d="M7 5h4v14H7z" />
            <path d="M13 5h4v14h-4z" />
        </svg>
    );
}

function NextIcon() {
    return (
        <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <path d="M16 5h2v14h-2z" />
            <path d="m6 6 8 6-8 6z" />
        </svg>
    );
}

function RepeatIcon({
    mode
}: {
    mode: number;
}) {
    return (
        <div
            style={{
                position: "relative",
                width: "18px",
                height: "18px"
            }}
        >
            <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="m17 1 4 4-4 4" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <path d="m7 23-4-4 4-4" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>

            {mode === 2 && (
                <span
                    style={{
                        position: "absolute",
                        fontSize: "8px",
                        fontWeight: 700,
                        lineHeight: 1,
                        left: "7px",
                        top: "5px"
                    }}
                >
                    1
                </span>
            )}
        </div>
    );
}

function LikeIcon({
    active
}: {
    active: boolean;
}) {
    return (
        <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill={active ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M7 10v12" />
            <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z" />
        </svg>
    );
}

function DislikeIcon({
    active
}: {
    active: boolean;
}) {
    return (
        <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill={active ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M17 14V2" />
            <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z" />
        </svg>
    );
}

function formatTime(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "0:00";
    }

    const wholeSeconds = Math.floor(seconds);
    const minutes = Math.floor(wholeSeconds / 60);
    const remainingSeconds = wholeSeconds % 60;

    return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function Player() {
    const [state, setState] = React.useState<YTMState | null>(null);
    const [artworkData, setArtworkData] = React.useState<string | null>(null);
    const [shuffleActive, setShuffleActive] = React.useState(false);
    const [seekPreview, setSeekPreview] = React.useState<number | null>(null);
    const [connected, setConnected] = React.useState(false);
    const [rendered, setRendered] = React.useState(false);
    const [titleHovered, setTitleHovered] = React.useState(false);
    const [artistHovered, setArtistHovered] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;
        let socket: Socket | null = null;
        let hideTimer: number | null = null;
        let showTimer: number | null = null;

        async function fetchInitialState(token: string) {
            try {
                const response = await fetch(`${API_BASE}/state`, {
                    headers: {
                        Authorization: token
                    }
                });

                if (!response.ok) return;

                const initialState = await response.json();

                if (!cancelled) {
                    setState(initialState);
                }
            } catch {
                // YTMDesktop may still be starting up. Realtime will retry.
            }
        }

        async function connect() {
            const token = await DataStore.get<string>(TOKEN_KEY);

            if (!token || cancelled) return;

            socket = io(REALTIME_URL, {
                transports: ["websocket"],
                auth: {
                    token
                },
                reconnection: true,
                reconnectionDelay: 750,
                reconnectionDelayMax: 3000,
                timeout: 2000
            });

            socket.on("connect", () => {
                if (cancelled) return;

                if (hideTimer !== null) {
                    window.clearTimeout(hideTimer);
                    hideTimer = null;
                }

                setRendered(true);

                // Paint the collapsed grid state first, then animate it open.
                showTimer = window.setTimeout(() => {
                    window.requestAnimationFrame(() => {
                        window.requestAnimationFrame(() => {
                            if (!cancelled) {
                                setConnected(true);
                            }
                        });
                    });
                }, 16);

                fetchInitialState(token);

                console.log(
                    "[YTMDesktopControls] Realtime connection established."
                );
            });

            socket.on("state-update", (newState: YTMState) => {
                if (!cancelled) {
                    setState(newState);
                }
            });

            socket.on("disconnect", () => {
                if (cancelled) return;

                setConnected(false);
                setShuffleActive(false);
                setSeekPreview(null);

                // Keep the player mounted long enough to finish the
                // slide-down animation, then remove it from the layout.
                hideTimer = window.setTimeout(() => {
                    if (!cancelled) {
                        setRendered(false);
                        setState(null);
                        setArtworkData(null);
                    }
                }, 300);
            });

            socket.on("connect_error", async () => {
                if (cancelled) return;

                setConnected(false);

                try {
                    const latestToken =
                        await DataStore.get<string>(TOKEN_KEY);

                    if (
                        cancelled ||
                        !latestToken ||
                        latestToken === token
                    ) {
                        return;
                    }

                    console.log(
                        "[YTMDesktopControls] Companion token changed. Reconnecting realtime player with fresh authorization."
                    );

                    socket?.disconnect();
                    socket = null;

                    await connect();
                } catch (error) {
                    console.error(
                        "[YTMDesktopControls] Failed to refresh realtime connection after token change:",
                        error
                    );
                }
            });
        }

        connect().catch(error => {
            console.error(
                "[YTMDesktopControls] Failed to initialize realtime connection:",
                error
            );
        });

        return () => {
            cancelled = true;

            if (hideTimer !== null) {
                window.clearTimeout(hideTimer);
            }

            if (showTimer !== null) {
                window.clearTimeout(showTimer);
            }

            socket?.disconnect();
        };
    }, []);

    const video = state?.video;

    const artworkUrl =
        video?.thumbnails?.[video.thumbnails.length - 1]?.url;

    const isPlaying = state?.player?.trackState === 1;

    const repeatMode =
        state?.player?.queue?.repeatMode ?? 0;

    const songUrl = video?.id
        ? `https://music.youtube.com/watch?v=${encodeURIComponent(video.id)}`
        : null;

    const artistUrl = video?.channelId
        ? `https://music.youtube.com/channel/${encodeURIComponent(video.channelId)}`
        : null;

    function openExternal(url: string | null) {
        if (!url) return;

        VencordNative.native.openExternal(url);
    }

    React.useEffect(() => {
        let cancelled = false;

        async function updateArtwork() {
            if (!artworkUrl) {
                setArtworkData(null);
                return;
            }

            try {
                const dataUrl = await Native.fetchArtwork(artworkUrl);

                if (!cancelled) {
                    setArtworkData(dataUrl);
                }
            } catch (error) {
                console.error(
                    "[YTMDesktopControls] Failed to fetch artwork:",
                    error
                );

                if (!cancelled) {
                    setArtworkData(null);
                }
            }
        }

        updateArtwork();

        return () => {
            cancelled = true;
        };
    }, [artworkUrl]);

    function cycleRepeatMode() {
        let nextMode: 0 | 1 | 2;

        if (repeatMode === 0 || repeatMode === -1) {
            nextMode = 1;
        } else if (repeatMode === 1) {
            nextMode = 2;
        } else {
            nextMode = 0;
        }

        sendCommand("repeatMode", nextMode);
    }

    const buttonStyle: React.CSSProperties = {
        width: "30px",
        height: "30px",
        padding: 0,
        border: "none",
        borderRadius: "4px",
        background: "transparent",
        color: "#dbdee1",
        lineHeight: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer"
    };

    const repeatActive =
        repeatMode === 1 || repeatMode === 2;

    const likeStatus = video?.likeStatus ?? -1;
    const liked = likeStatus === 2;
    const disliked = likeStatus === 0;

    const durationSeconds = video?.durationSeconds ?? 0;
    const liveProgressSeconds = state?.player?.videoProgress ?? 0;
    const displayedProgressSeconds = seekPreview ?? liveProgressSeconds;

    const progressPercent =
        durationSeconds > 0
            ? Math.min(
                100,
                Math.max(0, (displayedProgressSeconds / durationSeconds) * 100)
            )
            : 0;

    function getSeekSeconds(event: React.PointerEvent<HTMLDivElement>) {
        if (durationSeconds <= 0) return 0;

        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = Math.min(
            1,
            Math.max(0, (event.clientX - rect.left) / rect.width)
        );

        return ratio * durationSeconds;
    }

    function beginSeek(event: React.PointerEvent<HTMLDivElement>) {
        if (durationSeconds <= 0) return;

        event.currentTarget.setPointerCapture(event.pointerId);
        setSeekPreview(getSeekSeconds(event));
    }

    function moveSeek(event: React.PointerEvent<HTMLDivElement>) {
        if (
            durationSeconds <= 0 ||
            !event.currentTarget.hasPointerCapture(event.pointerId)
        ) {
            return;
        }

        setSeekPreview(getSeekSeconds(event));
    }

    async function endSeek(event: React.PointerEvent<HTMLDivElement>) {
        if (durationSeconds <= 0) return;

        const targetSeconds = getSeekSeconds(event);

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }

        setSeekPreview(targetSeconds);

        const success = await sendCommand("seekTo", targetSeconds);

        if (!success) {
            setSeekPreview(null);
            return;
        }

        window.setTimeout(() => setSeekPreview(null), 150);
    }

    if (!rendered) {
        return null;
    }

    return (
        <div
            style={{
                display: "grid",
                gridTemplateRows: connected ? "1fr" : "0fr",
                transition:
                    "grid-template-rows 280ms cubic-bezier(0.22, 1, 0.36, 1)",
                willChange: "grid-template-rows",
                pointerEvents: connected ? "auto" : "none"
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
                    flexDirection: "column",
                    minWidth: 0,
                    transform: connected
                        ? "translate3d(0, 0, 0)"
                        : "translate3d(0, 14px, 0)",
                    transition:
                        "transform 280ms cubic-bezier(0.22, 1, 0.36, 1)",
                    willChange: "transform",
                    backfaceVisibility: "hidden"
                }}
            >
            <div
                style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    minWidth: 0
                }}
            >
                {artworkData ? (
                    <img
                        src={artworkData}
                        alt=""
                        style={{
                            width: "42px",
                            height: "42px",
                            borderRadius: "4px",
                            objectFit: "cover",
                            flexShrink: 0
                        }}
                    />
                ) : (
                    <div
                        style={{
                            width: "42px",
                            height: "42px",
                            borderRadius: "4px",
                            background: "var(--background-modifier-accent)",
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
                        role={songUrl ? "link" : undefined}
                        tabIndex={songUrl ? 0 : undefined}
                        title={songUrl ? "Open song in YouTube Music" : undefined}
                        onClick={() => openExternal(songUrl)}
                        onKeyDown={event => {
                            if (
                                songUrl &&
                                (event.key === "Enter" || event.key === " ")
                            ) {
                                event.preventDefault();
                                openExternal(songUrl);
                            }
                        }}
                        onMouseEnter={() => setTitleHovered(true)}
                        onMouseLeave={() => setTitleHovered(false)}
                        style={{
                            fontWeight: 600,
                            fontSize: "14px",
                            color: "#ffffff",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            cursor: songUrl ? "pointer" : "default",
                            textDecoration:
                                songUrl && titleHovered
                                    ? "underline"
                                    : "none"
                        }}
                    >
                        {video?.title ?? "YouTube Music"}
                    </div>

                    <div
                        role={artistUrl ? "link" : undefined}
                        tabIndex={artistUrl ? 0 : undefined}
                        title={artistUrl ? "Open artist in YouTube Music" : undefined}
                        onClick={() => openExternal(artistUrl)}
                        onKeyDown={event => {
                            if (
                                artistUrl &&
                                (event.key === "Enter" || event.key === " ")
                            ) {
                                event.preventDefault();
                                openExternal(artistUrl);
                            }
                        }}
                        onMouseEnter={() => setArtistHovered(true)}
                        onMouseLeave={() => setArtistHovered(false)}
                        style={{
                            marginTop: "2px",
                            fontSize: "12px",
                            color: "#b5bac1",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            cursor: artistUrl ? "pointer" : "default",
                            textDecoration:
                                artistUrl && artistHovered
                                    ? "underline"
                                    : "none"
                        }}
                    >
                        {video?.author ?? "Waiting for YTMDesktop..."}
                    </div>
                </div>
            </div>

            <div
                style={{
                    marginTop: "8px",
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px"
                }}
            >
                <span
                    style={{
                        flexShrink: 0,
                        color: "#b5bac1",
                        fontSize: "11px",
                        lineHeight: 1,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        marginRight: "2px"
                    }}
                >
                    {formatTime(displayedProgressSeconds)}
                </span>

                <div
                    role="slider"
                    aria-label="Playback position"
                    aria-valuemin={0}
                    aria-valuemax={durationSeconds}
                    aria-valuenow={displayedProgressSeconds}
                    tabIndex={0}
                    onPointerDown={beginSeek}
                    onPointerMove={moveSeek}
                    onPointerUp={endSeek}
                    style={{
                        position: "relative",
                        flex: 1,
                        height: "12px",
                        display: "flex",
                        alignItems: "center",
                        cursor: durationSeconds > 0 ? "pointer" : "default",
                        touchAction: "none"
                    }}
                >
                    <div
                        style={{
                            position: "absolute",
                            left: 0,
                            right: 0,
                            height: "4px",
                            borderRadius: "999px",
                            background: "#4e5058",
                            overflow: "hidden"
                        }}
                    >
                        <div
                            style={{
                                width: `${progressPercent}%`,
                                height: "100%",
                                borderRadius: "999px",
                                background: "var(--brand-500)"
                            }}
                        />
                    </div>

                    <div
                        style={{
                            position: "absolute",
                            left: `${progressPercent}%`,
                            width: "10px",
                            height: "10px",
                            borderRadius: "50%",
                            background: "#ffffff",
                            transform: "translateX(-50%)",
                            pointerEvents: "none"
                        }}
                    />
                </div>

                <span
                    style={{
                        flexShrink: 0,
                        color: "#b5bac1",
                        fontSize: "11px",
                        lineHeight: 1,
                        textAlign: "left",
                        fontVariantNumeric: "tabular-nums"
                    }}
                >
                    {formatTime(durationSeconds)}
                </span>
            </div>

            <div
                style={{
                    marginTop: "6px",
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "5px"
                }}
            >
                <button
                    type="button"
                    aria-label={disliked ? "Remove dislike" : "Dislike"}
                    title={disliked ? "Remove Dislike" : "Dislike"}
                    style={{
                        ...buttonStyle,
                        color: disliked ? "#ffffff" : "#dbdee1"
                    }}
                    onClick={() => sendCommand("toggleDislike")}
                >
                    <DislikeIcon active={disliked} />
                </button>

                <button
                    type="button"
                    aria-label={shuffleActive ? "Shuffle on" : "Shuffle off"}
                    title={shuffleActive ? "Shuffle On" : "Shuffle Off"}
                    style={{
                        ...buttonStyle,
                        color: shuffleActive
                            ? "#23a55a"
                            : "#dbdee1"
                    }}
                    onClick={async () => {
                        const success = await sendCommand("shuffle");

                        if (success) {
                            setShuffleActive(current => !current);
                        }
                    }}
                >
                    <ShuffleIcon />
                </button>

                <button
                    type="button"
                    aria-label="Previous track"
                    title="Previous"
                    style={buttonStyle}
                    onClick={() => sendCommand("previous")}
                >
                    <PreviousIcon />
                </button>

                <button
                    type="button"
                    aria-label={isPlaying ? "Pause" : "Play"}
                    title={isPlaying ? "Pause" : "Play"}
                    style={{
                        ...buttonStyle,
                        color: "#ffffff"
                    }}
                    onClick={() => sendCommand("playPause")}
                >
                    {isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>

                <button
                    type="button"
                    aria-label="Next track"
                    title="Next"
                    style={buttonStyle}
                    onClick={() => sendCommand("next")}
                >
                    <NextIcon />
                </button>

                <button
                    type="button"
                    aria-label={
                        repeatMode === 2
                            ? "Repeat one"
                            : repeatMode === 1
                                ? "Repeat all"
                                : "Repeat off"
                    }
                    title={
                        repeatMode === 2
                            ? "Repeat One"
                            : repeatMode === 1
                                ? "Repeat All"
                                : "Repeat Off"
                    }
                    style={{
                        ...buttonStyle,
                        color: repeatActive
                            ? "#23a55a"
                            : "#dbdee1"
                    }}
                    onClick={cycleRepeatMode}
                >
                    <RepeatIcon mode={repeatMode} />
                </button>

                <button
                    type="button"
                    aria-label={liked ? "Remove like" : "Like"}
                    title={liked ? "Remove Like" : "Like"}
                    style={{
                        ...buttonStyle,
                        color: liked ? "#ffffff" : "#dbdee1"
                    }}
                    onClick={() => sendCommand("toggleLike")}
                >
                    <LikeIcon active={liked} />
                </button>
            </div>
        </div>
        </div>
        </div>
    );
}