/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface NativeFriendRow {
    type: number;
    userId: string;
    voiceChannelId?: string | null;
    [key: string]: unknown;
}

export interface NativeVoiceGroupRow {
    type: number;
    key: string;
    channelId: string;
    rows: NativeFriendRow[];
    extraMemberCount: number;
}

export interface NativeFriendsSection {
    key: string;
    type: number;
    rows: (NativeFriendRow | NativeVoiceGroupRow)[];
}

export interface NativeVoiceGroupProjection {
    key: string;
    sectionType: number;
    row: NativeVoiceGroupRow;
}

/** Restrict groups already produced by Discord to the selected PinDMs category. */
export function projectNativeVoiceGroups(
    sections: readonly NativeFriendsSection[] | null | undefined,
    categoryUserIds: ReadonlySet<string>,
    voiceGroupType: number
): NativeVoiceGroupProjection[] {
    const projected: NativeVoiceGroupProjection[] = [];
    if (!Array.isArray(sections)) return projected;

    for (const section of sections) {
        if (!section || typeof section.key !== "string" || typeof section.type !== "number" || !Array.isArray(section.rows)) continue;
        for (const candidate of section.rows) {
            if (!candidate || candidate.type !== voiceGroupType) continue;
            const group = candidate as NativeVoiceGroupRow;
            if (typeof group.key !== "string" || typeof group.channelId !== "string" || !group.channelId ||
                !Array.isArray(group.rows) || !Number.isSafeInteger(group.extraMemberCount) || group.extraMemberCount < 0 ||
                group.rows.some(row => !row || typeof row.type !== "number" || typeof row.userId !== "string" || !row.userId)) continue;

            const rows = group.rows.filter(row => categoryUserIds.has(row.userId));
            if (rows.length < 2) continue;
            projected.push({
                key: `${section.key}:${group.key}`,
                sectionType: section.type,
                // Excluded native friends remain participants in Discord's own
                // supplemental count; never mutate its shared store snapshot.
                row: rows.length === group.rows.length ? group : {
                    ...group,
                    rows,
                    extraMemberCount: group.extraMemberCount + group.rows.length - rows.length
                }
            });
        }
    }
    return projected;
}
