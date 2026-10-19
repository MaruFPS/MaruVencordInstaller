/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

let sourceChanged = () => {};
export function onSourceSettingsChanged(listener: () => void) {
    sourceChanged = listener;
}

export const settings = definePluginSettings({
    showPanel: { type: OptionType.BOOLEAN, description: "Show the local VS Code panel", default: true, onChange: () => sourceChanged() },
    showWorkspace: { type: OptionType.BOOLEAN, description: "Show workspace name", default: true },
    showFile: { type: OptionType.BOOLEAN, description: "Show active file name", default: true },
    showCursor: { type: OptionType.BOOLEAN, description: "Show cursor line and column", default: true },
    showDuration: { type: OptionType.BOOLEAN, description: "Show elapsed workspace session time (including idle time)", default: true },
    showRepository: { type: OptionType.BOOLEAN, description: "Show repository link", default: true },
    hideInactive: { type: OptionType.BOOLEAN, description: "Hide when no editor is available or VS Code is closed", default: true },
    position: {
        type: OptionType.SELECT,
        description: "Position relative to Spotify (also supports Maru theme ordering)",
        options: [{ label: "Above Spotify", value: "above", default: true }, { label: "Below Spotify", value: "below" }]
    },
    bridgeToken: {
        type: OptionType.STRING,
        description: "Paste the secret from VS Code: Maru Activity: Pair with Discord. Keep this secret private.",
        default: "",
        onChange: () => sourceChanged()
    },
    bridgePort: {
        type: OptionType.NUMBER,
        description: "Local bridge port (must match the companion; default 32145)",
        default: 32145,
        isValid: value => typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535,
        onChange: () => sourceChanged()
    }
});
