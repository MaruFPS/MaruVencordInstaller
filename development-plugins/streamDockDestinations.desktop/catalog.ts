// Store contracts traced in this checkout's packages/discord-types and ShowHiddenChannels.
// Keep this adapter pure so unavailable stores and channel shapes can be tested offline.
export interface Destination {
    id: string;
    name: string;
    type: number;
    guildId: string;
    guildName: string;
}

export interface Snapshot {
    version: 1;
    accountId: string;
    privateAvailable: boolean;
    favoritesAvailable: boolean;
    privateChannels: Destination[];
    favorites: Destination[];
}

const validId = (id: unknown): id is string => typeof id === "string" && /^\d{16,22}$/.test(id);
const destinationTypes = new Set([0, 1, 2, 3, 5, 10, 11, 12, 13, 15, 16]);

export function collectDestinations(ChannelStore, GuildChannelStore, UserStore, GuildStore): Snapshot | null {
    const accountId = UserStore?.getCurrentUser?.()?.id;
    if (!validId(accountId)) return null;
    const snapshot: Snapshot = { version: 1, accountId, privateAvailable: false,
        favoritesAvailable: false, privateChannels: [], favorites: [] };

    const destination = (channel, displayName?: string): Destination | null => {
        if (!validId(channel?.id) || !destinationTypes.has(channel.type)) return null;
        const privateChannel = channel.type === 1 || channel.type === 3;
        if (!privateChannel && !validId(channel.guild_id)) return null;
        const recipients = Array.isArray(channel.recipients) ? channel.recipients : [];
        const names = privateChannel ? recipients.filter(id => id !== accountId).map(id => {
            const user = UserStore.getUser(id);
            return user?.globalName || user?.global_name || user?.username || "Unknown user";
        }).join(", ") : "";
        return {
            id: channel.id, type: channel.type,
            name: String(displayName || channel.name || names || (channel.type === 3 ? "Group chat" : "Conversation")).slice(0, 240),
            guildId: privateChannel ? "" : channel.guild_id,
            guildName: privateChannel ? "" : String(GuildStore?.getGuild?.(channel.guild_id)?.name || "Server").slice(0, 100)
        };
    };
    try {
        // Both methods are declared in this checkout's ChannelStore.d.ts.
        const rows = typeof ChannelStore?.getSortedPrivateChannels === "function"
            ? ChannelStore.getSortedPrivateChannels()
            : Object.values(ChannelStore.getMutablePrivateChannels());
        if (Array.isArray(rows)) {
            snapshot.privateAvailable = true;
            const seen = new Set<string>();
            for (const channel of rows) {
                if (![1, 3].includes(channel?.type) || seen.has(channel.id)) continue;
                const item = destination(channel);
                if (item) { snapshot.privateChannels.push(item); seen.add(item.id); }
            }
        }
    } catch { /* report capability unavailable; never claim an empty successful list */ }
    try {
        // ShowHiddenChannels explicitly handles getChannels("@favorites") in this source.
        // Read its channel arrays, not UserGuildSettingsStore's unrelated per-guild flags.
        const favorites = GuildChannelStore?.getChannels?.("@favorites");
        if (favorites && Array.isArray(favorites.SELECTABLE)) {
            snapshot.favoritesAvailable = true;
            const seen = new Set<string>();
            for (const rows of Object.values(favorites)) {
                if (!Array.isArray(rows)) continue;
                for (const row of rows) {
                    // Resolve the real channel, since the Favorites view may use a virtual guild.
                    const original = ChannelStore.getChannel(row?.channel?.id);
                    const item = destination(original, row?.channel?.name);
                    if (item && !seen.has(item.id)) { snapshot.favorites.push(item); seen.add(item.id); }
                }
            }
        }
    } catch { /* Discord modules are versioned independently; fail closed */ }
    return snapshot;
}
