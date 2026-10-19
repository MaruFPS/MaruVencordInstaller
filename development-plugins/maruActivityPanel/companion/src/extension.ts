/* SPDX-License-Identifier: GPL-3.0-or-later */

import { randomBytes, randomUUID } from "node:crypto";
import * as vscode from "vscode";

import { ActivityModel, basenameLabel, EditorSnapshot, Privacy, validIdleSeconds, validPort } from "./activity";
import { RepositorySource } from "./git";
import { HEARTBEAT_MS, LoopbackTransport } from "./transport";

const SECRET_KEY = "maruActivity.bridgeToken";
const DEBOUNCE_MS = 200;

interface Configuration extends Privacy {
    enabled: boolean;
    port: number;
    idleSeconds: number;
}

function configuration(): Configuration {
    const value = vscode.workspace.getConfiguration("maruActivity");
    return {
        enabled: value.get<boolean>("enabled", true),
        port: validPort(value.get("port")),
        idleSeconds: validIdleSeconds(value.get("idleSeconds")),
        shareWorkspace: value.get<boolean>("shareWorkspace", true),
        shareFile: value.get<boolean>("shareFile", true),
        shareCursor: value.get<boolean>("shareCursor", true),
        shareDuration: value.get<boolean>("shareDuration", true),
        shareRepository: value.get<boolean>("shareRepository", true)
    };
}

class Companion implements vscode.Disposable {
    private readonly model = new ActivityModel(randomUUID(), Date.now());
    private readonly repository = new RepositorySource(() => this.schedule(false));
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly closing = new Set<Promise<void>>();
    private transport: LoopbackTransport | undefined;
    private settings = configuration();
    private token: string | undefined;
    private debounce: NodeJS.Timeout | undefined;
    private heartbeat: NodeJS.Timeout | undefined;
    private idle: NodeJS.Timeout | undefined;
    private disposed = false;
    private tokenGeneration = 0;
    private transportGeneration = 0;
    private storageWarning = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        const interact = () => this.schedule(vscode.window.state.focused);
        this.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(interact),
            vscode.window.onDidChangeTextEditorSelection(event => {
                if (event.textEditor === vscode.window.activeTextEditor) interact();
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document === vscode.window.activeTextEditor?.document && event.contentChanges.length) interact();
            }),
            vscode.window.onDidChangeWindowState(state => {
                if (state.focused) this.model.interact(Date.now());
                this.publish();
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(interact),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration("maruActivity")) this.configure();
            }),
            vscode.extensions.onDidChange(() => {
                if (this.settings.shareRepository) void this.repository.initialize();
            }),
            context.secrets.onDidChange(event => {
                if (event.key === SECRET_KEY) void this.loadToken();
            }),
            vscode.commands.registerCommand("maruActivity.pair", () => this.pair(false)),
            vscode.commands.registerCommand("maruActivity.rotateToken", () => this.pair(true))
        );
    }

    async start(): Promise<void> {
        await this.loadToken();
        if (!this.disposed && this.settings.shareRepository) void this.repository.initialize();
    }

    private async loadToken(): Promise<void> {
        const generation = ++this.tokenGeneration;
        let token: string | undefined;
        try {
            token = await this.context.secrets.get(SECRET_KEY);
            this.storageWarning = false;
        } catch {
            if (!this.disposed && !this.storageWarning) {
                this.storageWarning = true;
                void vscode.window.showWarningMessage("Maru Activity could not access VS Code's secure token storage. Activity sharing is stopped. Retry Pair with Discord after restoring access to your system keychain.");
            }
        }
        if (this.disposed || generation !== this.tokenGeneration) return;
        const valid = token && /^[A-Za-z0-9_-]{32,256}$/.test(token) ? token : undefined;
        if (valid === this.token) return;
        this.token = valid;
        this.restartTransport();
    }

    private async pair(replace: boolean): Promise<void> {
        if (this.disposed) return;
        try {
            let token = !replace ? await this.context.secrets.get(SECRET_KEY) : undefined;
            if (this.disposed) return;
            if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
                token = randomBytes(32).toString("base64url");
                await this.context.secrets.store(SECRET_KEY, token);
            }
            if (this.disposed) return;
            await vscode.env.clipboard.writeText(token);
            await this.loadToken();
            void vscode.window.showInformationMessage("Pairing token copied. Paste it into MaruActivityPanel's Bridge token setting in Discord. The token grants access to editor metadata; keep it private and clear your clipboard after pairing.");
        } catch {
            if (!this.disposed) void vscode.window.showWarningMessage("Maru Activity pairing could not be completed. Check access to VS Code's secure token storage and clipboard, then run Pair with Discord again.");
        }
    }

    private configure(): void {
        const previous = this.settings;
        this.settings = configuration();
        if (previous.enabled !== this.settings.enabled || previous.port !== this.settings.port) {
            this.restartTransport();
        } else {
            this.publish();
        }
        if (this.settings.shareRepository) void this.repository.initialize();
    }

    private closeTransport(): void {
        if (!this.transport) return;
        const pending = this.transport.dispose(this.model.unavailable(Date.now()));
        this.closing.add(pending);
        void pending.finally(() => this.closing.delete(pending));
        this.transport = undefined;
    }

    private restartTransport(): void {
        const generation = ++this.transportGeneration;
        this.clearTimers();
        this.closeTransport();
        if (this.disposed || !this.settings.enabled || !this.token) return;
        // Finish a prior session withdrawal before publishing its replacement.
        void Promise.all(this.closing).then(() => {
            if (this.disposed || generation !== this.transportGeneration || !this.settings.enabled || !this.token) return;
            this.transport = new LoopbackTransport(this.settings.port, this.token);
            this.heartbeat = setInterval(() => this.publish(), HEARTBEAT_MS);
            this.heartbeat.unref();
            this.publish();
        });
    }

    private snapshot(): EditorSnapshot {
        const editor = vscode.window.activeTextEditor;
        const document = editor?.document;
        const folder = document ? vscode.workspace.getWorkspaceFolder(document.uri) : undefined;
        const fallbackFolder = vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined;
        const project = folder ?? fallbackFolder;
        const key = project?.uri.toString() ?? vscode.workspace.workspaceFile?.toString()
            ?? vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()).join("|") ?? "loose-files";
        return {
            workspaceKey: key,
            workspace: basenameLabel(project?.name ?? vscode.workspace.name),
            focused: vscode.window.state.focused,
            editor: editor && document ? {
                file: basenameLabel(document.uri.path) ?? "",
                language: document.languageId,
                line: editor.selection.active.line + 1,
                column: editor.selection.active.character + 1
            } : undefined,
            repository: this.settings.shareRepository ? this.repository.getRemote(document?.uri ?? project?.uri) : undefined
        };
    }

    private schedule(interaction: boolean): void {
        if (this.disposed) return;
        if (interaction) this.model.interact(Date.now());
        if (!this.transport) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => { this.debounce = undefined; this.publish(); }, DEBOUNCE_MS);
        this.debounce.unref();
    }

    private publish(): void {
        if (this.disposed || !this.transport) return;
        const now = Date.now();
        this.transport.publish(this.model.snapshot(this.snapshot(), this.settings, this.settings.idleSeconds, now));
        if (this.idle) clearTimeout(this.idle);
        this.idle = undefined;
        const remaining = this.model.idleDeadline(this.settings.idleSeconds) - now;
        if (remaining > 0 && vscode.window.state.focused && vscode.window.activeTextEditor) {
            this.idle = setTimeout(() => { this.idle = undefined; this.publish(); }, remaining);
            this.idle.unref();
        }
    }

    private clearTimers(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        if (this.debounce) clearTimeout(this.debounce);
        if (this.idle) clearTimeout(this.idle);
        this.heartbeat = this.debounce = this.idle = undefined;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.tokenGeneration++;
        this.clearTimers();
        this.repository.dispose();
        this.subscriptions.splice(0).forEach(subscription => subscription.dispose());
        this.closeTransport();
    }

    async shutdown(): Promise<void> {
        this.dispose();
        await Promise.all(this.closing);
    }
}

let companion: Companion | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    if (vscode.env.uiKind !== vscode.UIKind.Desktop) return;
    companion = new Companion(context);
    context.subscriptions.push(companion);
    await companion.start();
}

export async function deactivate(): Promise<void> {
    const current = companion;
    companion = undefined;
    await current?.shutdown();
}
