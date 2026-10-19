/* SPDX-License-Identifier: GPL-3.0-or-later */

import * as vscode from "vscode";

// A narrow structural subset of the built-in extension's versioned public API.
// Source: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
interface Repository {
    rootUri: vscode.Uri;
    state: {
        remotes: readonly { name: string; fetchUrl?: string; pushUrl?: string; }[];
        onDidChange: vscode.Event<void>;
    };
}
interface GitApi {
    repositories: readonly Repository[];
    onDidOpenRepository: vscode.Event<Repository>;
    onDidCloseRepository: vscode.Event<Repository>;
}
interface GitExtension {
    enabled: boolean;
    onDidChangeEnablement: vscode.Event<boolean>;
    getAPI(version: 1): GitApi;
}

export class RepositorySource implements vscode.Disposable {
    private git: GitApi | undefined;
    private subscriptions: vscode.Disposable[] = [];
    private repositorySubscriptions: vscode.Disposable[] = [];
    private disposed = false;
    private initializing = false;
    private linked = false;
    private generation = 0;

    constructor(private readonly changed: () => void) { }

    async initialize(): Promise<void> {
        if (this.disposed || this.initializing || this.linked) return;
        const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
        if (!extension) return;
        const generation = ++this.generation;
        this.initializing = true;
        try {
            const exports = await extension.activate();
            if (this.disposed || generation !== this.generation) return;
            this.linked = true;
            this.subscriptions.push(exports.onDidChangeEnablement(() => {
                this.clearApi();
                if (exports.enabled) this.attach(exports);
                this.changed();
            }));
            if (exports.enabled) this.attach(exports);
        } catch {
            // Git can be absent, disabled, or hosted remotely. Editor activity still works.
        } finally { this.initializing = false; }
    }

    private attach(extension: GitExtension): void {
        try {
            this.git = extension.getAPI(1);
            const rewire = () => { this.watchRepositories(); this.changed(); };
            this.repositorySubscriptions.push(this.git.onDidOpenRepository(rewire), this.git.onDidCloseRepository(rewire));
            this.watchRepositories();
            this.changed();
        } catch { this.git = undefined; }
    }

    private stateSubscriptions: vscode.Disposable[] = [];

    private watchRepositories(): void {
        this.stateSubscriptions.splice(0).forEach(subscription => subscription.dispose());
        for (const repository of this.git?.repositories ?? []) {
            this.stateSubscriptions.push(repository.state.onDidChange(this.changed));
        }
    }

    getRemote(uri: vscode.Uri | undefined): string | undefined {
        if (!uri || !this.git) return;
        const candidate = uri.toString();
        // Longest root wins for nested repositories. URI boundaries prevent prefix collisions.
        const repository = this.git.repositories.filter(repo => {
            const root = repo.rootUri.toString().replace(/\/+$/, "");
            return candidate === root || candidate.startsWith(`${root}/`);
        }).sort((left, right) => right.rootUri.toString().length - left.rootUri.toString().length)[0];
        const remote = repository?.state.remotes.find(remote => remote.name === "origin") ?? repository?.state.remotes[0];
        return remote?.fetchUrl ?? remote?.pushUrl;
    }

    private clearApi(): void {
        this.git = undefined;
        this.repositorySubscriptions.splice(0).forEach(subscription => subscription.dispose());
        this.stateSubscriptions.splice(0).forEach(subscription => subscription.dispose());
    }

    dispose(): void {
        this.disposed = true;
        this.generation++;
        this.clearApi();
        this.subscriptions.splice(0).forEach(subscription => subscription.dispose());
    }
}
