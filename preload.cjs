const { contextBridge, ipcRenderer } = require("electron"); 

contextBridge.exposeInMainWorld("maruInstaller", { 
    version: "0.2.0", 

    getAppRuntimeState: () => {
        return ipcRenderer.invoke(
            "get-app-runtime-state"
        );
    },

    detectDiscord: () => { 
        return ipcRenderer.invoke("detect-discord"); 
    }, 

    getDiscordPatchStates: () => { 
        return ipcRenderer.invoke( 
            "get-discord-patch-states" 
        ); 
    }, 

    getDiscordPatchDetails: () => { 
        return ipcRenderer.invoke( 
            "get-discord-patch-details" 
        ); 
    }, 

    getManagedUninstallStates: () => { 
        return ipcRenderer.invoke( 
            "get-managed-uninstall-states" 
        ); 
    }, 

    detectBuildEnvironment: () => { 
        return ipcRenderer.invoke("detect-build-environment"); 
    }, 

    getManagedToolchainState: () => {
        return ipcRenderer.invoke(
            "get-managed-toolchain-state"
        );
    },

    devSeedManagedNodeFromGlobal: () => {
        return ipcRenderer.invoke(
            "dev-seed-managed-node-from-global"
        );
    },

    devUpgradeManagedNodeSeedToVerified: () => {
        return ipcRenderer.invoke(
            "dev-upgrade-managed-node-seed-to-verified"
        );
    },

    devAcquireVencordSourceArchiveStaging: () => {
        return ipcRenderer.invoke(
            "dev-acquire-vencord-source-archive-staging"
        );
    },

    prepareManagedPnpmRuntime: () => {
        return ipcRenderer.invoke(
            "prepare-managed-pnpm-runtime"
        );
    },

    devPrepareIsolatedPortableNodeRuntime: () => {
        return ipcRenderer.invoke(
            "dev-prepare-isolated-portable-node-runtime"
        );
    },

    devRunIsolatedFreshInstallBuildTest: () => {
        return ipcRenderer.invoke(
            "dev-run-isolated-fresh-install-build-test"
        );
    },

    devRunIsolatedSetupCoordinatorTest: () => {
        return ipcRenderer.invoke(
            "dev-run-isolated-setup-coordinator-test"
        );
    },

    getManagedPaths: () => { 
        return ipcRenderer.invoke("get-managed-paths"); 
    }, 

    getManagedWorkspaceState: () => { 
        return ipcRenderer.invoke( 
            "get-managed-workspace-state" 
        ); 
    }, 

    getManagedVencordState: () => { 
        return ipcRenderer.invoke("get-managed-vencord-state"); 
    }, 

    getMaruPluginPresetState: () => {
        return ipcRenderer.invoke(
            "get-maru-plugin-preset-state"
        );
    },


    applyMaruPluginPreset: () => {
        return ipcRenderer.invoke(
            "apply-maru-plugin-preset"
        );
    },

    getMaruHybridThemeState: () => {
        return ipcRenderer.invoke(
            "get-maru-hybrid-theme-state"
        );
    },

    installMaruHybridTheme: () => {
        return ipcRenderer.invoke(
            "install-maru-hybrid-theme"
        );
    },

    getManagedVencordUpdateState: () => {
        return ipcRenderer.invoke(
            "get-managed-vencord-update-state"
        );
    },

    updateManagedVencord: () => {
        return ipcRenderer.invoke(
            "update-managed-vencord"
        );
    },

    cloneManagedVencord: () => { 
        return ipcRenderer.invoke("clone-managed-vencord"); 
    }, 

    getManagedUserPluginsState: () => { 
        return ipcRenderer.invoke( 
            "get-managed-userplugins-state" 
        ); 
    }, 

    ensureManagedUserPluginsDirectory: () => { 
        return ipcRenderer.invoke("ensure-managed-userplugins"); 
    }, 

    getBundledPluginsState: () => { 
        return ipcRenderer.invoke("get-bundled-plugins-state"); 
    }, 

    getManagedInstalledPluginsState: () => { 
        return ipcRenderer.invoke( 
            "get-managed-installed-plugins-state" 
        ); 
    }, 

    getMaruPluginUpdateState: () => {
        return ipcRenderer.invoke(
            "get-maru-plugin-update-state"
        );
    },

    updateMaruPlugins: () => {
        return ipcRenderer.invoke(
            "update-maru-plugins"
        );
    },

    installBundledPlugins: () => { 
        return ipcRenderer.invoke("install-bundled-plugins"); 
    }, 

    getManagedPackageManagerRequirement: () => { 
        return ipcRenderer.invoke( 
            "get-managed-package-manager-requirement" 
        ); 
    }, 

    verifyManagedPackageManager: () => { 
        return ipcRenderer.invoke( 
            "verify-managed-package-manager" 
        ); 
    }, 

    getManagedPluginDependenciesState: () => { 
        return ipcRenderer.invoke( 
            "get-managed-plugin-dependencies-state" 
        ); 
    }, 

    installManagedPluginDependencies: () => { 
        return ipcRenderer.invoke( 
            "install-managed-plugin-dependencies" 
        ); 
    }, 

    getManagedBuildState: () => { 
        return ipcRenderer.invoke( 
            "get-managed-build-state" 
        ); 
    }, 

    getManagedInstallPlan: discordName => {
        return ipcRenderer.invoke(
            "get-managed-install-plan",
            discordName
        );
    },

    getExternalVencordMigrationState: discordName => {
        return ipcRenderer.invoke(
            "get-external-vencord-migration-state",
            discordName
        );
    },

    backupExternalVencordUserData: discordName => {
        return ipcRenderer.invoke(
            "backup-external-vencord-user-data",
            discordName
        );
    },

    getExternalVencordBackupState: discordName => {
        return ipcRenderer.invoke(
            "get-external-vencord-backup-state",
            discordName
        );
    },

    migrateExternalVencord: discordName => {
        return ipcRenderer.invoke(
            "migrate-external-vencord",
            discordName
        );
    },

    runManagedInstallCoordinator: discordName => {
        return ipcRenderer.invoke(
            "run-managed-install-coordinator",
            discordName
        );
    },

    buildManagedVencord: () => { 
        return ipcRenderer.invoke( 
            "build-managed-vencord" 
        ); 
    }, 

    installManagedVencord: discordName => { 
        return ipcRenderer.invoke( 
            "install-managed-vencord", 
            discordName 
        ); 
    }, 

    repairManagedVencord: discordName => { 
        return ipcRenderer.invoke( 
            "repair-managed-vencord", 
            discordName 
        ); 
    }, 

    uninstallManagedVencord: discordName => { 
        return ipcRenderer.invoke( 
            "uninstall-managed-vencord", 
            discordName 
        ); 
    }, 

    openTwitchExtensionSetup: () => {
        return ipcRenderer.invoke(
            "open-twitch-extension-setup"
        );
    },

    openKickExtensionSetup: () => {
        return ipcRenderer.invoke(
            "open-kick-extension-setup"
        );
    },

    createManagedWorkspace: () => { 
        return ipcRenderer.invoke("create-managed-workspace"); 
    } 
});