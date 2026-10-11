import * as DataStore from "@api/DataStore";
import { plugins } from "@api/PluginManager";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";

import { Player as YTMPlayer } from "./PlayerComponent";

const API_BASE = "http://127.0.0.1:9863/api/v1";

const APP_ID = "ytmdesktopcontrols";
const APP_NAME = "YTMDesktopControls";
const APP_VERSION = "0.1.0";

const TOKEN_KEY = "YTMDesktopControls_token";

let originalSpotifyPanelWrapper: any = null;

class CompanionRequestError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "CompanionRequestError";
        this.status = status;
    }
}

async function requestAuthorization(): Promise<string> {
    const codeResponse = await fetch(`${API_BASE}/auth/requestcode`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            appId: APP_ID,
            appName: APP_NAME,
            appVersion: APP_VERSION
        })
    });

    if (!codeResponse.ok) {
        throw new CompanionRequestError(
            `Code request failed: HTTP ${codeResponse.status}`,
            codeResponse.status
        );
    }

    const { code } = await codeResponse.json();

    const authResponse = await fetch(`${API_BASE}/auth/request`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            appId: APP_ID,
            code
        })
    });

    if (!authResponse.ok) {
        throw new CompanionRequestError(
            `Authorization failed: HTTP ${authResponse.status}`,
            authResponse.status
        );
    }

    const { token } = await authResponse.json();

    if (!token) {
        throw new Error("YTMDesktop did not return an authorization token.");
    }

    await DataStore.set(TOKEN_KEY, token);

    return token;
}

async function getState(token: string) {
    const response = await fetch(`${API_BASE}/state`, {
        headers: {
            Authorization: token
        }
    });

    if (!response.ok) {
        throw new CompanionRequestError(
            `State request failed: HTTP ${response.status}`,
            response.status
        );
    }

    return response.json();
}

function isAuthorizationError(error: unknown): boolean {
    return (
        error instanceof CompanionRequestError &&
        (error.status === 401 || error.status === 403)
    );
}

async function getAuthorizedState() {
    let token = await DataStore.get<string>(TOKEN_KEY);

    if (!token) {
        console.log(
            "[YTMDesktopControls] No saved companion token. Requesting authorization."
        );

        token = await requestAuthorization();
        return getState(token);
    }

    try {
        return await getState(token);
    } catch (error) {
        if (!isAuthorizationError(error)) {
            throw error;
        }

        console.warn(
            "[YTMDesktopControls] Saved companion token was rejected. Requesting fresh authorization."
        );

        await DataStore.del(TOKEN_KEY);

        token = await requestAuthorization();
        return getState(token);
    }
}

function installPanelWrapper() {
    const spotifyPlugin = plugins.SpotifyControls as any;

    if (!spotifyPlugin?.PanelWrapper) {
        console.error(
            "[YTMDesktopControls] SpotifyControls PanelWrapper was not found."
        );
        return;
    }

    if (originalSpotifyPanelWrapper) return;

    originalSpotifyPanelWrapper = spotifyPlugin.PanelWrapper;

    spotifyPlugin.PanelWrapper = function (props: any) {
        return (
            <>
                <ErrorBoundary
                    fallback={() => (
                        <div style={{ padding: "8px" }}>
                            Failed to render YTMDesktopControls
                        </div>
                    )}
                >
                    <YTMPlayer />
                </ErrorBoundary>

                {originalSpotifyPanelWrapper(props)}
            </>
        );
    };
}

function uninstallPanelWrapper() {
    if (!originalSpotifyPanelWrapper) return;

    const spotifyPlugin = plugins.SpotifyControls as any;

    spotifyPlugin.PanelWrapper = originalSpotifyPanelWrapper;
    originalSpotifyPanelWrapper = null;
}

export default definePlugin({
    name: "YTMDesktopControls",
    description: "Adds YouTube Music Desktop controls above the Discord account panel.",
    authors: [{ name: "Maru", id: 0n }],

    dependencies: ["SpotifyControls"],

    async start() {
        installPanelWrapper();

        try {
            const state = await getAuthorizedState();

            console.log("[YTMDesktopControls] Player state:", state);
        } catch (error) {
            console.error("[YTMDesktopControls]", error);
        }
    },

    stop() {
        uninstallPanelWrapper();
    }
});
