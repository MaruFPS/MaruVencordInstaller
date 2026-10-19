/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { disableStyle, enableStyle } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { ComponentType, ReactNode } from "react";

import { ActivityPanel } from "./Panel";
import { settings } from "./settings";
import { activitySource } from "./source";
import style from "./style.css?managed";

export default definePlugin({
    name: "MaruActivityPanel",
    description: "A private local VS Code activity panel above the account controls, independent of Discord presence.",
    authors: [{ name: "Maru", id: 0n }],
    tags: ["Activity", "Developers"],
    settings,
    patches: [{
        find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
        replacement: {
            // Wrap the provider around the account slot. The account call stays intact,
            // so SpotifyControls' separate patch composes in either registration order.
            // Verified against the installed Canary cache; see AUDIT.md and patch test.
            match: /(?<=\i\.jsxs?\)\()(\i\.\i),{(?=value:\i,children:\(0,\i\.jsxs?\)\([^,]+,{[^}]*?userTag:\i,occluded:)/,
            replace: "$self.PanelProvider,{MaruOriginalProvider:$1,"
        }
    }],
    start() {
        enableStyle(style);
        activitySource.start();
    },
    stop() {
        activitySource.stop();
        disableStyle(style);
    },
    PanelProvider({ MaruOriginalProvider, children, ...props }: {
        MaruOriginalProvider: ComponentType<{ children?: ReactNode; value?: unknown; }>;
        children?: ReactNode;
        value?: unknown;
    }) {
        return (
            <MaruOriginalProvider {...props}>
                <ErrorBoundary noop><ActivityPanel /></ErrorBoundary>
                {children}
            </MaruOriginalProvider>
        );
    }
});
