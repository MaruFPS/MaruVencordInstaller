/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function elapsedLabel(start: number, now = Date.now()) {
    const minutes = Math.max(0, Math.floor((now - start) / 60000));
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const languages: Record<string, [string, string, string]> = {
    typescript: ["TypeScript", "TS", "#3178c6"], typescriptreact: ["TypeScript React", "TSX", "#61dafb"],
    javascript: ["JavaScript", "JS", "#c9ae21"], javascriptreact: ["JavaScript React", "JSX", "#61dafb"],
    css: ["CSS", "CSS", "#8d73d8"], scss: ["SCSS", "Sass", "#cc6699"], less: ["Less", "Less", "#6b9bd2"],
    html: ["HTML", "HTML", "#e77b53"], json: ["JSON", "{}", "#c9ae21"], jsonc: ["JSON with Comments", "{}", "#c9ae21"],
    python: ["Python", "Py", "#78a8ce"], rust: ["Rust", "Rs", "#d99a80"], go: ["Go", "Go", "#00add8"],
    c: ["C", "C", "#88a9dc"], cpp: ["C++", "C++", "#88a9dc"], csharp: ["C#", "C#", "#ad83dc"],
    java: ["Java", "Java", "#dc9a4e"], kotlin: ["Kotlin", "Kt", "#b680ee"], swift: ["Swift", "Sw", "#f68b67"],
    markdown: ["Markdown", "MD", "#96afc2"], powershell: ["PowerShell", ">_", "#81a8eb"], shellscript: ["Shell", "$", "#8cc185"],
    yaml: ["YAML", "YML", "#df8d92"], sql: ["SQL", "SQL", "#8ab9df"], plaintext: ["Plain Text", "TXT", "#a6a8b0"]
};

export function languageInfo(id?: string): [string, string, string] {
    return id ? languages[id] ?? [id, "</>", "var(--text-muted)"] : ["Visual Studio Code", "</>", "var(--text-muted)"];
}
