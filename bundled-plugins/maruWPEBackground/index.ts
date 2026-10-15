import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { showToast } from "@webpack/common";


const settings = definePluginSettings({
    presetName: {
        type: OptionType.STRING,
        description: "Wallpaper Engine preset name used for Discord.",
        default: "MaruDiscordPreset"
    },

    monitorSource: {
        type: OptionType.SELECT,
        description: "Which Wallpaper Engine monitor Discord should follow.",
        options: [
    {
        label: "Follow Discord",
        value: "followDiscord",
        default: true
    },
    {
        label: "Monitor 1",
        value: "Monitor1"
    },
    {
        label: "Monitor 0",
        value: "Monitor0"
    }
]
    },

    sizingMode: {
        type: OptionType.SELECT,
        description: "How the Wallpaper Engine renderer should size itself.",
        options: [
            {
                label: "Match Discord",
                value: "matchDiscord",
                default: true
            },
            {
                label: "Fixed 1920x1080",
                value: "fixed1080"
            },
            {
                label: "Preserve 16:9",
                value: "preserve16x9"
            }
        ]
    },

    autoFollowWallpaper: {
        type: OptionType.BOOLEAN,
        description: "Automatically follow wallpaper changes in Wallpaper Engine.",
        default: true
    }
});


const Native =
    VencordNative.pluginHelpers.MaruWPEBackground as PluginNative<
        typeof import("./native")
    >;


type SizingMode =
    | "matchDiscord"
    | "fixed1080"
    | "preserve16x9";


let stream: MediaStream | null = null;
let background: HTMLVideoElement | null = null;
let style: HTMLStyleElement | null = null;

let retryTimer: number | null = null;
let wallpaperWatchTimer: number | null = null;
let recoveryTimer: number | null = null;
let resizeTimer: number | null = null;

let running = false;
let wallpaperReloading = false;
let recovering = false;

let lastWallpaperFile: string | null = null;
let wallpaperBaselineInitialized = false;
let pendingWallpaperFile: string | null = null;
let wallpaperChangePending = false;
let lastMonitorKey: string | null = null;
let lastPresetName: string | null = null;
let lastSizingMode: SizingMode | null = null;

const SOURCE_NAME =
    "MaruDiscordCapture";

const DEFAULT_PRESET_NAME =
    "MaruDiscordPreset";
let lastFailureToast =
    "";

let lastFailureToastAt =
    0;


function showFailureToast(
    message: string
) {
    const now =
        Date.now();

    if (
        message === lastFailureToast &&
        now - lastFailureToastAt < 5000
    ) {
        return;
    }

    lastFailureToast =
        message;

    lastFailureToastAt =
        now;

    showToast({ text: message, variant: "critical", position: "bottom" });
}



async function getMonitorKey() {
    const selected =
        settings.store.monitorSource;

    if (
        selected === "Monitor0" ||
        selected === "Monitor1"
    ) {
        return selected;
    }

    const display =
        await Native.getDiscordDisplayInfo();

    /*
     * Your confirmed mapping:
     * primary 2560Ã—1440 display  -> WE Monitor0
     * secondary 1920Ã—1080       -> WE Monitor1
     */
    return display.primary
        ? "Monitor0"
        : "Monitor1";
}


function getPresetName() {
    const value =
        settings.store.presetName;

    if (
        typeof value !== "string" ||
        !value.trim()
    ) {
        return DEFAULT_PRESET_NAME;
    }

    return value.trim();
}


function getSizingMode(): SizingMode {
    const value =
        settings.store.sizingMode;

    if (value === "fixed1080")
        return "fixed1080";

    if (value === "preserve16x9")
        return "preserve16x9";

    return "matchDiscord";
}


function getTargetRenderSize(
    mode = getSizingMode()
) {
    const discordWidth =
        Math.max(
            320,
            Math.round(window.innerWidth)
        );

    const discordHeight =
        Math.max(
            180,
            Math.round(window.innerHeight)
        );

    if (mode === "fixed1080") {
        return {
            width: 1920,
            height: 1080
        };
    }

    if (mode === "preserve16x9") {
        const aspect =
            16 / 9;

        let width: number;
        let height: number;

        if (
            discordWidth /
                discordHeight >
            aspect
        ) {
            height =
                discordHeight;

            width =
                Math.round(
                    height *
                        aspect
                );
        } else {
            width =
                discordWidth;

            height =
                Math.round(
                    width /
                        aspect
                );
        }

        if (width < 320) {
            width = 320;
            height = 180;
        }

        if (height < 180) {
            height = 180;
            width = 320;
        }

        return {
            width,
            height
        };
    }

    return {
        width:
            discordWidth,

        height:
            discordHeight
    };
}


function applyBackgroundFit() {
    if (!background)
        return;

    background.style.objectFit =
        getSizingMode() ===
        "preserve16x9"
            ? "contain"
            : "cover";
}


async function findSource() {
    const sources =
        await Native.listWindowSources();

    return sources.find(
        source =>
            source.name ===
            SOURCE_NAME
    ) ?? null;
}


async function startCapture() {
    if (
        !running ||
        stream
    )
        return;

    try {
        const monitorKey =
    await getMonitorKey();

        const presetName =
            getPresetName();

        const sizingMode =
            getSizingMode();

        const initialSize =
            getTargetRenderSize(
                sizingMode
            );

        const currentWallpaper =
            await Native.getActiveWallpaperFile(
                monitorKey
            );

        await Native.launchCaptureWindow(
            monitorKey,
            presetName,
            initialSize.width,
            initialSize.height
        );

        const source =
            await findSource();

        if (!source) {

            retryTimer =
                window.setTimeout(
                    () => {
                        retryTimer = null;

                        void startCapture();
                    },
                    1000
                );

            return;
        }


        try {
            await Native.hideCaptureWindow();

        } catch (error) {
            console.error(
                "[MaruWPEBackground] Failed to hide capture window:",
                error
            );
        }

        stream =
            await navigator.mediaDevices.getUserMedia({
                audio: false,

                video: {
                    mandatory: {
                        chromeMediaSource:
                            "desktop",

                        chromeMediaSourceId:
                            source.id
                    }
                } as any
            });

        for (
            const track of
            stream.getVideoTracks()
        ) {
            track.addEventListener(
                "ended",
                () => {
                    scheduleRecovery(
                        "capture stream ended"
                    );
                },
                {
                    once: true
                }
            );
        }

        if (!running) {
            stream
                .getTracks()
                .forEach(
                    track =>
                        track.stop()
                );

            stream = null;

            return;
        }

        background =
            document.createElement(
                "video"
            );

        background.id =
            "vc-maru-wpe-background";

        background.srcObject =
            stream;

        background.autoplay =
            true;

        background.muted =
            true;

        background.playsInline =
            true;

        applyBackgroundFit();

        style =
            document.createElement(
                "style"
            );

        style.id =
            "vc-maru-wpe-background-style";

        style.textContent = `
            html,
            body {
                background: transparent !important;
            }

            #vc-maru-wpe-background {
                position: fixed;
                inset: 0;

                width: 100%;
                height: 100%;

                pointer-events: none;
                user-select: none;

                z-index: 0;

                background: black;
            }

            #app-mount {
                position: relative;

                z-index: 1;

                background: transparent !important;
            }
        `;

        document.head.appendChild(
            style
        );

        document.body.prepend(
            background
        );

        await background.play();

        lastWallpaperFile =
            currentWallpaper;

        lastMonitorKey =
            monitorKey;

        lastPresetName =
            presetName;

        lastSizingMode =
            sizingMode;


    } catch (error) {
        console.error(
            "[MaruWPEBackground] Capture failed:",
            error
        );

        showFailureToast(
            "WE Background failed to start. Check Wallpaper Engine and plugin settings."
        );

        stopCurrentCapture();

        if (
            running &&
            retryTimer === null
        ) {
            retryTimer =
                window.setTimeout(
                    () => {
                        retryTimer = null;

                        void startCapture();
                    },
                    1000
                );
        }
    }
}


function stopCurrentCapture() {
    background?.remove();

    background = null;

    style?.remove();

    style = null;

    stream
        ?.getTracks()
        .forEach(
            track =>
                track.stop()
        );

    stream = null;
}


async function applyCaptureSizing() {
    if (!running)
        return;

    const mode =
        getSizingMode();

    const target =
        getTargetRenderSize(
            mode
        );

    applyBackgroundFit();

    try {
        await Native.resizeCaptureWindow(
            target.width,
            target.height
        );

    } catch (error) {
        console.error(
            "[MaruWPEBackground] Failed to apply sizing:",
            error
        );
    }
}


function scheduleCaptureResize() {
    if (!running)
        return;

    /*
     * Fixed mode deliberately ignores normal
     * Discord window resizing.
     */
    if (
        getSizingMode() ===
        "fixed1080"
    )
        return;

    if (resizeTimer !== null)
        clearTimeout(
            resizeTimer
        );

    resizeTimer =
        window.setTimeout(
            () => {
                resizeTimer = null;

                if (!running)
                    return;

                void applyCaptureSizing();
            },
            200
        );
}


function scheduleRecovery(
    reason: string
) {
    if (
        !running ||
        recovering ||
        wallpaperReloading
    )
        return;

    recovering = true;

    console.warn(
        "[MaruWPEBackground] Recovery requested:",
        reason
    );

    if (recoveryTimer !== null)
        clearTimeout(
            recoveryTimer
        );

    recoveryTimer =
        window.setTimeout(
            async () => {
                recoveryTimer = null;

                if (!running) {
                    recovering = false;
                    return;
                }

                stopCurrentCapture();

                try {
                    await Native.closeCaptureWindow();
                } catch (error) {
                    console.error(
                        "[MaruWPEBackground] Recovery cleanup failed:",
                        error
                    );
                }

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            500
                        )
                );

                if (running)
                    await startCapture();

                recovering = false;
            },
            250
        );
}


async function reloadWallpaper(
    reason: string,
    currentWallpaper: string | null,
    monitorKey: string,
    presetName: string,
    sizingMode: SizingMode
) {
    if (
        !running ||
        wallpaperReloading ||
        recovering
    )
        return;

    wallpaperReloading =
        true;

    /*
     * Record the desired state immediately.
     * This prevents the watcher from repeatedly
     * tearing down a wallpaper while WE is still
     * opening the new capture window.
     */
    lastWallpaperFile =
        currentWallpaper;

    pendingWallpaperFile =
        null;

    wallpaperChangePending =
        false;

    lastMonitorKey =
        monitorKey;

    lastPresetName =
        presetName;

    lastSizingMode =
        sizingMode;


    stopCurrentCapture();

    try {
        await Native.closeCaptureWindow();
    } catch (error) {
        console.error(
            "[MaruWPEBackground] Failed to close old wallpaper:",
            error
        );
    }

    if (!currentWallpaper) {
        wallpaperReloading =
            false;

        return;
    }

    await new Promise(
        resolve =>
            setTimeout(
                resolve,
                500
            )
    );

    try {
        if (running)
            await startCapture();
    } finally {
        wallpaperReloading =
            false;
    }
}


async function watchWallpaper() {
    if (!running)
        return;

    try {
        const monitorKey =
    await getMonitorKey();

        const presetName =
            getPresetName();

        const sizingMode =
            getSizingMode();

        const currentWallpaper =
            await Native.getActiveWallpaperFile(
                monitorKey
            );

        /*
         * Establish the initial wallpaper baseline.
         */
        if (
            !wallpaperBaselineInitialized
        ) {
            lastWallpaperFile =
                currentWallpaper;

            wallpaperBaselineInitialized =
                true;
        }

        if (
            lastMonitorKey ===
            null
        ) {
            lastMonitorKey =
                monitorKey;
        }

        if (
            lastPresetName ===
            null
        ) {
            lastPresetName =
                presetName;
        }

        if (
            lastSizingMode ===
            null
        ) {
            lastSizingMode =
                sizingMode;
        }

        const monitorChanged =
            monitorKey !==
            lastMonitorKey;

        const presetChanged =
            presetName !==
            lastPresetName;

        const wallpaperChanged =
            currentWallpaper !==
            lastWallpaperFile;

        const sizingChanged =
            sizingMode !==
            lastSizingMode;

        let settledWallpaperChanged =
            false;

        if (wallpaperChanged) {
            if (
                !wallpaperChangePending ||
                pendingWallpaperFile !==
                    currentWallpaper
            ) {
                pendingWallpaperFile =
                    currentWallpaper;

                wallpaperChangePending =
                    true;
            } else {
                settledWallpaperChanged =
                    true;
            }
        } else {
            pendingWallpaperFile =
                null;

            wallpaperChangePending =
                false;
        }

        const shouldFollowWallpaper =
            settings.store.autoFollowWallpaper &&
            settledWallpaperChanged;

        /*
         * Monitor and preset changes are explicit
         * user settings, so they reload even when
         * automatic WE wallpaper following is off.
         */
        if (
            monitorChanged ||
            presetChanged ||
            shouldFollowWallpaper
        ) {
            const reason =
                monitorChanged
                    ? "monitor source changed"
                    : presetChanged
                        ? "preset changed"
                        : "Wallpaper Engine wallpaper changed";

            await reloadWallpaper(
                reason,
                currentWallpaper,
                monitorKey,
                presetName,
                sizingMode
            );
        } else if (
            sizingChanged
        ) {
            lastSizingMode =
                sizingMode;

            await applyCaptureSizing();
        }

        /*
         * When Auto Follow is disabled we deliberately
         * do NOT update lastWallpaperFile after a WE
         * wallpaper change. That way turning Auto Follow
         * back on immediately notices the difference and
         * catches Discord up.
         */
        if (
            !wallpaperChanged
        ) {
            lastWallpaperFile =
                currentWallpaper;
        }

        lastMonitorKey =
            monitorKey;

        lastPresetName =
            presetName;

    } catch (error) {
        console.error(
            "[MaruWPEBackground] Wallpaper watch failed:",
            error
        );

        showFailureToast(
            "WE Background could not read the current Wallpaper Engine wallpaper or monitor."
        );
    }

    if (running) {
        wallpaperWatchTimer =
            window.setTimeout(
                () => {
                    wallpaperWatchTimer =
                        null;

                    void watchWallpaper();
                },
                250
            );
    }
}


async function startFreshCapture() {
    try {
        await Native.closeCaptureWindow();
    } catch (error) {
        console.error(
            "[MaruWPEBackground] Failed to clear stale capture window:",
            error
        );
    }

    await new Promise(
        resolve =>
            setTimeout(
                resolve,
                500
            )
    );

    if (!running)
        return;

    await startCapture();
}


async function stopEverything() {
    running = false;

    if (
        retryTimer !==
        null
    ) {
        clearTimeout(
            retryTimer
        );

        retryTimer = null;
    }

    if (
        wallpaperWatchTimer !==
        null
    ) {
        clearTimeout(
            wallpaperWatchTimer
        );

        wallpaperWatchTimer =
            null;
    }

    if (
        resizeTimer !==
        null
    ) {
        clearTimeout(
            resizeTimer
        );

        resizeTimer = null;
    }

    if (
        recoveryTimer !==
        null
    ) {
        clearTimeout(
            recoveryTimer
        );

        recoveryTimer = null;
    }

    window.removeEventListener(
        "resize",
        scheduleCaptureResize
    );

    recovering = false;
    wallpaperReloading = false;

    lastWallpaperFile = null;
    wallpaperBaselineInitialized = false;
    pendingWallpaperFile = null;
    wallpaperChangePending = false;
    lastMonitorKey = null;
    lastPresetName = null;
    lastSizingMode = null;

    stopCurrentCapture();

    try {
        await Native.closeCaptureWindow();
    } catch (error) {
        console.error(
            "[MaruWPEBackground] Failed to close WE capture window:",
            error
        );
    }
}


export default definePlugin({
    name:
        "MaruWPEBackground",

    description:
        "Uses Wallpaper Engine's finished render as a live Discord background.",
settings,

    authors: [
        {
            name:
                "Maru",

            id:
                0n
        }
    ],

    start() {
        running = true;

        lastMonitorKey =
    null;

        lastPresetName =
            getPresetName();

        lastSizingMode =
            getSizingMode();

        lastWallpaperFile =
            null;
        wallpaperBaselineInitialized = false;
        pendingWallpaperFile = null;
        wallpaperChangePending = false;

        void startFreshCapture();
        void watchWallpaper();


        window.addEventListener(
            "resize",
            scheduleCaptureResize
        );
    },

    stop() {
        void stopEverything();
    }
});







