import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { ChannelStore, GuildChannelStore, GuildStore, UserStore } from "@webpack/common";

import { collectDestinations } from "./catalog";

const Native = VencordNative.pluginHelpers.StreamDockDestinations as PluginNative<typeof import("./native")>;
const logger = new Logger("StreamDockDestinations");
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let lastState = "";

async function update(current: number) {
    try {
        const state = await Native.start();
        if (current !== generation) return;
        if (state === "listening") {
            const snapshot = collectDestinations(ChannelStore, GuildChannelStore, UserStore, GuildStore);
            await Native.publish(snapshot);
            const summary = snapshot
                ? `listening; private store: ${snapshot.privateAvailable}; favorites store: ${snapshot.favoritesAvailable}; DMs: ${snapshot.privateChannels.filter(c => c.type === 1).length}; groups: ${snapshot.privateChannels.filter(c => c.type === 3).length}; favorites: ${snapshot.favorites.length}`
                : "listening; no logged-in account";
            if (summary !== lastState) { logger.info(summary); lastState = summary; }
        } else if (lastState !== state) { logger.warn(state); lastState = state; }
    } catch {
        if (lastState !== "unavailable") { logger.warn("Native bridge unavailable; restart Discord after building"); lastState = "unavailable"; }
    } finally {
        if (current === generation) timer = setTimeout(() => update(current), 3000);
    }
}

export default definePlugin({
    name: "StreamDockDestinations",
    description: "Shares Discord DM, group chat and Favorites destinations with the local StreamDock Discord plugin.",
    authors: [{ name: "Local custom integration", id: 0n }],
    start() {
        lastState = "";
        void update(++generation);
    },
    stop() {
        ++generation;
        clearTimeout(timer);
        void Native.stop().catch(() => logger.warn("Could not stop native bridge"));
    }
});
