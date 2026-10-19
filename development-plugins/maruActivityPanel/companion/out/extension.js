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
exports.activate = activate;
exports.deactivate = deactivate;
const node_crypto_1 = require("node:crypto");
const vscode = __importStar(require("vscode"));
const activity_1 = require("./activity");
const git_1 = require("./git");
const transport_1 = require("./transport");
const SECRET_KEY = "maruActivity.bridgeToken";
const DEBOUNCE_MS = 200;
function configuration() {
    const value = vscode.workspace.getConfiguration("maruActivity");
    return {
        enabled: value.get("enabled", true),
        port: (0, activity_1.validPort)(value.get("port")),
        idleSeconds: (0, activity_1.validIdleSeconds)(value.get("idleSeconds")),
        shareWorkspace: value.get("shareWorkspace", true),
        shareFile: value.get("shareFile", true),
        shareCursor: value.get("shareCursor", true),
        shareDuration: value.get("shareDuration", true),
        shareRepository: value.get("shareRepository", true)
    };
}
class Companion {
    context;
    model = new activity_1.ActivityModel((0, node_crypto_1.randomUUID)(), Date.now());
    repository = new git_1.RepositorySource(() => this.schedule(false));
    subscriptions = [];
    closing = new Set();
    transport;
    settings = configuration();
    token;
    debounce;
    heartbeat;
    idle;
    disposed = false;
    tokenGeneration = 0;
    transportGeneration = 0;
    storageWarning = false;
    constructor(context) {
        this.context = context;
        const interact = () => this.schedule(vscode.window.state.focused);
        this.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(interact), vscode.window.onDidChangeTextEditorSelection(event => {
            if (event.textEditor === vscode.window.activeTextEditor)
                interact();
        }), vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document === vscode.window.activeTextEditor?.document && event.contentChanges.length)
                interact();
        }), vscode.window.onDidChangeWindowState(state => {
            if (state.focused)
                this.model.interact(Date.now());
            this.publish();
        }), vscode.workspace.onDidChangeWorkspaceFolders(interact), vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("maruActivity"))
                this.configure();
        }), vscode.extensions.onDidChange(() => {
            if (this.settings.shareRepository)
                void this.repository.initialize();
        }), context.secrets.onDidChange(event => {
            if (event.key === SECRET_KEY)
                void this.loadToken();
        }), vscode.commands.registerCommand("maruActivity.pair", () => this.pair(false)), vscode.commands.registerCommand("maruActivity.rotateToken", () => this.pair(true)));
    }
    async start() {
        await this.loadToken();
        if (!this.disposed && this.settings.shareRepository)
            void this.repository.initialize();
    }
    async loadToken() {
        const generation = ++this.tokenGeneration;
        let token;
        try {
            token = await this.context.secrets.get(SECRET_KEY);
            this.storageWarning = false;
        }
        catch {
            if (!this.disposed && !this.storageWarning) {
                this.storageWarning = true;
                void vscode.window.showWarningMessage("Maru Activity could not access VS Code's secure token storage. Activity sharing is stopped. Retry Pair with Discord after restoring access to your system keychain.");
            }
        }
        if (this.disposed || generation !== this.tokenGeneration)
            return;
        const valid = token && /^[A-Za-z0-9_-]{32,256}$/.test(token) ? token : undefined;
        if (valid === this.token)
            return;
        this.token = valid;
        this.restartTransport();
    }
    async pair(replace) {
        if (this.disposed)
            return;
        try {
            let token = !replace ? await this.context.secrets.get(SECRET_KEY) : undefined;
            if (this.disposed)
                return;
            if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
                token = (0, node_crypto_1.randomBytes)(32).toString("base64url");
                await this.context.secrets.store(SECRET_KEY, token);
            }
            if (this.disposed)
                return;
            await vscode.env.clipboard.writeText(token);
            await this.loadToken();
            void vscode.window.showInformationMessage("Pairing token copied. Paste it into MaruActivityPanel's Bridge token setting in Discord. The token grants access to editor metadata; keep it private and clear your clipboard after pairing.");
        }
        catch {
            if (!this.disposed)
                void vscode.window.showWarningMessage("Maru Activity pairing could not be completed. Check access to VS Code's secure token storage and clipboard, then run Pair with Discord again.");
        }
    }
    configure() {
        const previous = this.settings;
        this.settings = configuration();
        if (previous.enabled !== this.settings.enabled || previous.port !== this.settings.port) {
            this.restartTransport();
        }
        else {
            this.publish();
        }
        if (this.settings.shareRepository)
            void this.repository.initialize();
    }
    closeTransport() {
        if (!this.transport)
            return;
        const pending = this.transport.dispose(this.model.unavailable(Date.now()));
        this.closing.add(pending);
        void pending.finally(() => this.closing.delete(pending));
        this.transport = undefined;
    }
    restartTransport() {
        const generation = ++this.transportGeneration;
        this.clearTimers();
        this.closeTransport();
        if (this.disposed || !this.settings.enabled || !this.token)
            return;
        // Finish a prior session withdrawal before publishing its replacement.
        void Promise.all(this.closing).then(() => {
            if (this.disposed || generation !== this.transportGeneration || !this.settings.enabled || !this.token)
                return;
            this.transport = new transport_1.LoopbackTransport(this.settings.port, this.token);
            this.heartbeat = setInterval(() => this.publish(), transport_1.HEARTBEAT_MS);
            this.heartbeat.unref();
            this.publish();
        });
    }
    snapshot() {
        const editor = vscode.window.activeTextEditor;
        const document = editor?.document;
        const folder = document ? vscode.workspace.getWorkspaceFolder(document.uri) : undefined;
        const fallbackFolder = vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined;
        const project = folder ?? fallbackFolder;
        const key = project?.uri.toString() ?? vscode.workspace.workspaceFile?.toString()
            ?? vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()).join("|") ?? "loose-files";
        return {
            workspaceKey: key,
            workspace: (0, activity_1.basenameLabel)(project?.name ?? vscode.workspace.name),
            focused: vscode.window.state.focused,
            editor: editor && document ? {
                file: (0, activity_1.basenameLabel)(document.uri.path) ?? "",
                language: document.languageId,
                line: editor.selection.active.line + 1,
                column: editor.selection.active.character + 1
            } : undefined,
            repository: this.settings.shareRepository ? this.repository.getRemote(document?.uri ?? project?.uri) : undefined
        };
    }
    schedule(interaction) {
        if (this.disposed)
            return;
        if (interaction)
            this.model.interact(Date.now());
        if (!this.transport)
            return;
        if (this.debounce)
            clearTimeout(this.debounce);
        this.debounce = setTimeout(() => { this.debounce = undefined; this.publish(); }, DEBOUNCE_MS);
        this.debounce.unref();
    }
    publish() {
        if (this.disposed || !this.transport)
            return;
        const now = Date.now();
        this.transport.publish(this.model.snapshot(this.snapshot(), this.settings, this.settings.idleSeconds, now));
        if (this.idle)
            clearTimeout(this.idle);
        this.idle = undefined;
        const remaining = this.model.idleDeadline(this.settings.idleSeconds) - now;
        if (remaining > 0 && vscode.window.state.focused && vscode.window.activeTextEditor) {
            this.idle = setTimeout(() => { this.idle = undefined; this.publish(); }, remaining);
            this.idle.unref();
        }
    }
    clearTimers() {
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        if (this.debounce)
            clearTimeout(this.debounce);
        if (this.idle)
            clearTimeout(this.idle);
        this.heartbeat = this.debounce = this.idle = undefined;
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.tokenGeneration++;
        this.clearTimers();
        this.repository.dispose();
        this.subscriptions.splice(0).forEach(subscription => subscription.dispose());
        this.closeTransport();
    }
    async shutdown() {
        this.dispose();
        await Promise.all(this.closing);
    }
}
let companion;
async function activate(context) {
    if (vscode.env.uiKind !== vscode.UIKind.Desktop)
        return;
    companion = new Companion(context);
    context.subscriptions.push(companion);
    await companion.start();
}
async function deactivate() {
    const current = companion;
    companion = undefined;
    await current?.shutdown();
}
