/* SPDX-License-Identifier: GPL-3.0-or-later */

import * as vscode from "vscode";

import { Privacy, VSCordIdentity } from "./activity";

const APPLICATION_IDS: Readonly<Record<string, string>> = {
    Code: "782685898163617802",
    "Visual Studio Code": "810516608442695700",
    VSCodium: "1031067701474492496",
    Antigravity: "1441771215290372156",
    Cursor: "1376937466619232256"
};

/** VSCord 5.3.10 sends this extension-host PID through SET_ACTIVITY. */
export function readVSCordIdentity(privacy: Privacy): VSCordIdentity | undefined {
    if (!vscode.extensions.getExtension("LeonardSSH.vscord")?.isActive) return;
    // Match VSCord's own unscoped effective configuration, including workspace overrides.
    const config = vscode.workspace.getConfiguration("vscord");
    const name = config.get<string>("app.name", "Visual Studio Code");
    const applicationId = APPLICATION_IDS[name] ?? config.get<string>("app.id");
    if (typeof applicationId !== "string" || !/^\d{17,20}$/.test(applicationId)) return;

    return {
        applicationId,
        pid: process.pid,
        // Arbitrary VSCord templates can embed every field, including repository URLs.
        allowText: privacy.shareWorkspace && privacy.shareFile && privacy.shareCursor
            && privacy.shareDuration && privacy.shareRepository,
        allowImages: privacy.shareFile,
        allowTimestamp: privacy.shareDuration,
        allowButtons: privacy.shareRepository
    };
}
