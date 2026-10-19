"use strict";
/* SPDX-License-Identifier: GPL-3.0-or-later */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.readVSCordIdentity = readVSCordIdentity;
const vscode = __importStar(require("vscode"));
const APPLICATION_IDS = {
    Code: "782685898163617802",
    "Visual Studio Code": "810516608442695700",
    VSCodium: "1031067701474492496",
    Antigravity: "1441771215290372156",
    Cursor: "1376937466619232256"
};
/** VSCord 5.3.10 sends this extension-host PID through SET_ACTIVITY. */
function readVSCordIdentity(privacy) {
    if (!vscode.extensions.getExtension("LeonardSSH.vscord")?.isActive)
        return;
    // Match VSCord's own unscoped effective configuration, including workspace overrides.
    const config = vscode.workspace.getConfiguration("vscord");
    const name = config.get("app.name", "Visual Studio Code");
    const applicationId = APPLICATION_IDS[name] ?? config.get("app.id");
    if (typeof applicationId !== "string" || !/^\d{17,20}$/.test(applicationId))
        return;
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
