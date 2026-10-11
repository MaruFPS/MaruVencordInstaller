/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getUserSettingLazy } from "@api/UserSettings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Menu, Popout, useRef } from "@webpack/common";
import managedStyle from "./style.css?managed";

type Status = "online" | "idle" | "dnd" | "invisible";

const Button = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const StatusSettings = getUserSettingLazy<string>("status", "status")!;

const STATUSES: Array<{ label: string; value: Status; }> = [
    { label: "Online", value: "online" },
    { label: "Idle", value: "idle" },
    { label: "Do Not Disturb", value: "dnd" },
    { label: "Invisible", value: "invisible" }
];

function normalizeStatus(status: string | undefined): Status {
    return status === "idle" || status === "dnd" || status === "invisible"
        ? status
        : "online";
}

function statusLabel(status: Status) {
    return STATUSES.find(s => s.value === status)?.label ?? "Online";
}

function NativeStatusIcon({ status }: { status: Status; }) {
    const nativeMask = status === "invisible" ? "offline" : status;
    const color =
        status === "online" ? "#23a55a" :
        status === "idle" ? "#f0b232" :
        status === "dnd" ? "#f23f43" :
        "#82858f";

    return (
        <span className="vc-status-switcher-control" aria-hidden="true">
            <svg
                className="vc-status-switcher-presence"
                width="18"
                height="18"
                viewBox="0 0 18 18"
            >
                <rect
                    x="3"
                    y="3"
                    width="12"
                    height="12"
                    fill={color}
                    mask={`url(#svg-mask-status-${nativeMask})`}
                />
            </svg>

            <svg
                className="vc-status-switcher-chevron"
                width="11"
                height="11"
                viewBox="0 0 12 12"
            >
                <path
                    d="M1.5 3.75 6 8.25 10.5 3.75"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        </span>
    );
}

function StatusSwitcherButton(props: { nameplate?: any; }) {
    const currentStatus = normalizeStatus(StatusSettings.useSetting());
    const buttonRef = useRef<HTMLButtonElement | null>(null);

    return (
        <Popout
            position="top"
            align="left"
            targetElementRef={buttonRef}
            renderPopout={({ closePopout }) => (
                <Menu.Menu
                    navId="vc-status-switcher-menu"
                    onClose={closePopout}
                >
                    <Menu.MenuGroup label="Set Status">
                        {STATUSES.map(status => (
                            <Menu.MenuRadioItem
                                key={status.value}
                                id={`vc-status-switcher-${status.value}`}
                                group="vc-status-switcher"
                                label={status.label}
                                checked={currentStatus === status.value}
                                action={() => {
                                    void StatusSettings.updateSetting(status.value);
                                    closePopout();
                                }}
                            />
                        ))}
                    </Menu.MenuGroup>
                </Menu.Menu>
            )}
        >
            {popoutProps => (
                <Button
                    ref={buttonRef}
                    tooltipText={`Status: ${statusLabel(currentStatus)}`}
                    icon={() => <NativeStatusIcon status={currentStatus} />}
                    plated={props?.nameplate != null}
                    onClick={popoutProps.onClick}
                    aria-label={`Change status. Current status: ${statusLabel(currentStatus)}`}
                />
            )}
        </Popout>
    );
}

export default definePlugin({
    name: "StatusSwitcher",
    description: "Adds a status picker directly beside the mute/deafen controls.",
    authors: [{ name: "Maru", id: 0n }],
    dependencies: ["UserSettingsAPI"],

    managedStyle,

    patches: [
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                match: /children:\[(?=.{0,25}?accountContainerRef)/,
                replace: "children:[$self.StatusSwitcherButton(arguments[0]),"
            }
        }
    ],

    StatusSwitcherButton: ErrorBoundary.wrap(StatusSwitcherButton, { noop: true })
});
