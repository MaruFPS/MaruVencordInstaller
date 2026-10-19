/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationAssetUtils, React, useEffect, useState } from "@webpack/common";

import { activityDisplay, elapsedLabel, languageInfo } from "./presentation";
import { settings } from "./settings";
import { activitySource } from "./source";

function SessionDuration({ startedAt }: { startedAt: number; }) {
    const [label, setLabel] = useState(() => elapsedLabel(startedAt));
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>;
        const update = () => {
            setLabel(elapsedLabel(startedAt));
            const elapsed = Math.max(0, Date.now() - startedAt);
            timer = setTimeout(update, 60000 - elapsed % 60000);
        };
        update();
        return () => clearTimeout(timer);
    }, [startedAt]);
    return <span className="maru-activity-panel-duration" title="Elapsed workspace session, including idle time">{label} session</span>;
}

function presenceImage(applicationId: string | undefined, asset: string | undefined): string | undefined {
    if (!applicationId || !asset) return;
    try {
        const source = ApplicationAssetUtils.getAssetImage(applicationId, asset, 128);
        const url = new URL(source);
        // Use only Discord's already resolved CDN/proxy assets, not arbitrary URLs.
        if (url.protocol === "https:" && !url.username && !url.password
            && ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) return url.href;
    } catch { /* An unavailable asset must not affect the local editor fallback. */ }
}

function LanguageArtwork({ source, title, language, badge, color }: {
    source?: string; title?: string; language: string; badge: string; color: string;
}) {
    const [failedSource, setFailedSource] = useState<string | undefined>();
    useEffect(() => setFailedSource(undefined), [source]);
    if (source && source !== failedSource) {
        return <img className="maru-activity-panel-language" src={source} alt={title ?? language} title={title ?? language} referrerPolicy="no-referrer" onError={() => setFailedSource(source)} />;
    }
    return (
        <svg className="maru-activity-panel-language" viewBox="7 1 27 37" role="img" aria-label={language} style={{ color }}>
            <title>{language}</title>
            <path d="M8 2h18l7 7v28H8z" fill="currentColor" opacity=".16" />
            <path d="M26 2v8h7" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <text x="20" y="27" textAnchor="middle" fill="currentColor" fontSize={badge.length > 3 ? 9 : 12} fontWeight="700">{badge}</text>
        </svg>
    );
}

export function ActivityPanel() {
    const config = settings.use();
    const { activity, error, presence } = React.useSyncExternalStore(activitySource.subscribe, activitySource.getSnapshot);
    if (!activitySource.isRunning() || !config.showPanel) return null;
    if ((!activity || activity.status === "unavailable") && config.hideInactive && !error) return null;
    const [language, badge, color] = languageInfo(activity?.language);
    const available = activity && activity.status !== "unavailable";
    const display = activity ? activityDisplay(activity, presence, config) : undefined;
    return (
        <section
            className="maru-activity-panel"
            data-position={config.position}
            data-status={available ? activity.status : "unavailable"}
            aria-label="Visual Studio Code activity"
        >
            <div className="maru-activity-panel-header">
                <span className="maru-activity-panel-heading">{display?.application ?? "VS Code"} <span className="maru-activity-panel-status">{available ? activity.status === "coding" ? "Coding" : "Idle" : "Unavailable"}</span></span>
            </div>
            {available ? (
                <div className="maru-activity-panel-content">
                    <LanguageArtwork source={presenceImage(activity.vscord?.applicationId, display?.image?.asset)} title={display?.image?.title} language={language} badge={badge} color={color} />
                    <div className="maru-activity-panel-details">
                        {display?.file && <div className="maru-activity-panel-file" title={display.file}>{display.file}</div>}
                        {display?.workspace && <div className="maru-activity-panel-workspace" title={display.workspace}>{display.workspace}</div>}
                        {display?.startedAt != null && <SessionDuration startedAt={display.startedAt} />}
                    </div>
                </div>
            ) : <div className="maru-activity-panel-empty">{error ?? "No active VS Code editor"}</div>}
            {available && (
                <div className="maru-activity-panel-secondary">
                    {activity.language && <span>{language}</span>}
                    {config.showCursor && activity.line != null && activity.column != null && <span>Line {activity.line} · Col {activity.column}</span>}
                    {display?.buttons.map((button, index) => <a key={`${index}:${button.url}`} className="maru-activity-panel-repository" href={button.url} target="_blank" rel="noreferrer noopener">{button.label} ↗</a>)}
                </div>
            )}
        </section>
    );
}
