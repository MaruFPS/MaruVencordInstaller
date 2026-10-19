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
exports.RepositorySource = void 0;
const vscode = __importStar(require("vscode"));
class RepositorySource {
    changed;
    git;
    subscriptions = [];
    repositorySubscriptions = [];
    disposed = false;
    initializing = false;
    linked = false;
    generation = 0;
    constructor(changed) {
        this.changed = changed;
    }
    async initialize() {
        if (this.disposed || this.initializing || this.linked)
            return;
        const extension = vscode.extensions.getExtension("vscode.git");
        if (!extension)
            return;
        const generation = ++this.generation;
        this.initializing = true;
        try {
            const exports = await extension.activate();
            if (this.disposed || generation !== this.generation)
                return;
            this.linked = true;
            this.subscriptions.push(exports.onDidChangeEnablement(() => {
                this.clearApi();
                if (exports.enabled)
                    this.attach(exports);
                this.changed();
            }));
            if (exports.enabled)
                this.attach(exports);
        }
        catch {
            // Git can be absent, disabled, or hosted remotely. Editor activity still works.
        }
        finally {
            this.initializing = false;
        }
    }
    attach(extension) {
        try {
            this.git = extension.getAPI(1);
            const rewire = () => { this.watchRepositories(); this.changed(); };
            this.repositorySubscriptions.push(this.git.onDidOpenRepository(rewire), this.git.onDidCloseRepository(rewire));
            this.watchRepositories();
            this.changed();
        }
        catch {
            this.git = undefined;
        }
    }
    stateSubscriptions = [];
    watchRepositories() {
        this.stateSubscriptions.splice(0).forEach(subscription => subscription.dispose());
        for (const repository of this.git?.repositories ?? []) {
            this.stateSubscriptions.push(repository.state.onDidChange(this.changed));
        }
    }
    getRemote(uri) {
        if (!uri || !this.git)
            return;
        const candidate = uri.toString();
        // Longest root wins for nested repositories. URI boundaries prevent prefix collisions.
        const repository = this.git.repositories.filter(repo => {
            const root = repo.rootUri.toString().replace(/\/+$/, "");
            return candidate === root || candidate.startsWith(`${root}/`);
        }).sort((left, right) => right.rootUri.toString().length - left.rootUri.toString().length)[0];
        const remote = repository?.state.remotes.find(remote => remote.name === "origin") ?? repository?.state.remotes[0];
        return remote?.fetchUrl ?? remote?.pushUrl;
    }
    clearApi() {
        this.git = undefined;
        this.repositorySubscriptions.splice(0).forEach(subscription => subscription.dispose());
        this.stateSubscriptions.splice(0).forEach(subscription => subscription.dispose());
    }
    dispose() {
        this.disposed = true;
        this.generation++;
        this.clearApi();
        this.subscriptions.splice(0).forEach(subscription => subscription.dispose());
    }
}
exports.RepositorySource = RepositorySource;
