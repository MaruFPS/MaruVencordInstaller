/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React, useEffect, useState } from "@webpack/common";

import { elapsedLabel, languageInfo } from "./presentation";
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

export function ActivityPanel() {
    const config = settings.use();
    const { activity, error } = React.useSyncExternalStore(activitySource.subscribe, activitySource.getSnapshot);
    if (!activitySource.isRunning() || !config.showPanel) return null;
    if ((!activity || activity.status === "unavailable") && config.hideInactive && !error) return null;
    const [language, badge, color] = languageInfo(activity?.language);
    const available = activity && activity.status !== "unavailable";
    return (
        <section
            className="maru-activity-panel"
            data-position={config.position}
            data-status={available ? activity.status : "unavailable"}
            aria-label="Visual Studio Code activity"
        >
            <div className="maru-activity-panel-header">
                <span className="maru-activity-panel-heading">VS Code <span className="maru-activity-panel-status">{available ? activity.status === "coding" ? "Coding" : "Idle" : "Unavailable"}</span></span>
            </div>
            {available ? (
                <div className="maru-activity-panel-content">
                    <svg className="maru-activity-panel-language" viewBox="7 1 27 37" role="img" aria-label={language} style={{ color }}>
                        <title>{language}</title>
                        <path d="M8 2h18l7 7v28H8z" fill="currentColor" opacity=".16" />
                        <path d="M26 2v8h7" fill="none" stroke="currentColor" strokeWidth="1.5" />
                        <text x="20" y="27" textAnchor="middle" fill="currentColor" fontSize={badge.length > 3 ? 9 : 12} fontWeight="700">{badge}</text>
                    </svg>
                    <div className="maru-activity-panel-details">
                        {config.showFile && activity.file && <div className="maru-activity-panel-file" title={activity.file}>{activity.file}</div>}
                        {config.showWorkspace && activity.workspace && <div className="maru-activity-panel-workspace" title={activity.workspace}>{activity.workspace}</div>}
                        {config.showDuration && activity.startedAt != null && <SessionDuration startedAt={activity.startedAt} />}
                    </div>
                </div>
            ) : <div className="maru-activity-panel-empty">{error ?? "No active VS Code editor"}</div>}
            {available && (
                <div className="maru-activity-panel-secondary">
                    {activity.language && <span>{language}</span>}
                    {config.showCursor && activity.line != null && activity.column != null && <span>Line {activity.line} · Col {activity.column}</span>}
                    {config.showRepository && activity.repository && <a className="maru-activity-panel-repository" href={activity.repository} target="_blank" rel="noreferrer noopener">View Repository ↗</a>}
                </div>
            )}
        </section>
    );
}
