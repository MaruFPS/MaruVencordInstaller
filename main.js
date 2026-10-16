import { app, BrowserWindow, ipcMain, shell } from "electron";
import { execFile } from "child_process";
import {
    cpSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync
} from "fs";
import {
    basename,
    dirname,
    join,
    normalize,
    relative,
    resolve
} from "path";
import * as https from "https";
import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import * as originalFs from "original-fs";
import { createCustomizationHunks, applyCustomizationHunks } from "./source-customizations.mjs";
import { Script } from "node:vm";
import { assessSourceOverrides, planSourceOverrides, applyApprovedOverrides, assessInstalledPlugins, assertSafePath, copyApprovedPlugin, listManagedPluginFiles, verifyObsoletePluginFile, removeObsoletePluginFile, ensureTrackedDirectory, removeCreatedEmptyDirectories, restoreBuildOutput, restoreUpdatedFile, validatePluginBundle, validateSourceOverrides, verifyUnchangedDestination } from "./resource-policy.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BUNDLE_POLICY = JSON.parse(readFileSync(join(__dirname, "bundle-policy.json"), "utf8"));

const VENCORD_REPO_URL =
    "https://github.com/Vendicated/Vencord";

const VENCORD_GITHUB_REPOSITORY =
    "Vendicated/Vencord";

const VENCORD_GITHUB_API_MAIN_COMMIT_URL =
    "https://api.github.com/repos/Vendicated/Vencord/commits/main";

const MARU_PLUGIN_PRESET_URL =
    "https://raw.githubusercontent.com/MaruFPS/MaruVencordInstaller/main/vencord/presets/maru-plugin-preset.json";

const MARU_PLUGIN_PRESET_VERSION =
    1;

const MARU_PLUGIN_PRESET_MAX_BYTES =
    64 * 1024;

const MARU_PLUGIN_PRESET_MAX_PLUGINS =
    200;

const TRUSTED_VENCORD_DOWNLOAD_HOSTS =
    new Set([
        "api.github.com",
        "github.com",
        "codeload.github.com",
        "objects.githubusercontent.com"
    ]);

const MAX_VENCORD_SOURCE_ARCHIVE_BYTES =
    100 * 1024 * 1024;

const MANAGED_VENCORD_SOURCE_METADATA_FILE =
    ".maru-managed-source.json";

const NPM_REGISTRY_HOST =
    "registry.npmjs.org";

const MAX_MANAGED_PNPM_ARCHIVE_BYTES =
    50 * 1024 * 1024;

const MANAGED_NODE_VERSION =
    "24.19.0";

const NODE_DISTRIBUTION_HOST =
    "nodejs.org";

const MAX_MANAGED_NODE_ARCHIVE_BYTES =
    100 * 1024 * 1024;

const MAX_NODE_SHASUMS_BYTES =
    1024 * 1024;

const INSTALLER_RESOURCE_DIRECTORIES =
    Object.freeze({
        bundledPlugins:
            "bundled-plugins",
        twitchExtension:
            "MaruTwitchPresence",
        kickExtension:
            "MaruKickPresence",
        sourceOverrides:
            "source-overrides",
        bundledThemes:
            "bundled-themes"
    });

const MARU_HYBRID_THEME_FILE =
    "TransparentHybrid.theme.css";

const MAX_MARU_HYBRID_THEME_BYTES =
    10 * 1024 * 1024;


function getInstallerResourceBase() {
    if (app.isPackaged) {
        const resourcesPath =
            typeof process.resourcesPath === "string"
                ? process.resourcesPath.trim()
                : "";

        if (!resourcesPath) {
            throw new Error(
                "Packaged installer resources path is unavailable."
            );
        }

        const root =
            resolve(
                resourcesPath
            );

        return {
            mode:
                "packaged",
            root,
            source:
                "electron-resources",
            appPath:
                app.getAppPath(),
            resourcesPath:
                root
        };
    }

    return {
        mode:
            "development",
        root:
            resolve(
                __dirname
            ),
        source:
            "project-directory",
        appPath:
            app.getAppPath(),
        resourcesPath:
            typeof process.resourcesPath === "string"
                ? process.resourcesPath
                : null
    };
}


function getInstallerResourceDirectory(
    resourceKey
) {
    if (
        !Object.prototype.hasOwnProperty.call(
            INSTALLER_RESOURCE_DIRECTORIES,
            resourceKey
        )
    ) {
        throw new Error(
            `Unknown installer resource key: ${resourceKey}`
        );
    }

    const base =
        getInstallerResourceBase();

    const directoryName =
        INSTALLER_RESOURCE_DIRECTORIES[
        resourceKey
        ];

    const target =
        resolve(
            base.root,
            directoryName
        );

    const expectedParent =
        normalize(
            base.root
        ).toLowerCase();

    const actualParent =
        normalize(
            dirname(
                target
            )
        ).toLowerCase();

    if (
        actualParent !==
        expectedParent
    ) {
        throw new Error(
            `Installer resource "${resourceKey}" failed path containment validation.`
        );
    }

    if (
        base.mode === "packaged"
    ) {
        const normalizedTarget =
            normalize(
                target
            ).toLowerCase();

        if (
            normalizedTarget.includes(
                ".asar\\"
            ) ||
            normalizedTarget.endsWith(
                ".asar"
            )
        ) {
            throw new Error(
                `Packaged installer resource "${resourceKey}" unexpectedly resolved inside an ASAR path.`
            );
        }
    }

    return {
        ...base,
        key:
            resourceKey,
        directoryName,
        path:
            target
    };
}


function getInstallerResourcesState() {
    const bundledPlugins =
        getInstallerResourceDirectory(
            "bundledPlugins"
        );

    const bundledThemes =
        getInstallerResourceDirectory(
            "bundledThemes"
        );

    const bundledPluginsExists =
        existsSync(
            bundledPlugins.path
        );

    const bundledPluginsDirectory =
        bundledPluginsExists
            ? statSync(
                bundledPlugins.path
            ).isDirectory()
            : false;

    const bundledThemesExists =
        existsSync(
            bundledThemes.path
        );

    const bundledThemesDirectory =
        bundledThemesExists
            ? statSync(
                bundledThemes.path
            ).isDirectory()
            : false;

    return {
        mode:
            bundledPlugins.mode,
        source:
            bundledPlugins.source,
        basePath:
            bundledPlugins.root,
        appPath:
            bundledPlugins.appPath,
        resourcesPath:
            bundledPlugins.resourcesPath,
        resources: {
            bundledPlugins: {
                path:
                    bundledPlugins.path,
                exists:
                    bundledPluginsExists,
                directory:
                    bundledPluginsDirectory
            },
            bundledThemes: {
                path:
                    bundledThemes.path,
                exists:
                    bundledThemesExists,
                directory:
                    bundledThemesDirectory
            }
        },
        packagingContract:
            bundledPlugins.mode === "packaged"
                ? "bundled-plugins and bundled-themes must be shipped as unpacked Electron extraResources under process.resourcesPath."
                : "bundled-plugins and bundled-themes are read from the project directory during development."
    };
}


const BUNDLED_PLUGIN_FILES = BUNDLE_POLICY.plugins;

function getMaruPluginInstallationAssessment(root) {
    try {
        return assessInstalledPlugins(root, BUNDLED_PLUGIN_FILES, BUNDLE_POLICY);
    } catch (error) {
        return { updateSafe: false, repairEligible: false, reason: error.message };
    }
}

const TWITCH_EXTENSION_FILES = [
    "manifest.json",
    "background.js",
    "twitch.js"
];

const KICK_EXTENSION_FILES = [
    "manifest.json",
    "background.js",
    "kick.js"
];

function assertTrustedMaruPluginPresetUrl(
    rawUrl
) {
    let parsed;

    try {
        parsed =
            new URL(
                rawUrl
            );
    } catch {
        throw new Error(
            "Maru plugin preset URL is invalid."
        );
    }

    const expected =
        new URL(
            MARU_PLUGIN_PRESET_URL
        );

    if (
        parsed.protocol !== "https:" ||
        parsed.hostname.toLowerCase() !==
        expected.hostname.toLowerCase() ||
        parsed.port !== expected.port ||
        parsed.pathname !== expected.pathname ||
        parsed.search !== "" ||
        parsed.hash !== "" ||
        parsed.username !== "" ||
        parsed.password !== ""
    ) {
        throw new Error(
            "Refusing Maru plugin preset request because the URL does not match the trusted GitHub preset location."
        );
    }

    return parsed;
}


function validateMaruPluginPreset(
    candidate
) {
    if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
    ) {
        throw new Error(
            "Maru plugin preset must be a JSON object."
        );
    }

    if (
        candidate.version !==
        MARU_PLUGIN_PRESET_VERSION
    ) {
        throw new Error(
            `Unsupported Maru plugin preset version: ${candidate.version ?? "missing"}. Expected version ${MARU_PLUGIN_PRESET_VERSION}.`
        );
    }

    if (!Array.isArray(candidate.plugins)) {
        throw new Error(
            "Maru plugin preset is missing its plugins array."
        );
    }

    if (
        candidate.plugins.length === 0 ||
        candidate.plugins.length >
        MARU_PLUGIN_PRESET_MAX_PLUGINS
    ) {
        throw new Error(
            `Maru plugin preset must contain between 1 and ${MARU_PLUGIN_PRESET_MAX_PLUGINS} plugins.`
        );
    }

    const plugins = [];
    const seen = new Set();

    for (const rawName of candidate.plugins) {
        if (typeof rawName !== "string") {
            throw new Error(
                "Maru plugin preset contains a non-string plugin name."
            );
        }

        const name =
            rawName.trim();

        if (
            name !== rawName ||
            !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(
                name
            )
        ) {
            throw new Error(
                `Maru plugin preset contains an invalid plugin name: ${JSON.stringify(rawName)}.`
            );
        }

        if (/API$/i.test(name)) {
            throw new Error(
                `Maru plugin preset contains internal/dependency plugin entry "${name}".`
            );
        }

        const key =
            name.toLowerCase();

        if (seen.has(key)) {
            throw new Error(
                `Maru plugin preset contains duplicate plugin entry "${name}".`
            );
        }

        seen.add(key);
        plugins.push(name);
    }

    return {
        version:
            candidate.version,
        plugins
    };
}


function fetchMaruPluginPresetJson() {
    return new Promise(
        (resolve, reject) => {
            const parsedUrl =
                assertTrustedMaruPluginPresetUrl(
                    MARU_PLUGIN_PRESET_URL
                );

            const request =
                https.request(
                    {
                        protocol:
                            parsedUrl.protocol,
                        hostname:
                            parsedUrl.hostname,
                        port:
                            parsedUrl.port || undefined,
                        path:
                            parsedUrl.pathname,
                        method:
                            "GET",
                        headers: {
                            "User-Agent":
                                "MaruVencordInstaller/0.1.0",
                            "Accept":
                                "application/json"
                        }
                    },
                    response => {
                        const statusCode =
                            response.statusCode ?? 0;

                        if (
                            statusCode < 200 ||
                            statusCode >= 300
                        ) {
                            response.resume();

                            reject(
                                new Error(
                                    `Maru plugin preset request failed with HTTP ${statusCode}.`
                                )
                            );

                            return;
                        }

                        const chunks = [];
                        let totalBytes = 0;

                        response.on(
                            "data",
                            chunk => {
                                totalBytes +=
                                    chunk.length;

                                if (
                                    totalBytes >
                                    MARU_PLUGIN_PRESET_MAX_BYTES
                                ) {
                                    request.destroy(
                                        new Error(
                                            "Maru plugin preset response exceeded the allowed size."
                                        )
                                    );

                                    return;
                                }

                                chunks.push(chunk);
                            }
                        );

                        response.on(
                            "end",
                            () => {
                                try {
                                    const body =
                                        Buffer.concat(
                                            chunks
                                        ).toString(
                                            "utf8"
                                        );

                                    resolve({
                                        json:
                                            JSON.parse(
                                                body
                                            ),
                                        bytes:
                                            totalBytes
                                    });
                                } catch (error) {
                                    reject(
                                        new Error(
                                            `Unable to parse Maru plugin preset JSON: ${error?.message ?? "Unknown JSON error."}`
                                        )
                                    );
                                }
                            }
                        );
                    }
                );

            request.on(
                "error",
                reject
            );

            request.setTimeout(
                15000,
                () => {
                    request.destroy(
                        new Error(
                            "Timed out while downloading the Maru plugin preset."
                        )
                    );
                }
            );

            request.end();
        }
    );
}


async function getMaruPluginPresetState() {
    try {
        const fetched =
            await fetchMaruPluginPresetJson();

        const preset =
            validateMaruPluginPreset(
                fetched.json
            );

        return {
            readOnly: true,
            available: true,
            state:
                "ready",
            version:
                preset.version,
            pluginCount:
                preset.plugins.length,
            plugins:
                preset.plugins,
            sourceUrl:
                MARU_PLUGIN_PRESET_URL,
            bytes:
                fetched.bytes,
            checkedAt:
                new Date().toISOString(),
            reason:
                "Remote Maru recommended plugin preset downloaded and validated. No Vencord settings were changed."
        };
    } catch (error) {
        return {
            readOnly: true,
            available: false,
            state:
                "unavailable",
            version:
                null,
            pluginCount:
                0,
            plugins:
                [],
            sourceUrl:
                MARU_PLUGIN_PRESET_URL,
            checkedAt:
                new Date().toISOString(),
            reason:
                error?.message ??
                "Unable to retrieve the Maru recommended plugin preset."
        };
    }
}


function getVencordRendererSettingsTarget() {
    const explicitVencordData =
        typeof process.env.VENCORD_USER_DATA_DIR === "string"
            ? process.env.VENCORD_USER_DATA_DIR.trim()
            : "";

    const discordUserData =
        typeof process.env.DISCORD_USER_DATA_DIR === "string"
            ? process.env.DISCORD_USER_DATA_DIR.trim()
            : "";

    const appData =
        typeof process.env.APPDATA === "string"
            ? process.env.APPDATA.trim()
            : "";

    let dataDirectory;
    let source;

    if (explicitVencordData) {
        dataDirectory =
            resolve(
                explicitVencordData
            );

        source =
            "VENCORD_USER_DATA_DIR";
    } else if (discordUserData) {
        dataDirectory =
            resolve(
                discordUserData,
                "..",
                "VencordData"
            );

        source =
            "DISCORD_USER_DATA_DIR";
    } else if (appData) {
        dataDirectory =
            resolve(
                appData,
                "Vencord"
            );

        source =
            "default";
    } else {
        throw new Error(
            "Unable to resolve the Vencord settings directory because APPDATA is unavailable."
        );
    }

    const settingsDirectory =
        join(
            dataDirectory,
            "settings"
        );

    const themesDirectory =
        join(
            dataDirectory,
            "themes"
        );

    const quickCssFile =
        join(
            settingsDirectory,
            "quickCss.css"
        );

    return {
        source,
        dataDirectory,
        settingsDirectory,
        themesDirectory,
        quickCssFile,
        settingsFile:
            join(
                settingsDirectory,
                "settings.json"
            )
    };
}


function getBundledMaruHybridThemeState() {
    const resource =
        getInstallerResourceDirectory(
            "bundledThemes"
        );

    const themePath =
        join(
            resource.path,
            MARU_HYBRID_THEME_FILE
        );

    if (!existsSync(resource.path)) {
        return {
            readOnly: true,
            available: false,
            complete: false,
            mode:
                resource.mode,
            root:
                resource.path,
            themePath,
            fileName:
                MARU_HYBRID_THEME_FILE,
            reason:
                `Bundled themes directory is missing: ${resource.path}`
        };
    }

    const rootStats =
        statSync(
            resource.path
        );

    if (!rootStats.isDirectory()) {
        return {
            readOnly: true,
            available: false,
            complete: false,
            mode:
                resource.mode,
            root:
                resource.path,
            themePath,
            fileName:
                MARU_HYBRID_THEME_FILE,
            reason:
                `Bundled themes path is not a directory: ${resource.path}`
        };
    }

    if (!existsSync(themePath)) {
        return {
            readOnly: true,
            available: false,
            complete: false,
            mode:
                resource.mode,
            root:
                resource.path,
            themePath,
            fileName:
                MARU_HYBRID_THEME_FILE,
            reason:
                `Bundled Maru Hybrid theme is missing: ${themePath}`
        };
    }

    const stats =
        statSync(
            themePath
        );

    if (
        !stats.isFile() ||
        stats.size <= 0
    ) {
        return {
            readOnly: true,
            available: false,
            complete: false,
            mode:
                resource.mode,
            root:
                resource.path,
            themePath,
            fileName:
                MARU_HYBRID_THEME_FILE,
            reason:
                "Bundled Maru Hybrid theme is not a regular non-empty file."
        };
    }

    if (
        stats.size >
        MAX_MARU_HYBRID_THEME_BYTES
    ) {
        return {
            readOnly: true,
            available: false,
            complete: false,
            mode:
                resource.mode,
            root:
                resource.path,
            themePath,
            fileName:
                MARU_HYBRID_THEME_FILE,
            bytes:
                stats.size,
            reason:
                `Bundled Maru Hybrid theme exceeds the ${MAX_MARU_HYBRID_THEME_BYTES}-byte safety limit.`
        };
    }

    return {
        readOnly: true,
        available: true,
        complete: true,
        mode:
            resource.mode,
        root:
            resource.path,
        themePath,
        fileName:
            MARU_HYBRID_THEME_FILE,
        bytes:
            stats.size,
        sha256:
            getFileSha256(
                themePath
            ),
        reason:
            "Bundled Maru Hybrid theme is ready."
    };
}


function inspectMaruHybridTargetFile(
    filePath,
    bundledSha256
) {
    if (!existsSync(filePath)) {
        return {
            path:
                filePath,
            exists: false,
            regularFile: false,
            bytes: 0,
            empty: true,
            sha256: null,
            matchesBundled: false
        };
    }

    const stats =
        statSync(
            filePath
        );

    if (!stats.isFile()) {
        return {
            path:
                filePath,
            exists: true,
            regularFile: false,
            bytes:
                stats.size ?? 0,
            empty: false,
            sha256: null,
            matchesBundled: false
        };
    }

    const sha256 =
        stats.size > 0
            ? getFileSha256(
                filePath
            )
            : null;

    return {
        path:
            filePath,
        exists: true,
        regularFile: true,
        bytes:
            stats.size,
        empty:
            stats.size === 0,
        sha256,
        matchesBundled:
            Boolean(
                sha256 &&
                bundledSha256 &&
                sha256.toLowerCase() ===
                bundledSha256.toLowerCase()
            )
    };
}


function getMaruHybridThemeState() {
    const bundled =
        getBundledMaruHybridThemeState();

    let target;

    try {
        target =
            getVencordRendererSettingsTarget();
    } catch (error) {
        return {
            readOnly: true,
            available: false,
            state:
                "target-unavailable",
            bundled,
            target: null,
            standalone: null,
            quickCss: null,
            reason:
                error?.message ??
                "Unable to resolve Vencord user-data paths for Maru Hybrid."
        };
    }

    const standalonePath =
        join(
            target.themesDirectory,
            MARU_HYBRID_THEME_FILE
        );

    const standalone =
        inspectMaruHybridTargetFile(
            standalonePath,
            bundled.sha256 ?? null
        );

    const quickCss =
        inspectMaruHybridTargetFile(
            target.quickCssFile,
            bundled.sha256 ?? null
        );

    const state =
        bundled.complete !== true
            ? "payload-unavailable"
            : standalone.matchesBundled &&
                quickCss.matchesBundled
                ? "installed"
                : standalone.exists ||
                    quickCss.exists
                    ? "partial-or-custom"
                    : "missing";

    return {
        readOnly: true,
        available:
            bundled.complete === true,
        state,
        bundled,
        target: {
            source:
                target.source,
            dataDirectory:
                target.dataDirectory,
            settingsDirectory:
                target.settingsDirectory,
            themesDirectory:
                target.themesDirectory,
            standaloneThemeFile:
                standalonePath,
            quickCssFile:
                target.quickCssFile
        },
        standalone,
        quickCss,
        reason:
            state === "installed"
                ? "Maru Hybrid is installed as both QuickCSS and a standalone theme."
                : state === "missing"
                    ? "Maru Hybrid is not installed in Vencord user data yet."
                    : state === "partial-or-custom"
                        ? "Vencord user data already contains QuickCSS and/or a Maru Hybrid theme file. Existing non-empty custom files will be preserved."
                        : bundled.reason
    };
}


function installMaruHybridTheme() {
    const bundled =
        getBundledMaruHybridThemeState();

    if (bundled.complete !== true) {
        throw new Error(
            bundled.reason ??
            "Bundled Maru Hybrid theme payload is unavailable."
        );
    }

    const target =
        getVencordRendererSettingsTarget();

    const standalonePath =
        join(
            target.themesDirectory,
            MARU_HYBRID_THEME_FILE
        );

    mkdirSync(
        target.themesDirectory,
        {
            recursive: true
        }
    );

    mkdirSync(
        target.settingsDirectory,
        {
            recursive: true
        }
    );

    const sourceContents =
        readFileSync(
            bundled.themePath,
            "utf8"
        );

    const provisionFile = (
        destinationPath,
        {
            allowEmptyOverwrite = false
        } = {}
    ) => {
        if (!existsSync(destinationPath)) {
            writeFileSync(
                destinationPath,
                sourceContents,
                {
                    encoding: "utf8",
                    flag: "wx"
                }
            );

            return {
                action:
                    "installed",
                path:
                    destinationPath
            };
        }

        const stats =
            statSync(
                destinationPath
            );

        if (!stats.isFile()) {
            throw new Error(
                `Refusing Maru Hybrid install because target is not a regular file: ${destinationPath}`
            );
        }

        if (
            stats.size > 0 &&
            getFileSha256(
                destinationPath
            ).toLowerCase() ===
            bundled.sha256.toLowerCase()
        ) {
            return {
                action:
                    "already-current",
                path:
                    destinationPath
            };
        }

        if (
            allowEmptyOverwrite &&
            stats.size === 0
        ) {
            writeFileSync(
                destinationPath,
                sourceContents,
                {
                    encoding: "utf8",
                    flag: "w"
                }
            );

            return {
                action:
                    "filled-empty-file",
                path:
                    destinationPath
            };
        }

        return {
            action:
                "preserved-existing",
            path:
                destinationPath
        };
    };

    const standalone =
        provisionFile(
            standalonePath
        );

    const quickCss =
        provisionFile(
            target.quickCssFile,
            {
                allowEmptyOverwrite: true
            }
        );

    const after =
        getMaruHybridThemeState();

    return {
        ok: true,
        state:
            after.state,
        bundledSha256:
            bundled.sha256,
        standalone,
        quickCss,
        target:
            after.target,
        standaloneThemeEnabled:
            false,
        settingsChanged:
            false,
        reason:
            quickCss.action === "preserved-existing"
                ? "Standalone Maru Hybrid provisioning completed. Existing non-empty QuickCSS was preserved exactly as-is."
                : standalone.action === "preserved-existing"
                    ? "QuickCSS provisioning completed. Existing standalone MaruHybrid.theme.css was preserved exactly as-is."
                    : "Maru Hybrid was provisioned for both beginner QuickCSS use and advanced standalone-theme use. The standalone theme was not enabled automatically."
    };
}


async function ensureDiscordFullyClosedForPresetApply() {
    const installs =
        detectDiscordInstalls();

    if (installs.length === 0) {
        throw new Error(
            "No Discord installation was detected."
        );
    }

    const states =
        await Promise.all(
            installs.map(
                async discord => ({
                    discord,
                    state:
                        await getDiscordRunningState(
                            discord
                        )
                })
            )
        );

    const running =
        states.filter(
            entry =>
                entry.state?.running === true
        );

    if (running.length > 0) {
        const names =
            running
                .map(entry =>
                    entry.discord.name
                )
                .join(", ");

        throw new Error(
            `Fully quit Discord from the system tray before applying the plugin preset. Closing the Discord window is not enough because Discord can keep running in the background and overwrite Vencord settings. Still running: ${names}.`
        );
    }

    return {
        checked:
            states.map(entry =>
                entry.discord.name
            ),
        allClosed: true
    };
}


function createMaruSettingsBackup(
    settingsFile,
    originalContents
) {
    const paths =
        getManagedPaths();

    if (!paths?.root) {
        throw new Error(
            "Unable to resolve the Maru installer workspace for the settings backup."
        );
    }

    const backupRoot =
        join(
            paths.root,
            "settings-backups"
        );

    mkdirSync(
        backupRoot,
        {
            recursive: true
        }
    );

    const timestamp =
        new Date()
            .toISOString()
            .replace(
                /[:.]/g,
                "-"
            );

    const backupPath =
        join(
            backupRoot,
            `vencord-settings-before-preset-${timestamp}.json`
        );

    writeFileSync(
        backupPath,
        originalContents,
        {
            encoding: "utf8",
            flag: "wx"
        }
    );

    return {
        backupPath,
        sourcePath:
            settingsFile,
        bytes:
            Buffer.byteLength(
                originalContents,
                "utf8"
            ),
        sha256:
            getFileSha256(
                backupPath
            )
    };
}


async function applyMaruPluginPreset() {
    const fetched =
        await fetchMaruPluginPresetJson();

    const preset =
        validateMaruPluginPreset(
            fetched.json
        );

    const discordState =
        await ensureDiscordFullyClosedForPresetApply();

    const target =
        getVencordRendererSettingsTarget();

    mkdirSync(
        target.settingsDirectory,
        {
            recursive: true
        }
    );

    const settingsAlreadyExisted =
        existsSync(
            target.settingsFile
        );

    let originalContents =
        null;

    let settings = {};

    if (settingsAlreadyExisted) {
        const stats =
            statSync(
                target.settingsFile
            );

        if (!stats.isFile()) {
            throw new Error(
                `Refusing preset apply because Vencord settings.json is not a regular file: ${target.settingsFile}`
            );
        }

        if (stats.size > 10 * 1024 * 1024) {
            throw new Error(
                "Refusing preset apply because Vencord settings.json is unexpectedly large."
            );
        }

        originalContents =
            readFileSync(
                target.settingsFile,
                "utf8"
            );

        try {
            settings =
                JSON.parse(
                    originalContents
                );
        } catch (error) {
            throw new Error(
                `Refusing preset apply because existing Vencord settings.json is invalid JSON: ${error?.message ?? "Unknown JSON error."}`
            );
        }

        if (
            !settings ||
            typeof settings !== "object" ||
            Array.isArray(settings)
        ) {
            throw new Error(
                "Refusing preset apply because existing Vencord settings.json is not a JSON object."
            );
        }
    }

    if (
        settings.plugins !== undefined &&
        (
            !settings.plugins ||
            typeof settings.plugins !== "object" ||
            Array.isArray(settings.plugins)
        )
    ) {
        throw new Error(
            "Refusing preset apply because the existing Vencord plugins settings value is not an object."
        );
    }

    const plugins =
        settings.plugins ?? {};

    settings.plugins =
        plugins;

    const newlyEnabled = [];
    const alreadyEnabled = [];

    for (const pluginName of preset.plugins) {
        const current =
            plugins[pluginName];

        if (
            current !== undefined &&
            (
                !current ||
                typeof current !== "object" ||
                Array.isArray(current)
            )
        ) {
            throw new Error(
                `Refusing preset apply because existing settings for plugin "${pluginName}" are not a JSON object.`
            );
        }

        if (current?.enabled === true) {
            alreadyEnabled.push(
                pluginName
            );

            continue;
        }

        plugins[pluginName] = {
            ...(current ?? {}),
            enabled: true
        };

        newlyEnabled.push(
            pluginName
        );
    }

    if (newlyEnabled.length === 0) {
        return {
            ok: true,
            state:
                "already-applied",
            version:
                preset.version,
            pluginCount:
                preset.plugins.length,
            newlyEnabled,
            alreadyEnabled,
            settingsPath:
                target.settingsFile,
            settingsSource:
                target.source,
            settingsAlreadyExisted,
            backupPath:
                null,
            discordChecked:
                discordState.checked,
            sourceUrl:
                MARU_PLUGIN_PRESET_URL,
            reason:
                `All ${preset.plugins.length} recommended plugins were already enabled. No Vencord settings file changes were needed.`
        };
    }

    let backup =
        null;

    if (settingsAlreadyExisted) {
        backup =
            createMaruSettingsBackup(
                target.settingsFile,
                originalContents
            );
    }

    const serialized =
        `${JSON.stringify(
            settings,
            null,
            4
        )}\n`;

    try {
        writeFileSync(
            target.settingsFile,
            serialized,
            {
                encoding: "utf8",
                flag:
                    settingsAlreadyExisted
                        ? "w"
                        : "wx"
            }
        );

        const verified =
            JSON.parse(
                readFileSync(
                    target.settingsFile,
                    "utf8"
                )
            );

        const missingEnabled =
            preset.plugins.filter(
                pluginName =>
                    verified?.plugins?.[pluginName]
                        ?.enabled !== true
            );

        if (missingEnabled.length > 0) {
            throw new Error(
                `Post-write verification failed for: ${missingEnabled.join(", ")}`
            );
        }
    } catch (error) {
        let rollbackMessage =
            "";

        try {
            if (
                settingsAlreadyExisted &&
                backup?.backupPath &&
                existsSync(
                    backup.backupPath
                )
            ) {
                writeFileSync(
                    target.settingsFile,
                    readFileSync(
                        backup.backupPath,
                        "utf8"
                    ),
                    "utf8"
                );

                rollbackMessage =
                    " Original settings were restored from the backup.";
            } else if (
                !settingsAlreadyExisted &&
                existsSync(
                    target.settingsFile
                )
            ) {
                rmSync(
                    target.settingsFile,
                    {
                        force: true
                    }
                );

                rollbackMessage =
                    " The newly created settings file was removed.";
            }
        } catch (rollbackError) {
            throw new Error(
                `Plugin preset apply failed: ${error?.message ?? "Unknown error."} Rollback also failed: ${rollbackError?.message ?? "Unknown rollback error."}`
            );
        }

        throw new Error(
            `Plugin preset apply failed: ${error?.message ?? "Unknown error."}${rollbackMessage}`
        );
    }

    return {
        ok: true,
        state:
            "applied",
        version:
            preset.version,
        pluginCount:
            preset.plugins.length,
        newlyEnabled,
        alreadyEnabled,
        settingsPath:
            target.settingsFile,
        settingsSource:
            target.source,
        settingsAlreadyExisted,
        backupPath:
            backup?.backupPath ?? null,
        backupSha256:
            backup?.sha256 ?? null,
        discordChecked:
            discordState.checked,
        sourceUrl:
            MARU_PLUGIN_PRESET_URL,
        reason:
            `Enabled ${newlyEnabled.length} recommended plugin${newlyEnabled.length === 1 ? "" : "s"} while preserving existing plugin settings and non-preset plugins.`
    };
}


function assertTrustedVencordHttpsUrl(
    rawUrl
) {
    let parsed;

    try {
        parsed =
            new URL(
                rawUrl
            );
    } catch {
        throw new Error(
            `Refusing Vencord source request: invalid URL "${rawUrl}".`
        );
    }

    if (parsed.protocol !== "https:") {
        throw new Error(
            `Refusing Vencord source request: HTTPS is required for ${parsed.href}.`
        );
    }

    if (
        !TRUSTED_VENCORD_DOWNLOAD_HOSTS.has(
            parsed.hostname.toLowerCase()
        )
    ) {
        throw new Error(
            `Refusing Vencord source request: untrusted host "${parsed.hostname}".`
        );
    }

    return parsed;
}


function getGithubRequestOptions(
    parsedUrl
) {
    return {
        protocol:
            parsedUrl.protocol,
        hostname:
            parsedUrl.hostname,
        port:
            parsedUrl.port || undefined,
        path:
            `${parsedUrl.pathname}${parsedUrl.search}`,
        method:
            "GET",
        headers: {
            "User-Agent":
                "MaruVencordInstaller/0.1.0",
            "Accept":
                "application/vnd.github+json"
        }
    };
}


function getTrustedGithubJson(
    rawUrl,
    redirectsRemaining = 5
) {
    return new Promise(
        (resolve, reject) => {
            const parsedUrl =
                assertTrustedVencordHttpsUrl(
                    rawUrl
                );

            const request =
                https.request(
                    getGithubRequestOptions(
                        parsedUrl
                    ),
                    response => {
                        const statusCode =
                            response.statusCode ?? 0;

                        if (
                            statusCode >= 300 &&
                            statusCode < 400 &&
                            response.headers.location
                        ) {
                            response.resume();

                            if (
                                redirectsRemaining <= 0
                            ) {
                                reject(
                                    new Error(
                                        "Too many redirects while resolving Vencord source metadata."
                                    )
                                );

                                return;
                            }

                            const redirectUrl =
                                new URL(
                                    response.headers.location,
                                    parsedUrl
                                ).href;

                            getTrustedGithubJson(
                                redirectUrl,
                                redirectsRemaining - 1
                            )
                                .then(resolve)
                                .catch(reject);

                            return;
                        }

                        if (
                            statusCode < 200 ||
                            statusCode >= 300
                        ) {
                            response.resume();

                            reject(
                                new Error(
                                    `GitHub metadata request failed with HTTP ${statusCode}.`
                                )
                            );

                            return;
                        }

                        const chunks = [];
                        let totalBytes = 0;
                        const maxBytes =
                            2 * 1024 * 1024;

                        response.on(
                            "data",
                            chunk => {
                                totalBytes +=
                                    chunk.length;

                                if (
                                    totalBytes >
                                    maxBytes
                                ) {
                                    request.destroy(
                                        new Error(
                                            "GitHub metadata response exceeded the allowed size."
                                        )
                                    );

                                    return;
                                }

                                chunks.push(
                                    chunk
                                );
                            }
                        );

                        response.on(
                            "end",
                            () => {
                                try {
                                    const body =
                                        Buffer.concat(
                                            chunks
                                        ).toString(
                                            "utf8"
                                        );

                                    resolve(
                                        JSON.parse(
                                            body
                                        )
                                    );
                                } catch (error) {
                                    reject(
                                        new Error(
                                            `Unable to parse GitHub Vencord metadata: ${error?.message ?? "Unknown JSON error."}`
                                        )
                                    );
                                }
                            }
                        );
                    }
                );

            request.on(
                "error",
                reject
            );

            request.setTimeout(
                30000,
                () => {
                    request.destroy(
                        new Error(
                            "Timed out while resolving Vencord source metadata."
                        )
                    );
                }
            );

            request.end();
        }
    );
}


async function resolveTrustedVencordMainCommit() {
    const metadata =
        await getTrustedGithubJson(
            VENCORD_GITHUB_API_MAIN_COMMIT_URL
        );

    const commit =
        typeof metadata?.sha === "string"
            ? metadata.sha.trim()
            : "";

    if (
        !/^[0-9a-f]{40}$/i.test(
            commit
        )
    ) {
        throw new Error(
            "GitHub did not return a valid 40-character Vencord main commit SHA."
        );
    }

    const repositoryFullName =
        typeof metadata?.html_url === "string" &&
            metadata.html_url.includes(
                "/Vendicated/Vencord/"
            )
            ? VENCORD_GITHUB_REPOSITORY
            : null;

    if (
        repositoryFullName !==
        VENCORD_GITHUB_REPOSITORY
    ) {
        throw new Error(
            "GitHub metadata did not identify the trusted Vendicated/Vencord repository."
        );
    }

    return {
        repository:
            VENCORD_GITHUB_REPOSITORY,
        commit:
            commit.toLowerCase(),
        htmlUrl:
            metadata.html_url ?? null,
        archiveUrl:
            `https://github.com/Vendicated/Vencord/archive/${commit}.zip`
    };
}


async function resolveTrustedVencordRepairCommit(commit) {
    if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("Repair source requires an exact trusted commit identity.");
    const metadata = await getTrustedGithubJson(`https://api.github.com/repos/${VENCORD_GITHUB_REPOSITORY}/commits/${commit}`);
    if (metadata?.sha?.toLowerCase() !== commit || !metadata?.html_url?.startsWith("https://github.com/Vendicated/Vencord/"))
        throw new Error("GitHub did not verify the recorded installed Vencord commit.");
    return { repository: VENCORD_GITHUB_REPOSITORY, commit, htmlUrl: metadata.html_url, archiveUrl: `https://github.com/Vendicated/Vencord/archive/${commit}.zip` };
}


function downloadTrustedVencordArchive(
    rawUrl,
    destinationPath,
    redirectsRemaining = 5
) {
    return new Promise(
        (resolve, reject) => {
            const parsedUrl =
                assertTrustedVencordHttpsUrl(
                    rawUrl
                );

            const request =
                https.request(
                    {
                        ...getGithubRequestOptions(
                            parsedUrl
                        ),
                        headers: {
                            "User-Agent":
                                "MaruVencordInstaller/0.1.0",
                            "Accept":
                                "application/zip, application/octet-stream"
                        }
                    },
                    response => {
                        const statusCode =
                            response.statusCode ?? 0;

                        if (
                            statusCode >= 300 &&
                            statusCode < 400 &&
                            response.headers.location
                        ) {
                            response.resume();

                            if (
                                redirectsRemaining <= 0
                            ) {
                                reject(
                                    new Error(
                                        "Too many redirects while downloading the Vencord source archive."
                                    )
                                );

                                return;
                            }

                            const redirectUrl =
                                new URL(
                                    response.headers.location,
                                    parsedUrl
                                ).href;

                            downloadTrustedVencordArchive(
                                redirectUrl,
                                destinationPath,
                                redirectsRemaining - 1
                            )
                                .then(resolve)
                                .catch(reject);

                            return;
                        }

                        if (
                            statusCode < 200 ||
                            statusCode >= 300
                        ) {
                            response.resume();

                            reject(
                                new Error(
                                    `Vencord source archive download failed with HTTP ${statusCode}.`
                                )
                            );

                            return;
                        }

                        let totalBytes = 0;

                        const output =
                            createWriteStream(
                                destinationPath,
                                {
                                    flags: "wx"
                                }
                            );

                        const fail = error => {
                            output.destroy();
                            request.destroy();

                            reject(
                                error instanceof Error
                                    ? error
                                    : new Error(
                                        String(
                                            error
                                        )
                                    )
                            );
                        };

                        output.on(
                            "error",
                            fail
                        );

                        response.on(
                            "error",
                            fail
                        );

                        response.on(
                            "data",
                            chunk => {
                                totalBytes +=
                                    chunk.length;

                                if (
                                    totalBytes >
                                    MAX_VENCORD_SOURCE_ARCHIVE_BYTES
                                ) {
                                    fail(
                                        new Error(
                                            `Vencord source archive exceeded the ${MAX_VENCORD_SOURCE_ARCHIVE_BYTES}-byte safety limit.`
                                        )
                                    );
                                }
                            }
                        );

                        output.on(
                            "finish",
                            () => {
                                output.close(
                                    () => {
                                        resolve({
                                            finalUrl:
                                                parsedUrl.href,
                                            bytes:
                                                totalBytes
                                        });
                                    }
                                );
                            }
                        );

                        response.pipe(
                            output
                        );
                    }
                );

            request.on(
                "error",
                reject
            );

            request.setTimeout(
                120000,
                () => {
                    request.destroy(
                        new Error(
                            "Timed out while downloading the Vencord source archive."
                        )
                    );
                }
            );

            request.end();
        }
    );
}


function escapePowerShellSingleQuotedString(
    value
) {
    return String(value)
        .replace(
            /'/g,
            "''"
        );
}


function extractZipWithWindowsPowerShell(
    archivePath,
    destinationPath
) {
    return new Promise(
        (resolve, reject) => {
            const systemRoot =
                process.env.SystemRoot ||
                "C:\\Windows";

            const bundledPowerShell =
                join(
                    systemRoot,
                    "System32",
                    "WindowsPowerShell",
                    "v1.0",
                    "powershell.exe"
                );

            const powershellExecutable =
                existsSync(
                    bundledPowerShell
                )
                    ? bundledPowerShell
                    : "powershell.exe";

            const escapedArchive =
                escapePowerShellSingleQuotedString(
                    archivePath
                );

            const escapedDestination =
                escapePowerShellSingleQuotedString(
                    destinationPath
                );

            const command =
                `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}'`;

            execFile(
                powershellExecutable,
                [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    command
                ],
                {
                    windowsHide: true,
                    timeout: 120000
                },
                (
                    error,
                    stdout,
                    stderr
                ) => {
                    if (error) {
                        reject(
                            new Error(
                                stderr?.trim?.() ||
                                stdout?.trim?.() ||
                                error.message ||
                                "Windows PowerShell failed to extract the Vencord source archive."
                            )
                        );

                        return;
                    }

                    resolve({
                        executable:
                            powershellExecutable,
                        output:
                            stdout?.trim?.() ?? "",
                        warnings:
                            stderr?.trim?.() ?? ""
                    });
                }
            );
        }
    );
}


function validateStagedVencordSource(
    extractedRoot
) {
    const entries =
        readdirSync(
            extractedRoot,
            {
                withFileTypes: true
            }
        )
            .filter(entry =>
                !entry.name.startsWith(
                    "."
                )
            );

    const directories =
        entries.filter(
            entry =>
                entry.isDirectory()
        );

    if (
        directories.length !== 1
    ) {
        throw new Error(
            `Expected exactly one top-level directory in the Vencord source archive, found ${directories.length}.`
        );
    }

    const sourceRoot =
        join(
            extractedRoot,
            directories[0].name
        );

    const requiredEntries = [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        join(
            "scripts",
            "runInstaller.mjs"
        ),
        "src"
    ];

    for (
        const relativePath of
        requiredEntries
    ) {
        const candidate =
            join(
                sourceRoot,
                relativePath
            );

        if (!existsSync(candidate)) {
            throw new Error(
                `Staged Vencord source is missing required path: ${relativePath}`
            );
        }
    }

    const packagePath =
        join(
            sourceRoot,
            "package.json"
        );

    let packageJson;

    try {
        packageJson =
            JSON.parse(
                readFileSync(
                    packagePath,
                    "utf8"
                )
            );
    } catch (error) {
        throw new Error(
            `Staged Vencord package.json is invalid: ${error?.message ?? "Unknown JSON error."}`
        );
    }

    if (
        packageJson?.name !== "vencord"
    ) {
        throw new Error(
            `Staged source package name is "${packageJson?.name ?? "missing"}", expected "vencord".`
        );
    }

    const repositoryUrl =
        typeof packageJson?.repository === "string"
            ? packageJson.repository
            : packageJson?.repository?.url;

    if (
        typeof repositoryUrl !== "string" ||
        !repositoryUrl.includes(
            "github.com/Vendicated/Vencord"
        )
    ) {
        throw new Error(
            "Staged Vencord package.json does not identify the trusted Vendicated/Vencord repository."
        );
    }

    if (
        typeof packageJson?.packageManager !== "string" ||
        !/^pnpm@\d+\.\d+\.\d+/.test(
            packageJson.packageManager
        )
    ) {
        throw new Error(
            "Staged Vencord package.json does not declare a supported pnpm packageManager."
        );
    }

    return {
        sourceRoot,
        packagePath,
        version:
            packageJson.version ?? null,
        packageManager:
            packageJson.packageManager,
        repositoryUrl
    };
}


async function acquireVencordSourceArchiveToStaging({ commit = null } = {}) {
    const paths =
        getManagedPaths();

    if (!paths?.root) {
        throw new Error(
            "Managed workspace path is unavailable."
        );
    }

    const managedVencordPath =
        normalize(
            paths.vencord
        ).toLowerCase();

    const acquisitionRoot =
        join(
            paths.root,
            "source-acquisition"
        );

    mkdirSync(
        acquisitionRoot,
        {
            recursive: true
        }
    );

    const timestamp =
        new Date()
            .toISOString()
            .replace(
                /[:.]/g,
                "-"
            );

    const stagingRoot =
        join(
            acquisitionRoot,
            timestamp
        );

    if (existsSync(stagingRoot)) {
        throw new Error(
            `Refusing source acquisition: staging path already exists: ${stagingRoot}`
        );
    }

    mkdirSync(
        stagingRoot,
        {
            recursive: false
        }
    );

    const archivePath =
        join(
            stagingRoot,
            "Vencord-source.zip"
        );

    const extractedRoot =
        join(
            stagingRoot,
            "extracted"
        );

    mkdirSync(
        extractedRoot,
        {
            recursive: false
        }
    );

    const resolvedCommit =
        commit ? await resolveTrustedVencordRepairCommit(commit) : await resolveTrustedVencordMainCommit();

    const download =
        await downloadTrustedVencordArchive(
            resolvedCommit.archiveUrl,
            archivePath
        );

    if (
        !existsSync(
            archivePath
        ) ||
        statSync(
            archivePath
        ).size <= 0
    ) {
        throw new Error(
            "Downloaded Vencord source archive is missing or empty."
        );
    }

    const archiveHeader =
        readFileSync(
            archivePath,
            {
                encoding: null,
                flag: "r"
            }
        ).subarray(
            0,
            4
        );

    if (
        archiveHeader.length < 2 ||
        archiveHeader[0] !== 0x50 ||
        archiveHeader[1] !== 0x4b
    ) {
        throw new Error(
            "Downloaded Vencord source file does not have a valid ZIP signature."
        );
    }

    const archiveSha256 =
        getFileSha256(
            archivePath
        );

    const extraction =
        await extractZipWithWindowsPowerShell(
            archivePath,
            extractedRoot
        );

    const validation =
        validateStagedVencordSource(
            extractedRoot
        );

    const stagedSourceNormalized =
        normalize(
            validation.sourceRoot
        ).toLowerCase();

    if (
        stagedSourceNormalized ===
        managedVencordPath ||
        stagedSourceNormalized.startsWith(
            `${managedVencordPath}\\`
        ) ||
        stagedSourceNormalized.startsWith(
            `${managedVencordPath}/`
        )
    ) {
        throw new Error(
            "Refusing source acquisition: staged source unexpectedly overlaps the current managed Vencord repository."
        );
    }

    const manifestPath =
        join(
            stagingRoot,
            "source-acquisition-manifest.json"
        );

    const manifest = {
        createdAt:
            new Date()
                .toISOString(),
        repository:
            resolvedCommit.repository,
        commit:
            resolvedCommit.commit,
        metadataUrl:
            VENCORD_GITHUB_API_MAIN_COMMIT_URL,
        requestedArchiveUrl:
            resolvedCommit.archiveUrl,
        finalArchiveUrl:
            download.finalUrl,
        archivePath,
        archiveBytes:
            statSync(
                archivePath
            ).size,
        archiveSha256,
        extractedRoot,
        stagedSourceRoot:
            validation.sourceRoot,
        package: {
            name:
                "vencord",
            version:
                validation.version,
            packageManager:
                validation.packageManager,
            repositoryUrl:
                validation.repositoryUrl
        },
        extraction: {
            method:
                "Windows PowerShell Expand-Archive",
            executable:
                extraction.executable
        },
        currentManagedVencordPath:
            paths.vencord,
        currentManagedVencordUntouched:
            true
    };

    writeFileSync(
        manifestPath,
        JSON.stringify(
            manifest,
            null,
            2
        ),
        "utf8"
    );

    return {
        ok: true,
        state: "staged",
        repository:
            resolvedCommit.repository,
        commit:
            resolvedCommit.commit,
        stagingRoot,
        archivePath,
        archiveBytes:
            manifest.archiveBytes,
        archiveSha256,
        extractedRoot,
        stagedSourceRoot:
            validation.sourceRoot,
        packageManager:
            validation.packageManager,
        version:
            validation.version,
        manifestPath,
        currentManagedVencordPath:
            paths.vencord,
        currentManagedVencordUntouched:
            true,
        reason:
            "Trusted Vencord source was resolved to an exact GitHub commit, downloaded, extracted, and validated in an isolated staging directory. The current managed Vencord repository was not modified."
    };
}


function isPathInsideOrSame(
    parentPath,
    childPath
) {
    const parent =
        resolve(
            parentPath
        ).toLowerCase();

    const child =
        resolve(
            childPath
        ).toLowerCase();

    return (
        child === parent ||
        child.startsWith(
            `${parent}\\`
        ) ||
        child.startsWith(
            `${parent}/`
        )
    );
}


function getFileManifestTreeSha256(
    files
) {
    const hash =
        createHash(
            "sha256"
        );

    for (const file of files) {
        hash.update(
            file.path
        );

        hash.update(
            "\0"
        );

        hash.update(
            String(
                file.size
            )
        );

        hash.update(
            "\0"
        );

        hash.update(
            file.sha256
        );

        hash.update(
            "\n"
        );
    }

    return hash.digest(
        "hex"
    );
}


function inspectStagedVencordSourceCandidate(
    stagingRoot,
    acquisitionRoot
) {
    const resolvedStagingRoot =
        resolve(
            stagingRoot
        );

    const resolvedAcquisitionRoot =
        resolve(
            acquisitionRoot
        );

    const manifestPath =
        join(
            resolvedStagingRoot,
            "source-acquisition-manifest.json"
        );

    if (
        !isPathInsideOrSame(
            resolvedAcquisitionRoot,
            resolvedStagingRoot
        ) ||
        resolvedStagingRoot.toLowerCase() ===
        resolvedAcquisitionRoot.toLowerCase()
    ) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                "Staging directory is outside the managed source-acquisition root."
        };
    }

    if (
        !existsSync(
            manifestPath
        )
    ) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                "Source acquisition manifest is missing."
        };
    }

    let manifest;

    try {
        manifest =
            JSON.parse(
                readFileSync(
                    manifestPath,
                    "utf8"
                )
            );
    } catch (error) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                `Source acquisition manifest is invalid JSON: ${error?.message ?? "Unknown JSON error."}`
        };
    }

    if (
        manifest?.repository !==
        VENCORD_GITHUB_REPOSITORY
    ) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                "Source acquisition manifest does not identify the trusted Vendicated/Vencord repository."
        };
    }

    const commit =
        typeof manifest?.commit === "string"
            ? manifest.commit.trim()
            : "";

    if (
        !/^[0-9a-f]{40}$/i.test(
            commit
        )
    ) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                "Source acquisition manifest does not contain a valid Vencord commit SHA."
        };
    }

    if (
        typeof manifest?.archivePath !== "string" ||
        typeof manifest?.archiveSha256 !== "string" ||
        typeof manifest?.extractedRoot !== "string" ||
        typeof manifest?.stagedSourceRoot !== "string"
    ) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                "Source acquisition manifest is missing required staging paths or archive hash metadata."
        };
    }

    const archivePath =
        resolve(
            manifest.archivePath
        );

    const extractedRoot =
        resolve(
            manifest.extractedRoot
        );

    const stagedSourceRoot =
        resolve(
            manifest.stagedSourceRoot
        );

    if (
        !isPathInsideOrSame(
            resolvedStagingRoot,
            archivePath
        ) ||
        !isPathInsideOrSame(
            resolvedStagingRoot,
            extractedRoot
        ) ||
        !isPathInsideOrSame(
            extractedRoot,
            stagedSourceRoot
        )
    ) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                "Source acquisition manifest contains a path outside its isolated staging directory."
        };
    }

    if (
        !isRegularNonEmptyFile(
            archivePath
        )
    ) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                "Staged Vencord source archive is missing or empty."
        };
    }

    const archiveStats =
        statSync(
            archivePath
        );

    if (
        Number.isFinite(
            manifest.archiveBytes
        ) &&
        manifest.archiveBytes !==
        archiveStats.size
    ) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                "Staged Vencord source archive size no longer matches its acquisition manifest."
        };
    }

    const archiveSha256 =
        getFileSha256(
            archivePath
        );

    if (
        archiveSha256.toLowerCase() !==
        manifest.archiveSha256
            .toLowerCase()
    ) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                "Staged Vencord source archive SHA-256 no longer matches its acquisition manifest."
        };
    }

    let validation;

    try {
        validation =
            validateStagedVencordSource(
                extractedRoot
            );
    } catch (error) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                error?.message ??
                "Staged Vencord source validation failed."
        };
    }

    if (
        resolve(
            validation.sourceRoot
        ).toLowerCase() !==
        stagedSourceRoot.toLowerCase()
    ) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                "Validated Vencord source root no longer matches the acquisition manifest."
        };
    }

    if (
        manifest?.package?.name !==
        "vencord" ||
        manifest?.package?.packageManager !==
        validation.packageManager ||
        manifest?.package?.repositoryUrl !==
        validation.repositoryUrl
    ) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                "Staged Vencord package metadata no longer matches its acquisition manifest."
        };
    }

    let sourceFiles;

    try {
        sourceFiles =
            getBackupFileManifest(
                stagedSourceRoot
            );
    } catch (error) {
        return {
            valid: false,
            stagingRoot:
                resolvedStagingRoot,
            manifestPath,
            reason:
                `Unable to hash staged Vencord source files: ${error?.message ?? "Unknown file inspection error."}`
        };
    }

    const createdAt =
        typeof manifest?.createdAt === "string"
            ? manifest.createdAt
            : null;

    const parsedCreatedAt =
        Date.parse(
            createdAt ?? ""
        );

    return {
        valid: true,
        stagingRoot:
            resolvedStagingRoot,
        manifestPath:
            resolve(
                manifestPath
            ),
        manifest,
        commit:
            commit.toLowerCase(),
        archivePath,
        archiveBytes:
            archiveStats.size,
        archiveSha256,
        extractedRoot,
        stagedSourceRoot,
        validation,
        sourceFiles,
        sourceFileCount:
            sourceFiles.length,
        sourceBytes:
            sourceFiles.reduce(
                (total, file) =>
                    total + file.size,
                0
            ),
        sourceTreeSha256:
            getFileManifestTreeSha256(
                sourceFiles
            ),
        createdAt,
        createdAtMs:
            Number.isFinite(
                parsedCreatedAt
            )
                ? parsedCreatedAt
                : statSync(
                    resolvedStagingRoot
                ).mtimeMs
    };
}


function getLatestValidatedStagedVencordSource() {
    const paths =
        getManagedPaths();

    if (!paths?.root) {
        throw new Error(
            "Managed workspace path is unavailable."
        );
    }

    const acquisitionRoot =
        join(
            paths.root,
            "source-acquisition"
        );

    if (
        !existsSync(
            acquisitionRoot
        )
    ) {
        throw new Error(
            "No Vencord source-acquisition staging directory exists."
        );
    }

    const rootStats =
        statSync(
            acquisitionRoot
        );

    if (!rootStats.isDirectory()) {
        throw new Error(
            "Vencord source-acquisition path exists but is not a directory."
        );
    }

    const stagingDirectories =
        readdirSync(
            acquisitionRoot,
            {
                withFileTypes: true
            }
        )
            .filter(entry =>
                entry.isDirectory()
            )
            .map(entry =>
                join(
                    acquisitionRoot,
                    entry.name
                )
            );

    const inspected =
        stagingDirectories.map(
            stagingRoot =>
                inspectStagedVencordSourceCandidate(
                    stagingRoot,
                    acquisitionRoot
                )
        );

    const valid =
        inspected
            .filter(candidate =>
                candidate.valid === true
            )
            .sort(
                (left, right) =>
                    right.createdAtMs -
                    left.createdAtMs
            );

    if (
        valid.length === 0
    ) {
        const reasons =
            inspected
                .map(candidate =>
                    candidate.reason
                )
                .filter(Boolean);

        throw new Error(
            reasons.length > 0
                ? `No validated staged Vencord source is available. ${reasons.join(" ")}`
                : "No validated staged Vencord source is available."
        );
    }

    return valid[0];
}


function promoteStagedVencordSource({ stagingRoot = null, customize = false } = {}) {
    const paths =
        getManagedPaths();

    if (!paths?.root) {
        throw new Error(
            "Managed workspace path is unavailable."
        );
    }

    // Hard safety gate: never replace, merge with, or write into an
    // existing managed Vencord directory.
    if (
        existsSync(
            paths.vencord
        )
    ) {
        throw new Error(
            `Refusing staged-source promotion: managed Vencord path already exists at ${paths.vencord}. Existing managed source will not be overwritten.`
        );
    }

    const staged =
        stagingRoot ? inspectStagedVencordSourceCandidate(stagingRoot, join(paths.root, "source-acquisition")) : getLatestValidatedStagedVencordSource();
    if (staged.valid !== true) throw new Error(staged.reason ?? "The selected source acquisition failed validation.");

    if (
        !isPathInsideOrSame(
            join(
                paths.root,
                "source-acquisition"
            ),
            staged.stagedSourceRoot
        )
    ) {
        throw new Error(
            "Refusing staged-source promotion: validated source is outside the managed source-acquisition area."
        );
    }

    const timestamp =
        new Date()
            .toISOString()
            .replace(
                /[:.]/g,
                "-"
            );

    const preparedPath =
        join(
            paths.root,
            `.Vencord-promotion-${timestamp}`
        );

    if (
        existsSync(
            preparedPath
        )
    ) {
        throw new Error(
            `Refusing staged-source promotion: temporary promotion path already exists: ${preparedPath}`
        );
    }

    try {
        cpSync(
            staged.stagedSourceRoot,
            preparedPath,
            {
                recursive: true,
                force: false,
                errorOnExist: true
            }
        );
    } catch (error) {
        throw new Error(
            `Failed to prepare staged Vencord source copy at ${preparedPath}: ${error?.message ?? "Unknown copy error."}`
        );
    }

    let preparedFiles;

    try {
        preparedFiles =
            getBackupFileManifest(
                preparedPath
            );
    } catch (error) {
        throw new Error(
            `Prepared Vencord source was copied but could not be verified: ${error?.message ?? "Unknown verification error."} Prepared copy was kept at ${preparedPath}.`
        );
    }

    const verification =
        verifyBackupFileManifests(
            staged.sourceFiles,
            preparedFiles
        );

    if (!verification.verified) {
        throw new Error(
            `Prepared Vencord source failed byte-for-byte verification: ${verification.reason} Prepared copy was kept at ${preparedPath}.`
        );
    }

    const preparedTreeSha256 =
        getFileManifestTreeSha256(
            preparedFiles
        );

    if (
        preparedTreeSha256 !==
        staged.sourceTreeSha256
    ) {
        throw new Error(
            `Prepared Vencord source tree hash mismatch. Prepared copy was kept at ${preparedPath}.`
        );
    }

    // The prepared copy itself is already the Vencord source directory,
    // so check its required structure directly in addition to the full
    // byte-for-byte verification above.
    const requiredPreparedEntries = [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        join(
            "scripts",
            "runInstaller.mjs"
        ),
        "src"
    ];

    for (
        const relativePath of
        requiredPreparedEntries
    ) {
        if (
            !existsSync(
                join(
                    preparedPath,
                    relativePath
                )
            )
        ) {
            throw new Error(
                `Prepared Vencord source is missing required path "${relativePath}". Prepared copy was kept at ${preparedPath}.`
            );
        }
    }

    // Keep the official acquisition pristine. Customize and verify this exact
    // prepared copy before the only operation that can activate it.
    if (customize) applySourceOverridesToStagedSource(preparedPath, staged.commit);
    const expectedPromotedFiles = customize ? getBackupFileManifest(preparedPath) : staged.sourceFiles;
    const expectedPromotedTreeSha256 = getFileManifestTreeSha256(expectedPromotedFiles);

    // Re-check the destination immediately before the only operation that
    // can activate this source.
    if (
        existsSync(
            paths.vencord
        )
    ) {
        throw new Error(
            `Refusing staged-source promotion: managed Vencord path appeared during verification at ${paths.vencord}. Prepared copy was kept at ${preparedPath}.`
        );
    }

    try {
        renameSync(
            preparedPath,
            paths.vencord
        );
    } catch (error) {
        throw new Error(
            `Verified Vencord source could not be promoted to ${paths.vencord}: ${error?.message ?? "Unknown rename error."} Existing managed source was not overwritten.`
        );
    }

    if (
        !existsSync(
            paths.vencord
        )
    ) {
        throw new Error(
            "Staged Vencord source promotion rename completed without an error, but the managed Vencord path is missing."
        );
    }

    const promotedFiles =
        getBackupFileManifest(
            paths.vencord
        );

    const postVerification =
        verifyBackupFileManifests(
            expectedPromotedFiles,
            promotedFiles
        );

    if (!postVerification.verified) {
        throw new Error(
            `Managed Vencord source exists after promotion but post-promotion verification failed: ${postVerification.reason}`
        );
    }

    const promotedTreeSha256 =
        getFileManifestTreeSha256(
            promotedFiles
        );

    if (
        promotedTreeSha256 !==
        expectedPromotedTreeSha256
    ) {
        throw new Error(
            "Managed Vencord source tree hash does not match the validated staged source after promotion."
        );
    }

    const promotionManifestPath =
        join(
            staged.stagingRoot,
            "source-promotion-manifest.json"
        );

    let promotionManifestWritten =
        false;

    let promotionManifestWarning =
        null;

    const promotionManifest = {
        promotedAt:
            new Date()
                .toISOString(),
        repository:
            staged.manifest.repository,
        commit:
            staged.commit,
        sourceAcquisitionManifest:
            staged.manifestPath,
        stagedSourceRoot:
            staged.stagedSourceRoot,
        managedVencordPath:
            paths.vencord,
        fileCount:
            promotedFiles.length,
        totalBytes:
            promotedFiles.reduce(
                (total, file) =>
                    total + file.size,
                0
            ),
        sourceTreeSha256:
            promotedTreeSha256,
        overwritePerformed:
            false,
        promotionMethod:
            "verified-copy-then-same-volume-rename"
    };

    try {
        writeFileSync(
            promotionManifestPath,
            JSON.stringify(
                promotionManifest,
                null,
                2
            ),
            "utf8"
        );

        promotionManifestWritten =
            true;
    } catch (error) {
        promotionManifestWarning =
            `Promotion succeeded, but promotion metadata could not be written: ${error?.message ?? "Unknown manifest write error."}`;
    }

    return {
        ok: true,
        state: "promoted",
        repository:
            staged.manifest.repository,
        commit:
            staged.commit,
        sourceAcquisitionManifest:
            staged.manifestPath,
        promotionManifestPath,
        promotionManifestWritten,
        promotionManifestWarning,
        stagedSourceRoot:
            staged.stagedSourceRoot,
        managedVencordPath:
            paths.vencord,
        fileCount:
            promotedFiles.length,
        totalBytes:
            promotionManifest.totalBytes,
        sourceTreeSha256:
            promotedTreeSha256,
        overwritePerformed:
            false,
        reason:
            "Validated staged Vencord source was copied to an isolated preparation path, verified byte-for-byte, and promoted into a previously nonexistent managed Vencord path."
    };
}


function detectDiscordInstalls() {
    const localAppData = process.env.LOCALAPPDATA;

    if (!localAppData) {
        return [];
    }

    const candidates = [
        {
            name: "Stable",
            path: join(localAppData, "Discord")
        },
        {
            name: "Canary",
            path: join(localAppData, "DiscordCanary")
        },
        {
            name: "PTB",
            path: join(localAppData, "DiscordPTB")
        }
    ];

    return candidates.filter(discord =>
        existsSync(discord.path)
    );
}

function compareDiscordAppDirectories(
    left,
    right
) {
    const leftNumeric =
        /^(\d+(?:\.\d+)*)/.exec(
            left.version
        )?.[1] ?? null;

    const rightNumeric =
        /^(\d+(?:\.\d+)*)/.exec(
            right.version
        )?.[1] ?? null;

    if (
        leftNumeric &&
        rightNumeric
    ) {
        const leftParts =
            leftNumeric
                .split(".")
                .map(Number);

        const rightParts =
            rightNumeric
                .split(".")
                .map(Number);

        const length =
            Math.max(
                leftParts.length,
                rightParts.length
            );

        for (
            let index = 0;
            index < length;
            index += 1
        ) {
            const leftValue =
                leftParts[index] ?? 0;

            const rightValue =
                rightParts[index] ?? 0;

            if (
                leftValue !==
                rightValue
            ) {
                return (
                    rightValue -
                    leftValue
                );
            }
        }
    }

    return right.name.localeCompare(
        left.name,
        undefined,
        {
            numeric: true,
            sensitivity: "base"
        }
    );
}


function getDiscordAppDirectories(
    discord
) {
    let entries;

    try {
        entries =
            readdirSync(
                discord.path,
                {
                    withFileTypes: true
                }
            );
    } catch (error) {
        return {
            ok: false,
            appDirectories: [],
            reason:
                error?.message ??
                "Unable to inspect Discord installation."
        };
    }

    const appDirectories =
        entries
            .filter(entry =>
                entry.isDirectory() &&
                entry.name
                    .toLowerCase()
                    .startsWith(
                        "app-"
                    )
            )
            .map(entry => {
                const appPath =
                    join(
                        discord.path,
                        entry.name
                    );

                return {
                    name:
                        entry.name,
                    version:
                        entry.name.slice(4),
                    path:
                        appPath,
                    resourcesPath:
                        join(
                            appPath,
                            "resources"
                        )
                };
            })
            .filter(appDirectory =>
                originalFs.existsSync(
                    appDirectory.resourcesPath
                )
            )
            .sort(
                compareDiscordAppDirectories
            );

    return {
        ok: true,
        appDirectories
    };
}


function decodeVencordPatcherPath(
    contents
) {
    const requireMatches = [
        ...contents.matchAll(
            /require\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)/g
        )
    ];

    for (const match of requireMatches) {
        const literal =
            match[1];

        try {
            const decoded =
                literal.startsWith('"')
                    ? JSON.parse(literal)
                    : literal
                        .slice(1, -1)
                        .replace(/\\\\/g, "\\")
                        .replace(/\\'/g, "'");

            if (
                typeof decoded === "string" &&
                /(?:^|[\\/])patcher\.js$/i.test(
                    decoded
                )
            ) {
                return decoded;
            }
        } catch {
            // Keep scanning other require(...) calls.
        }
    }

    return null;
}


function inspectDiscordAppPatchCandidate(
    discord,
    appDirectory,
    managedPatcherPath = null
) {
    const resourcesPath =
        appDirectory.resourcesPath;

    const markerPath =
        join(
            resourcesPath,
            "_app.asar"
        );

    const injectedAsarPath =
        join(
            resourcesPath,
            "app.asar"
        );

    const legacyInjectorPath =
        join(
            resourcesPath,
            "app",
            "index.js"
        );

    const markerExists =
        originalFs.existsSync(
            markerPath
        );

    const appAsarExists =
        originalFs.existsSync(
            injectedAsarPath
        );

    const legacyInjectorExists =
        originalFs.existsSync(
            legacyInjectorPath
        );

    const discordExecutablePath =
        join(
            appDirectory.path,
            `${basename(discord.path)}.exe`
        );

    const discordExecutableExists =
        originalFs.existsSync(
            discordExecutablePath
        );

    let injectorPath = null;
    let injectorFormat = null;

    if (legacyInjectorExists) {
        injectorPath =
            legacyInjectorPath;

        injectorFormat =
            "legacy-app-directory";
    } else if (appAsarExists) {
        let shouldInspectAsInjector =
            false;

        try {
            const stats =
                originalFs.statSync(
                    injectedAsarPath
                );

            // A current Vencord injector app.asar is tiny. Only inspect
            // small app.asar files as injector candidates so Discord's
            // full stock archive is never scanned or mistaken for one.
            shouldInspectAsInjector =
                stats.isFile() &&
                stats.size > 0 &&
                stats.size <=
                512 * 1024;
        } catch {
            shouldInspectAsInjector =
                false;
        }

        if (shouldInspectAsInjector) {
            injectorPath =
                injectedAsarPath;

            injectorFormat =
                "app-asar";
        }
    }

    let patcherPath = null;
    let injectorReadError = null;

    if (injectorPath) {
        try {
            const contents =
                injectorFormat === "app-asar"
                    ? originalFs
                        .readFileSync(
                            injectedAsarPath
                        )
                        .toString(
                            "utf8"
                        )
                    : originalFs.readFileSync(
                        legacyInjectorPath,
                        "utf8"
                    );

            patcherPath =
                decodeVencordPatcherPath(
                    contents
                );
        } catch (error) {
            injectorReadError =
                error?.message ??
                "Unable to read Discord injector.";
        }
    }

    const recognizedVencord =
        typeof patcherPath === "string";

    const patched =
        markerExists ||
        recognizedVencord;

    const pointsToManaged =
        recognizedVencord &&
        typeof managedPatcherPath === "string" &&
        normalize(
            patcherPath
        ).toLowerCase() ===
        normalize(
            managedPatcherPath
        ).toLowerCase();

    let detailState =
        "unpatched";

    let reason = null;

    if (recognizedVencord) {
        detailState =
            "vencord";

        if (!markerExists) {
            reason =
                "Vencord injector was detected even though the usual _app.asar backup marker is missing.";
        }
    } else if (markerExists) {
        detailState =
            "patched-unknown";

        reason =
            injectorReadError ??
            (
                injectorFormat === "app-asar"
                    ? "resources\\_app.asar exists, but the replacement app.asar did not expose a recognizable Vencord patcher target."
                    : injectorFormat === "legacy-app-directory"
                        ? "resources\\_app.asar exists, but the legacy resources\\app\\index.js injector did not expose a recognizable Vencord patcher target."
                        : "resources\\_app.asar exists, but no supported injector entry point was found."
            );
    } else if (injectorReadError) {
        detailState =
            "unavailable";

        reason =
            injectorReadError;
    }

    return {
        name:
            discord.name,
        path:
            discord.path,
        state:
            patched
                ? "patched"
                : detailState === "unavailable"
                    ? "unavailable"
                    : "unpatched",
        patched,
        appVersion:
            appDirectory.version,
        appPath:
            appDirectory.path,
        markerPath,
        markerExists,
        injectedAsarPath,
        appAsarExists,
        legacyInjectorPath,
        legacyInjectorExists,
        discordExecutablePath,
        discordExecutableExists,
        operationalLayout:
            discordExecutableExists &&
            (
                appAsarExists ||
                markerExists
            ),
        injectorPath,
        injectorFormat,
        injectorReadPath:
            injectorPath,
        patcherPath,
        managedPatcherPath,
        pointsToManaged,
        detailState,
        reason
    };
}


function inspectDiscordInstallPatch(
    discord,
    managedPatcherPath = null
) {
    const appDirectoryState =
        getDiscordAppDirectories(
            discord
        );

    const emptyResult = ({
        state,
        detailState,
        reason
    }) => ({
        name:
            discord.name,
        path:
            discord.path,
        state,
        patched:
            false,
        appVersion:
            null,
        appPath:
            null,
        markerPath:
            null,
        markerExists:
            false,
        injectedAsarPath:
            null,
        appAsarExists:
            false,
        legacyInjectorPath:
            null,
        legacyInjectorExists:
            false,
        discordExecutablePath:
            null,
        discordExecutableExists:
            false,
        operationalLayout:
            false,
        injectorPath:
            null,
        injectorFormat:
            null,
        injectorReadPath:
            null,
        patcherPath:
            null,
        managedPatcherPath,
        pointsToManaged:
            false,
        detailState,
        reason,
        newestAppVersion:
            null,
        newestAppPath:
            null,
        vencordCliAppVersion:
            null,
        vencordCliAppPath:
            null,
        cliTargetUsable:
            false,
        mutationSafe:
            false,
        mutationTargetMismatch:
            false,
        mutationBlockReason:
            reason ?? null,
        detectedFromOlderApp:
            false,
        staleVencordDetected:
            false,
        staleVencordCandidates: [],
        appCandidates: [],
        selectionReason:
            null
    });

    if (!appDirectoryState.ok) {
        return emptyResult({
            state:
                "unavailable",
            detailState:
                "unavailable",
            reason:
                appDirectoryState.reason
        });
    }

    const appDirectories =
        appDirectoryState.appDirectories;

    if (
        appDirectories.length === 0
    ) {
        return emptyResult({
            state:
                "no-app",
            detailState:
                "unavailable",
            reason:
                "No usable Discord app-* directory with a resources folder was found."
        });
    }

    const inspected =
        appDirectories.map(
            appDirectory =>
                inspectDiscordAppPatchCandidate(
                    discord,
                    appDirectory,
                    managedPatcherPath
                )
        );

    const newest =
        inspected[0];

    // Vencord's Windows installer chooses its own app-* target. Track that
    // separately from the app we use for detection so a staged/newer Discord
    // folder can never make an older, currently usable Vencord patch disappear.
    let cliDirectory =
        appDirectories[0];

    let cliSelectionKey =
        join(
            cliDirectory.resourcesPath,
            "app"
        );

    for (
        const candidate of
        appDirectories.slice(1)
    ) {
        const candidateKey =
            join(
                candidate.resourcesPath,
                "app"
            );

        if (
            candidateKey >
            cliSelectionKey
        ) {
            cliDirectory =
                candidate;

            cliSelectionKey =
                candidateKey;
        }
    }

    const cliCandidate =
        inspected.find(
            candidate =>
                normalize(
                    candidate.appPath
                ).toLowerCase() ===
                normalize(
                    cliDirectory.path
                ).toLowerCase()
        ) ??
        newest;

    // A Discord app is considered usable/current on disk when it has its
    // executable and an ASAR layout Discord/Vencord can actually operate on.
    // This intentionally excludes a lone legacy resources\\app\\index.js
    // folder: it can be useful evidence, but current Vencord CLI unpatching
    // cannot safely treat that alone as an install target.
    const operationalCandidates =
        inspected.filter(candidate =>
            candidate.operationalLayout ===
            true
        );

    const recognizedVencordCandidate =
        inspected.find(candidate =>
            candidate.detailState ===
            "vencord"
        ) ??
        null;

    const selected =
        operationalCandidates[0] ??
        recognizedVencordCandidate ??
        newest;

    const cliTargetUsable =
        cliCandidate.appAsarExists === true ||
        cliCandidate.markerExists === true;

    const mutationTargetMismatch =
        normalize(
            selected.appPath
        ).toLowerCase() !==
        normalize(
            cliCandidate.appPath
        ).toLowerCase();

    const mutationBlockReason =
        !cliTargetUsable
            ? `Discord app ${cliCandidate.appVersion} is the version Vencord would modify, but it does not currently contain app.asar or _app.asar. A Discord update appears to be staged or pending. Open Discord and let the update finish. If it does not start automatically, right-click Discord in the system tray and choose Check for Updates. After the update completes, fully quit Discord from the system tray and reopen Maru Vencord Installer.`
            : mutationTargetMismatch
                ? `Discord's currently usable app is ${selected.appVersion}, but Vencord would modify ${cliCandidate.appVersion}. A Discord update appears to be staged or pending. Open Discord and let the update finish. If it does not start automatically, right-click Discord in the system tray and choose Check for Updates. After the update completes, fully quit Discord from the system tray and reopen Maru Vencord Installer before installing, repairing, migrating, or uninstalling Vencord.`
                : null;

    const staleVencordCandidates =
        inspected
            .filter(candidate =>
                normalize(
                    candidate.appPath
                ).toLowerCase() !==
                normalize(
                    selected.appPath
                ).toLowerCase() &&
                candidate.detailState ===
                "vencord"
            )
            .map(candidate => ({
                appVersion:
                    candidate.appVersion,
                appPath:
                    candidate.appPath,
                patcherPath:
                    candidate.patcherPath,
                pointsToManaged:
                    candidate.pointsToManaged
            }));

    const appCandidates =
        inspected.map(candidate => ({
            appVersion:
                candidate.appVersion,
            appPath:
                candidate.appPath,
            state:
                candidate.state,
            detailState:
                candidate.detailState,
            markerExists:
                candidate.markerExists,
            appAsarExists:
                candidate.appAsarExists,
            legacyInjectorExists:
                candidate.legacyInjectorExists,
            discordExecutableExists:
                candidate.discordExecutableExists,
            operationalLayout:
                candidate.operationalLayout,
            injectorFormat:
                candidate.injectorFormat,
            patcherPath:
                candidate.patcherPath,
            pointsToManaged:
                candidate.pointsToManaged
        }));

    const selectedIsUsable =
        selected.operationalLayout === true ||
        selected.detailState === "vencord";

    if (!selectedIsUsable) {
        return {
            ...selected,
            state:
                "unavailable",
            patched:
                false,
            detailState:
                "unavailable",
            reason:
                mutationBlockReason ??
                `Discord app ${selected.appVersion} could not be verified as a usable current Discord installation.`,
            newestAppVersion:
                newest.appVersion,
            newestAppPath:
                newest.appPath,
            vencordCliAppVersion:
                cliCandidate.appVersion,
            vencordCliAppPath:
                cliCandidate.appPath,
            cliTargetUsable,
            mutationSafe:
                false,
            mutationTargetMismatch,
            mutationBlockReason:
                mutationBlockReason ??
                "The selected Discord installation is not safe to modify.",
            detectedFromOlderApp:
                normalize(
                    selected.appPath
                ).toLowerCase() !==
                normalize(
                    newest.appPath
                ).toLowerCase(),
            staleVencordDetected:
                staleVencordCandidates.length > 0,
            staleVencordCandidates,
            appCandidates,
            selectionReason:
                "No fully usable Discord app layout could be verified."
        };
    }

    return {
        ...selected,
        newestAppVersion:
            newest.appVersion,
        newestAppPath:
            newest.appPath,
        vencordCliAppVersion:
            cliCandidate.appVersion,
        vencordCliAppPath:
            cliCandidate.appPath,
        cliTargetUsable,
        mutationSafe:
            cliTargetUsable &&
            !mutationTargetMismatch,
        mutationTargetMismatch,
        mutationBlockReason,
        detectedFromOlderApp:
            normalize(
                selected.appPath
            ).toLowerCase() !==
            normalize(
                newest.appPath
            ).toLowerCase(),
        staleVencordDetected:
            staleVencordCandidates.length > 0,
        staleVencordCandidates,
        selectionReason:
            selected.operationalLayout === true
                ? "Selected the newest usable Discord app layout for patch detection; Vencord CLI target is tracked separately."
                : "Detected a recognizable Vencord injector on disk; mutation remains separately safety-gated.",
        appCandidates
    };
}

function getDiscordPatchStates() {
    const installs =
        detectDiscordInstalls();

    return installs.map(
        discord =>
            inspectDiscordInstallPatch(
                discord
            )
    );
}


function getDiscordPatchDetails() {
    const installs =
        detectDiscordInstalls();

    const managedPaths =
        getManagedPaths();

    const managedPatcherPath =
        managedPaths
            ? join(
                managedPaths.vencord,
                "dist",
                "patcher.js"
            )
            : null;

    return installs.map(
        discord =>
            inspectDiscordInstallPatch(
                discord,
                managedPatcherPath
            )
    );
}

function getManagedUninstallStates(
    patchDetails = getDiscordPatchDetails()
) {

    return patchDetails.map(detail => {
        if (
            detail.state === "unpatched" ||
            detail.detailState === "unpatched"
        ) {
            return {
                name: detail.name,
                path: detail.path,
                appVersion:
                    detail.appVersion ?? null,
                state: "unpatched",
                eligible: false,
                reason:
                    "Discord is not currently patched with Vencord."
            };
        }

        if (
            detail.detailState === "vencord" &&
            detail.pointsToManaged === true
        ) {
            const mutationSafe =
                detail.mutationSafe !== false;

            return {
                name: detail.name,
                path: detail.path,
                appVersion:
                    detail.appVersion ?? null,
                state: "managed",
                eligible:
                    mutationSafe,
                patcherPath:
                    detail.patcherPath,
                managedPatcherPath:
                    detail.managedPatcherPath,
                mutationSafe,
                mutationBlockReason:
                    detail.mutationBlockReason ?? null,
                reason:
                    mutationSafe
                        ? "This Discord installation is patched with the Vencord build managed by Maru Vencord Installer."
                        : detail.mutationBlockReason ??
                        "This Discord installation is managed by Maru, but Discord's current app-version state is not safe to modify."
            };
        }

        if (
            detail.detailState === "vencord" &&
            typeof detail.patcherPath === "string"
        ) {
            return {
                name: detail.name,
                path: detail.path,
                appVersion:
                    detail.appVersion ?? null,
                state: "external",
                eligible: false,
                patcherPath:
                    detail.patcherPath,
                managedPatcherPath:
                    detail.managedPatcherPath,
                reason:
                    "This Discord installation is patched with a different Vencord source. Maru Vencord Installer will not claim it for uninstall."
            };
        }

        return {
            name: detail.name,
            path: detail.path,
            appVersion:
                detail.appVersion ?? null,
            state: "unavailable",
            eligible: false,
            patcherPath:
                detail.patcherPath ?? null,
            managedPatcherPath:
                detail.managedPatcherPath ?? null,
            reason:
                detail.reason ??
                "Unable to verify whether this Discord installation belongs to the managed Vencord build."
        };
    });
}


function getDiscordRunningState(discord) {
    return new Promise((resolve, reject) => {
        if (
            !discord ||
            typeof discord.path !== "string" ||
            discord.path.length === 0
        ) {
            reject(
                new Error(
                    "Unable to verify whether Discord is fully closed."
                )
            );

            return;
        }

        const targetPath =
            normalize(discord.path);

        const expectedProcessName =
            `${basename(targetPath)}.exe`;

        const script = [
            "$target = $env:MARU_DISCORD_TARGET",
            "$expectedExe = $env:MARU_DISCORD_EXE",
            "$matches = @(Get-CimInstance Win32_Process | Where-Object {",
            "    ($_.Name -ieq $expectedExe) -or",
            "    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($target, [System.StringComparison]::OrdinalIgnoreCase)) -or",
            "    ($_.CommandLine -and $_.CommandLine.IndexOf($target, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)",
            "} | Select-Object ProcessId, Name, ExecutablePath, CommandLine)",
            "[pscustomobject]@{",
            "    running = ($matches.Count -gt 0)",
            "    processes = $matches",
            "} | ConvertTo-Json -Compress -Depth 4"
        ].join("\n");

        execFile(
            "powershell.exe",
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script
            ],
            {
                windowsHide: true,
                timeout: 10000,
                env: {
                    ...process.env,
                    MARU_DISCORD_TARGET:
                        targetPath,
                    MARU_DISCORD_EXE:
                        expectedProcessName
                }
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject(
                        new Error(
                            stderr.trim() ||
                            stdout.trim() ||
                            error.message ||
                            "Unable to verify whether Discord is fully closed."
                        )
                    );

                    return;
                }

                const output =
                    stdout.trim();

                if (!output) {
                    reject(
                        new Error(
                            "Unable to verify whether Discord is fully closed."
                        )
                    );

                    return;
                }

                try {
                    const result =
                        JSON.parse(output);

                    const processes =
                        Array.isArray(result.processes)
                            ? result.processes
                            : result.processes
                                ? [result.processes]
                                : [];

                    const appDirectoryState =
                        getDiscordAppDirectories(
                            discord
                        );

                    const executablePaths =
                        processes
                            .map(process =>
                                typeof process?.ExecutablePath === "string"
                                    ? normalize(
                                        process.ExecutablePath
                                    )
                                    : null
                            )
                            .filter(Boolean);

                    const runningAppDirectories =
                        appDirectoryState.ok
                            ? appDirectoryState.appDirectories
                                .filter(appDirectory => {
                                    const appRoot =
                                        `${normalize(appDirectory.path).toLowerCase()}\\`;

                                    return executablePaths.some(executablePath =>
                                        executablePath
                                            .toLowerCase()
                                            .startsWith(
                                                appRoot
                                            )
                                    );
                                })
                            : [];

                    const runningApp =
                        runningAppDirectories[0] ??
                        null;

                    resolve({
                        running:
                            result.running === true,
                        processes,
                        executablePaths,
                        runningAppVersion:
                            runningApp?.version ?? null,
                        runningAppPath:
                            runningApp?.path ?? null,
                        runningAppVersions:
                            runningAppDirectories.map(
                                appDirectory =>
                                    appDirectory.version
                            )
                    });
                } catch (error) {
                    reject(
                        new Error(
                            error?.message
                                ? `Unable to verify whether Discord is fully closed: ${error.message}`
                                : "Unable to verify whether Discord is fully closed."
                        )
                    );
                }
            }
        );
    });
}


async function getDiscordRuntimeAwarePatchDetail(
    discord,
    baseDetail = null
) {
    const detail =
        baseDetail ??
        inspectDiscordInstallPatch(
            discord,
            getManagedPaths()
                ? join(
                    getManagedPaths().vencord,
                    "dist",
                    "patcher.js"
                )
                : null
        );

    let runningState;

    try {
        runningState =
            await getDiscordRunningState(
                discord
            );
    } catch (error) {
        return {
            ...detail,
            runningStateAvailable:
                false,
            discordRunning:
                null,
            runningAppVersion:
                null,
            runningAppPath:
                null,
            runningStateReason:
                error?.message ??
                "Unable to inspect the running Discord process."
        };
    }

    const runtimeBase = {
        ...detail,
        runningStateAvailable:
            true,
        discordRunning:
            runningState.running === true,
        runningAppVersion:
            runningState.runningAppVersion ?? null,
        runningAppPath:
            runningState.runningAppPath ?? null,
        runningAppVersions:
            runningState.runningAppVersions ?? []
    };

    if (
        runningState.running !== true ||
        typeof runningState.runningAppPath !== "string"
    ) {
        return runtimeBase;
    }

    const appDirectoryState =
        getDiscordAppDirectories(
            discord
        );

    if (!appDirectoryState.ok) {
        return runtimeBase;
    }

    const runningDirectory =
        appDirectoryState.appDirectories.find(
            appDirectory =>
                normalize(
                    appDirectory.path
                ).toLowerCase() ===
                normalize(
                    runningState.runningAppPath
                ).toLowerCase()
        ) ??
        null;

    if (!runningDirectory) {
        return runtimeBase;
    }

    const runningCandidate =
        inspectDiscordAppPatchCandidate(
            discord,
            runningDirectory,
            detail.managedPatcherPath ?? null
        );

    const mutationTargetMismatch =
        typeof detail.vencordCliAppPath === "string" &&
        normalize(
            runningCandidate.appPath
        ).toLowerCase() !==
        normalize(
            detail.vencordCliAppPath
        ).toLowerCase();

    const mutationBlockReason =
        detail.cliTargetUsable !== true
            ? `Discord is currently running from ${runningCandidate.appVersion}, but Vencord would target ${detail.vencordCliAppVersion ?? "another app version"}, whose ASAR layout is incomplete. A Discord update appears to be staged or pending. If it does not start automatically, right-click Discord in the system tray and choose Check for Updates. After the update completes, fully quit Discord from the system tray and reopen Maru Vencord Installer.`
            : mutationTargetMismatch
                ? `Discord is currently running from ${runningCandidate.appVersion}, but Vencord would modify ${detail.vencordCliAppVersion ?? "another app version"}. A Discord update appears to be staged or pending. If it does not start automatically, right-click Discord in the system tray and choose Check for Updates. After the update completes, fully quit Discord from the system tray and reopen Maru Vencord Installer before installing, repairing, migrating, or uninstalling Vencord.`
                : null;

    const staleVencordCandidates =
        Array.isArray(detail.appCandidates)
            ? detail.appCandidates
                .filter(candidate =>
                    normalize(
                        candidate.appPath
                    ).toLowerCase() !==
                    normalize(
                        runningCandidate.appPath
                    ).toLowerCase() &&
                    candidate.detailState ===
                    "vencord"
                )
                .map(candidate => ({
                    appVersion:
                        candidate.appVersion,
                    appPath:
                        candidate.appPath,
                    patcherPath:
                        candidate.patcherPath,
                    pointsToManaged:
                        candidate.pointsToManaged
                }))
            : [];

    return {
        ...runtimeBase,
        ...runningCandidate,
        newestAppVersion:
            detail.newestAppVersion,
        newestAppPath:
            detail.newestAppPath,
        vencordCliAppVersion:
            detail.vencordCliAppVersion,
        vencordCliAppPath:
            detail.vencordCliAppPath,
        cliTargetUsable:
            detail.cliTargetUsable === true,
        mutationSafe:
            detail.cliTargetUsable === true &&
            !mutationTargetMismatch,
        mutationTargetMismatch,
        mutationBlockReason,
        detectedFromOlderApp:
            typeof detail.newestAppPath === "string" &&
            normalize(
                runningCandidate.appPath
            ).toLowerCase() !==
            normalize(
                detail.newestAppPath
            ).toLowerCase(),
        staleVencordDetected:
            staleVencordCandidates.length > 0,
        staleVencordCandidates,
        appCandidates:
            detail.appCandidates ?? [],
        runningStateAvailable:
            true,
        discordRunning:
            true,
        runningAppVersion:
            runningCandidate.appVersion,
        runningAppPath:
            runningCandidate.appPath,
        runningAppVersions:
            runningState.runningAppVersions ?? [],
        selectionReason:
            "Selected the Discord app folder containing the currently running Discord executable; Vencord CLI target is tracked separately."
    };
}


async function getDiscordPatchDetailsWithRuntime() {
    const installs =
        detectDiscordInstalls();

    const baseDetails =
        getDiscordPatchDetails();

    const baseByName =
        new Map(
            baseDetails.map(detail => [
                detail.name,
                detail
            ])
        );

    return Promise.all(
        installs.map(discord =>
            getDiscordRuntimeAwarePatchDetail(
                discord,
                baseByName.get(
                    discord.name
                ) ?? null
            )
        )
    );
}


const MANAGED_TOOL_CANDIDATES = {
    node: [
        ["node", "node.exe"],
        ["node.exe"]
    ],

    git: [
        ["git", "cmd", "git.exe"],
        ["git", "bin", "git.exe"],
        ["git", "git.exe"],
        ["git.exe"]
    ],

    pnpm: [
        ["node", "pnpm.cmd"],
        ["pnpm", "pnpm.cmd"],
        ["pnpm.cmd"]
    ],

    corepack: [
        ["node", "corepack.cmd"],
        ["corepack", "corepack.cmd"],
        ["corepack.cmd"]
    ]
};


function isRegularNonEmptyFile(filePath) {
    try {
        return (
            existsSync(filePath) &&
            statSync(filePath).isFile() &&
            statSync(filePath).size > 0
        );
    } catch {
        return false;
    }
}


function resolveManagedPnpmPackageRuntime(
    paths, runtimeRootOverride = null
) {
    if (!paths?.toolchain) {
        return null;
    }

    const runtimeRoot = runtimeRootOverride ??
        join(
            paths.toolchain,
            "pnpm"
        );

    const manifestPath =
        join(
            runtimeRoot,
            "managed-pnpm-manifest.json"
        );

    const wrapperPath =
        join(
            runtimeRoot,
            "pnpm.cmd"
        );

    if (
        !isRegularNonEmptyFile(
            manifestPath
        )
    ) {
        return null;
    }

    let manifest;

    try {
        manifest =
            JSON.parse(
                readFileSync(
                    manifestPath,
                    "utf8"
                )
            );
    } catch {
        return null;
    }

    const packageMatch =
        typeof manifest?.package === "string"
            ? manifest.package.match(
                /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
            )
            : null;

    if (!packageMatch) {
        return null;
    }

    const version =
        packageMatch[1];

    if (
        typeof manifest?.packageBin !== "string" ||
        manifest.packageBin.length === 0
    ) {
        return null;
    }

    const packageRoot =
        join(
            runtimeRoot,
            "package"
        );

    const binPath =
        resolve(
            packageRoot,
            manifest.packageBin
        );

    if (
        !isPathInsideOrSame(
            packageRoot,
            binPath
        ) ||
        !isRegularNonEmptyFile(
            binPath
        )
    ) {
        return null;
    }

    const packagePath =
        join(
            packageRoot,
            "package.json"
        );

    if (
        !isRegularNonEmptyFile(
            packagePath
        )
    ) {
        return null;
    }

    let packageJson;

    try {
        packageJson =
            JSON.parse(
                readFileSync(
                    packagePath,
                    "utf8"
                )
            );
    } catch {
        return null;
    }

    if (
        packageJson?.name !== "pnpm" ||
        packageJson?.version !== version
    ) {
        return null;
    }

    const managedNodeCandidates =
        MANAGED_TOOL_CANDIDATES.node ?? [];

    let managedNodePath =
        null;

    for (
        const relativeParts of
        managedNodeCandidates
    ) {
        const candidate =
            join(
                paths.toolchain,
                ...relativeParts
            );

        if (
            isRegularNonEmptyFile(
                candidate
            )
        ) {
            managedNodePath =
                candidate;

            break;
        }
    }

    if (!managedNodePath) {
        return null;
    }

    return {
        name:
            "pnpm",
        command:
            isRegularNonEmptyFile(
                wrapperPath
            )
                ? wrapperPath
                : binPath,
        executable:
            managedNodePath,
        argsPrefix: [
            binPath
        ],
        source:
            "managed",
        managed:
            true,
        shell:
            false,
        runtimeKind:
            "managed-node-script",
        managedPackageVersion:
            version,
        manifestPath,
        packageRoot,
        binPath
    };
}


function resolveManagedBuildTool(toolName) {
    if (
        !Object.prototype.hasOwnProperty.call(
            MANAGED_TOOL_CANDIDATES,
            toolName
        )
    ) {
        throw new Error(
            `Unknown build tool: ${toolName}`
        );
    }

    const paths =
        getManagedPaths();

    const policy =
        getManagedToolResolutionPolicy();

    if (
        toolName === "pnpm" &&
        paths?.toolchain
    ) {
        let cachedPnpm = null;
        try {
            const requirement = getManagedPackageManagerRequirement();
            const version = /^pnpm@([0-9A-Za-z.+-]+)$/.exec(requirement.packageManager ?? "")?.[1];
            if (version) cachedPnpm = resolveManagedPnpmPackageRuntime(paths, join(paths.toolchain, "pnpm-versions", version));
        } catch { /* Source recovery may be required; retain the existing resolver fallback. */ }
        const managedPnpm = cachedPnpm ?? resolveManagedPnpmPackageRuntime(paths);

        if (managedPnpm) {
            recordManagedToolAudit(
                "managedSelections",
                toolName,
                {
                    command:
                        managedPnpm.command,
                    runtimeKind:
                        managedPnpm.runtimeKind ??
                        null
                }
            );

            return managedPnpm;
        }
    }

    if (paths?.toolchain) {
        for (
            const relativeParts of
            MANAGED_TOOL_CANDIDATES[toolName]
        ) {
            const candidate =
                join(
                    paths.toolchain,
                    ...relativeParts
                );

            if (
                isRegularNonEmptyFile(
                    candidate
                )
            ) {
                const resolved = {
                    name:
                        toolName,
                    command:
                        candidate,
                    source:
                        "managed",
                    managed:
                        true,
                    shell:
                        /\.(?:cmd|bat)$/i.test(
                            candidate
                        )
                };

                recordManagedToolAudit(
                    "managedSelections",
                    toolName,
                    {
                        command:
                            candidate,
                        runtimeKind:
                            "managed-file"
                    }
                );

                return resolved;
            }
        }
    }

    if (
        policy.strictManagedTools
    ) {
        recordManagedToolAudit(
            "blockedGlobalFallbacks",
            toolName,
            {
                reason:
                    "No managed runtime was available; strict managed-only mode refused global fallback."
            }
        );

        return {
            name:
                toolName,
            command:
                null,
            source:
                "unavailable",
            managed:
                false,
            shell:
                false,
            strictManagedOnly:
                true,
            unavailableReason:
                `Strict managed-only mode: no managed ${toolName} runtime is available, and global fallback is disabled.`
        };
    }

    return {
        name:
            toolName,
        command:
            toolName,
        source:
            "global",
        managed:
            false,
        shell:
            toolName === "pnpm" ||
            toolName === "corepack"
    };
}


function quoteCommandPromptArg(value) {
    const textValue =
        String(value);

    return `"${textValue.replace(
        /"/g,
        '""'
    )}"`;
}


function getResolvedToolEnvironment(
    tool,
    extraEnv = null
) {
    const pathKey =
        Object.keys(
            process.env
        ).find(
            key =>
                key.toLowerCase() === "path"
        ) ?? "Path";

    const policy =
        getManagedToolResolutionPolicy();

    const existingPath =
        process.env[pathKey] ??
        process.env.PATH ??
        "";

    const prepend = [];

    if (
        tool?.managed &&
        typeof tool.command === "string"
    ) {
        prepend.push(
            dirname(
                tool.command
            )
        );
    }

    const managedNode =
        resolveManagedBuildTool(
            "node"
        );

    if (
        managedNode.managed &&
        typeof managedNode.command === "string"
    ) {
        const nodeDirectory =
            dirname(
                managedNode.command
            );

        if (
            !prepend.some(
                entry =>
                    normalize(entry)
                        .toLowerCase() ===
                    normalize(nodeDirectory)
                        .toLowerCase()
            )
        ) {
            prepend.push(
                nodeDirectory
            );
        }
    }

    const systemRoot =
        process.env.SystemRoot ||
        "C:\\Windows";

    const strictSystemPaths = [
        join(
            systemRoot,
            "System32"
        ),
        systemRoot,
        join(
            systemRoot,
            "System32",
            "Wbem"
        )
    ];

    const resolvedPath =
        (
            policy.strictManagedTools
                ? [
                    ...prepend,
                    ...strictSystemPaths
                ]
                : [
                    ...prepend,
                    existingPath
                ]
        )
            .filter(Boolean)
            .filter(
                (
                    entry,
                    index,
                    entries
                ) =>
                    entries.findIndex(
                        candidate =>
                            normalize(candidate)
                                .toLowerCase() ===
                            normalize(entry)
                                .toLowerCase()
                    ) === index
            )
            .join(";");

    if (
        policy.strictManagedTools
    ) {
        recordManagedToolAudit(
            "strictPaths",
            tool?.name ??
            "unknown",
            {
                path:
                    resolvedPath
            }
        );
    }

    return {
        ...process.env,
        ...(extraEnv ?? {}),
        [pathKey]:
            resolvedPath
    };
}


function execResolvedBuildTool(
    toolName,
    args,
    options,
    callback
) {
    const { managedPnpmRoot = null, ...executionOptions } = options ?? {};
    let tool;
    if (managedPnpmRoot) {
        const paths = getManagedPaths();
        assertSafePath(managedPnpmRoot);
        if (toolName !== "pnpm" || !isPathInsideOrSame(paths.toolchain, managedPnpmRoot))
            throw new Error("Source-specific pnpm runtime is outside the managed toolchain.");
        tool = resolveManagedPnpmPackageRuntime(paths, managedPnpmRoot);
        if (!tool) throw new Error("Source-specific managed pnpm failed runtime verification.");
        recordManagedToolAudit("managedSelections", "pnpm", { command: tool.command, runtimeKind: tool.runtimeKind });
    } else {
        tool = resolveManagedBuildTool(toolName);
    }

    if (
        typeof tool.command !== "string" ||
        tool.command.length === 0
    ) {
        throw new Error(
            tool.unavailableReason ??
            `Build tool "${toolName}" is unavailable.`
        );
    }

    const execOptions = {
        ...executionOptions,
        env:
            getResolvedToolEnvironment(
                tool,
                options?.env
            )
    };

    if (!tool.shell) {
        execFile(
            tool.executable ??
            tool.command,
            [
                ...(tool.argsPrefix ?? []),
                ...args
            ],
            execOptions,
            callback
        );

        return tool;
    }

    const commandPrompt =
        process.env.ComSpec ||
        "cmd.exe";

    const commandLine =
        tool.managed
            ? `"${[
                quoteCommandPromptArg(
                    tool.command
                ),
                ...args.map(
                    quoteCommandPromptArg
                )
            ]
                .filter(Boolean)
                .join(" ")}"`
            : [
                tool.command,
                ...args
            ]
                .filter(Boolean)
                .join(" ");

    execFile(
        commandPrompt,
        [
            "/d",
            "/s",
            "/c",
            commandLine
        ],
        execOptions,
        callback
    );

    return tool;
}


function runResolvedBuildTool(
    toolName,
    args,
    options = {}
) {
    return new Promise((resolve, reject) => {
        const tool =
            execResolvedBuildTool(
                toolName,
                args,
                options,
                (
                    error,
                    stdout,
                    stderr
                ) => {
                    if (error) {
                        const maintenance = managedMaintenanceContext.getStore();
                        const maintenanceOutput = maintenance ? [...new Set([
                            stderr?.trim?.(), stdout?.trim?.(), error.message
                        ].filter(Boolean))].join("\n\n") : null;
                        const wrapped =
                            new Error(
                                maintenanceOutput ||
                                stderr?.trim?.() ||
                                stdout?.trim?.() ||
                                error.message
                            );

                        wrapped.tool = {
                            name:
                                tool.name,
                            command:
                                tool.command,
                            source:
                                tool.source
                        };

                        reject(
                            wrapped
                        );

                        return;
                    }

                    resolve({
                        tool,
                        stdout:
                            stdout?.trim?.() ?? "",
                        stderr:
                            stderr?.trim?.() ?? ""
                    });
                }
            );
    });
}


function findGlobalNodeExecutable() {
    return new Promise((resolve, reject) => {
        const systemRoot =
            process.env.SystemRoot ||
            "C:\\Windows";

        const whereExecutable =
            join(
                systemRoot,
                "System32",
                "where.exe"
            );

        execFile(
            whereExecutable,
            ["node"],
            {
                windowsHide: true,
                timeout: 5000
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject(
                        new Error(
                            stderr?.trim?.() ||
                            stdout?.trim?.() ||
                            error.message ||
                            "Unable to locate global node.exe."
                        )
                    );

                    return;
                }

                const candidates =
                    stdout
                        .split(/\r?\n/)
                        .map(line =>
                            line.trim()
                        )
                        .filter(Boolean)
                        .filter(candidate =>
                            candidate
                                .toLowerCase()
                                .endsWith(
                                    "node.exe"
                                )
                        );

                const managedPaths =
                    getManagedPaths();

                const managedToolchain =
                    managedPaths?.toolchain
                        ? normalize(
                            managedPaths.toolchain
                        ).toLowerCase()
                        : null;

                const source =
                    candidates.find(candidate => {
                        if (
                            !isRegularNonEmptyFile(
                                candidate
                            )
                        ) {
                            return false;
                        }

                        if (!managedToolchain) {
                            return true;
                        }

                        const normalizedCandidate =
                            normalize(
                                candidate
                            ).toLowerCase();

                        return (
                            normalizedCandidate !==
                            managedToolchain &&
                            !normalizedCandidate.startsWith(
                                `${managedToolchain}\\`
                            ) &&
                            !normalizedCandidate.startsWith(
                                `${managedToolchain}/`
                            )
                        );
                    });

                if (!source) {
                    reject(
                        new Error(
                            "No usable global node.exe was found outside the managed toolchain."
                        )
                    );

                    return;
                }

                resolve(
                    source
                );
            }
        );
    });
}


async function seedManagedNodeFromGlobal() {
    const paths =
        getManagedPaths();

    if (!paths?.toolchain) {
        throw new Error(
            "Managed toolchain path is unavailable."
        );
    }

    const source =
        await findGlobalNodeExecutable();

    const targetDirectory =
        join(
            paths.toolchain,
            "node"
        );

    const target =
        join(
            targetDirectory,
            "node.exe"
        );

    if (existsSync(target)) {
        throw new Error(
            `Refusing Node seed: managed Node already exists at ${target}.`
        );
    }

    const normalizedSource =
        normalize(
            source
        ).toLowerCase();

    const normalizedToolchain =
        normalize(
            paths.toolchain
        ).toLowerCase();

    if (
        normalizedSource ===
        normalizedToolchain ||
        normalizedSource.startsWith(
            `${normalizedToolchain}\\`
        ) ||
        normalizedSource.startsWith(
            `${normalizedToolchain}/`
        )
    ) {
        throw new Error(
            "Refusing Node seed: source node.exe is already inside the managed toolchain."
        );
    }

    const sourceStats =
        statSync(
            source
        );

    if (
        !sourceStats.isFile() ||
        sourceStats.size <= 0
    ) {
        throw new Error(
            `Refusing Node seed: source node.exe is invalid: ${source}`
        );
    }

    const sourceHash =
        getFileSha256(
            source
        );

    mkdirSync(
        targetDirectory,
        {
            recursive: true
        }
    );

    try {
        cpSync(
            source,
            target,
            {
                force: false,
                errorOnExist: true
            }
        );
    } catch (error) {
        throw new Error(
            `Failed to copy global Node into the managed toolchain: ${error?.message ?? "Unknown copy error."}`
        );
    }

    const targetStats =
        statSync(
            target
        );

    const targetHash =
        getFileSha256(
            target
        );

    if (
        targetStats.size !==
        sourceStats.size ||
        targetHash !== sourceHash
    ) {
        throw new Error(
            `Managed Node copy verification failed at ${target}.`
        );
    }

    const version =
        await new Promise((resolve, reject) => {
            execFile(
                target,
                ["--version"],
                {
                    windowsHide: true,
                    timeout: 5000
                },
                (error, stdout, stderr) => {
                    if (error) {
                        reject(
                            new Error(
                                stderr?.trim?.() ||
                                stdout?.trim?.() ||
                                error.message ||
                                "Copied managed Node failed to execute."
                            )
                        );

                        return;
                    }

                    const resolvedVersion =
                        stdout.trim();

                    if (!resolvedVersion) {
                        reject(
                            new Error(
                                "Copied managed Node returned no version."
                            )
                        );

                        return;
                    }

                    resolve(
                        resolvedVersion
                    );
                }
            );
        });

    const resolved =
        resolveManagedBuildTool(
            "node"
        );

    if (
        resolved.source !== "managed" ||
        normalize(
            resolved.command
        ).toLowerCase() !==
        normalize(
            target
        ).toLowerCase()
    ) {
        throw new Error(
            "Managed Node was copied successfully, but the resolver did not prioritize it."
        );
    }

    return {
        ok: true,
        temporaryDevelopmentSeed: true,
        source,
        target,
        version,
        size:
            targetStats.size,
        sha256:
            targetHash,
        resolver: {
            source:
                resolved.source,
            command:
                resolved.command,
            managed:
                resolved.managed === true
        },
        reason:
            "Global node.exe was copied and verified inside the managed toolchain. The original global Node installation was not modified."
    };
}


function getManagedNodeDistributionSpec() {
    if (
        process.platform !== "win32"
    ) {
        throw new Error(
            `Managed Node acquisition currently supports Windows only. Detected platform: ${process.platform}.`
        );
    }

    const architecture =
        process.arch;

    let distributionArchitecture;

    if (
        architecture === "x64"
    ) {
        distributionArchitecture =
            "x64";
    } else if (
        architecture === "arm64"
    ) {
        distributionArchitecture =
            "arm64";
    } else {
        throw new Error(
            `Managed Node acquisition does not support Windows architecture "${architecture}".`
        );
    }

    const version =
        MANAGED_NODE_VERSION;

    const filename =
        `node-v${version}-win-${distributionArchitecture}.zip`;

    const extractedDirectory =
        `node-v${version}-win-${distributionArchitecture}`;

    const releaseRoot =
        `https://${NODE_DISTRIBUTION_HOST}/download/release/v${version}`;

    return {
        version,
        expectedVersionOutput:
            `v${version}`,
        architecture,
        distributionArchitecture,
        filename,
        extractedDirectory,
        releaseRoot,
        shasumsUrl:
            `${releaseRoot}/SHASUMS256.txt`,
        archiveUrl:
            `${releaseRoot}/${filename}`
    };
}


function assertTrustedNodeDistributionUrl(
    rawUrl
) {
    let parsed;

    try {
        parsed =
            new URL(
                rawUrl
            );
    } catch {
        throw new Error(
            `Refusing Node runtime request: invalid URL "${rawUrl}".`
        );
    }

    if (
        parsed.protocol !== "https:" ||
        parsed.hostname.toLowerCase() !==
        NODE_DISTRIBUTION_HOST
    ) {
        throw new Error(
            `Refusing Node runtime request: only HTTPS ${NODE_DISTRIBUTION_HOST} URLs are trusted.`
        );
    }

    return parsed;
}


function getTrustedNodeText(
    rawUrl,
    maxBytes =
        MAX_NODE_SHASUMS_BYTES,
    redirectsRemaining = 3
) {
    return new Promise(
        (resolvePromise, rejectPromise) => {
            const parsed =
                assertTrustedNodeDistributionUrl(
                    rawUrl
                );

            const request =
                https.request(
                    {
                        protocol:
                            parsed.protocol,
                        hostname:
                            parsed.hostname,
                        port:
                            parsed.port || undefined,
                        path:
                            `${parsed.pathname}${parsed.search}`,
                        method:
                            "GET",
                        headers: {
                            "User-Agent":
                                "MaruVencordInstaller/0.1.0",
                            "Accept":
                                "text/plain"
                        }
                    },
                    response => {
                        const statusCode =
                            response.statusCode ?? 0;

                        if (
                            statusCode >= 300 &&
                            statusCode < 400 &&
                            response.headers.location
                        ) {
                            response.resume();

                            if (
                                redirectsRemaining <= 0
                            ) {
                                rejectPromise(
                                    new Error(
                                        "Too many redirects while downloading Node release checksums."
                                    )
                                );

                                return;
                            }

                            const redirectUrl =
                                new URL(
                                    response.headers.location,
                                    parsed
                                ).href;

                            getTrustedNodeText(
                                redirectUrl,
                                maxBytes,
                                redirectsRemaining - 1
                            )
                                .then(resolvePromise)
                                .catch(rejectPromise);

                            return;
                        }

                        if (
                            statusCode < 200 ||
                            statusCode >= 300
                        ) {
                            response.resume();

                            rejectPromise(
                                new Error(
                                    `Node checksum request failed with HTTP ${statusCode}.`
                                )
                            );

                            return;
                        }

                        const chunks = [];
                        let totalBytes = 0;

                        response.on(
                            "data",
                            chunk => {
                                totalBytes +=
                                    chunk.length;

                                if (
                                    totalBytes >
                                    maxBytes
                                ) {
                                    request.destroy(
                                        new Error(
                                            `Node checksum response exceeded the ${maxBytes}-byte safety limit.`
                                        )
                                    );

                                    return;
                                }

                                chunks.push(
                                    chunk
                                );
                            }
                        );

                        response.on(
                            "end",
                            () => {
                                resolvePromise(
                                    Buffer.concat(
                                        chunks
                                    ).toString(
                                        "utf8"
                                    )
                                );
                            }
                        );
                    }
                );

            request.on(
                "error",
                rejectPromise
            );

            request.setTimeout(
                30000,
                () => {
                    request.destroy(
                        new Error(
                            "Timed out while downloading Node release checksums."
                        )
                    );
                }
            );

            request.end();
        }
    );
}


function parseNodeArchiveSha256(
    shasumsText,
    filename
) {
    if (
        typeof shasumsText !== "string" ||
        shasumsText.length === 0
    ) {
        throw new Error(
            "Node release checksum file is empty."
        );
    }

    const matches = [];

    for (
        const rawLine of
        shasumsText.split(
            /\r?\n/
        )
    ) {
        const line =
            rawLine.trim();

        if (!line) {
            continue;
        }

        const match =
            line.match(
                /^([0-9a-fA-F]{64})\s+\*?(.+)$/
            );

        if (!match) {
            continue;
        }

        const candidateFilename =
            match[2].trim();

        if (
            candidateFilename ===
            filename
        ) {
            matches.push(
                match[1].toLowerCase()
            );
        }
    }

    if (
        matches.length !== 1
    ) {
        throw new Error(
            `Expected exactly one SHA-256 entry for ${filename} in Node SHASUMS256.txt, found ${matches.length}.`
        );
    }

    return matches[0];
}


function downloadTrustedNodeArchive(
    rawUrl,
    destinationPath,
    redirectsRemaining = 3
) {
    return new Promise(
        (resolvePromise, rejectPromise) => {
            const parsed =
                assertTrustedNodeDistributionUrl(
                    rawUrl
                );

            const request =
                https.request(
                    {
                        protocol:
                            parsed.protocol,
                        hostname:
                            parsed.hostname,
                        port:
                            parsed.port || undefined,
                        path:
                            `${parsed.pathname}${parsed.search}`,
                        method:
                            "GET",
                        headers: {
                            "User-Agent":
                                "MaruVencordInstaller/0.1.0",
                            "Accept":
                                "application/zip, application/octet-stream"
                        }
                    },
                    response => {
                        const statusCode =
                            response.statusCode ?? 0;

                        if (
                            statusCode >= 300 &&
                            statusCode < 400 &&
                            response.headers.location
                        ) {
                            response.resume();

                            if (
                                redirectsRemaining <= 0
                            ) {
                                rejectPromise(
                                    new Error(
                                        "Too many redirects while downloading the Node runtime archive."
                                    )
                                );

                                return;
                            }

                            const redirectUrl =
                                new URL(
                                    response.headers.location,
                                    parsed
                                ).href;

                            downloadTrustedNodeArchive(
                                redirectUrl,
                                destinationPath,
                                redirectsRemaining - 1
                            )
                                .then(resolvePromise)
                                .catch(rejectPromise);

                            return;
                        }

                        if (
                            statusCode < 200 ||
                            statusCode >= 300
                        ) {
                            response.resume();

                            rejectPromise(
                                new Error(
                                    `Node runtime archive download failed with HTTP ${statusCode}.`
                                )
                            );

                            return;
                        }

                        let totalBytes = 0;

                        const output =
                            createWriteStream(
                                destinationPath,
                                {
                                    flags: "wx"
                                }
                            );

                        let settled = false;

                        const fail = error => {
                            if (settled) {
                                return;
                            }

                            settled = true;

                            output.destroy();
                            response.destroy();

                            rejectPromise(
                                error instanceof Error
                                    ? error
                                    : new Error(
                                        String(
                                            error
                                        )
                                    )
                            );
                        };

                        output.on(
                            "error",
                            fail
                        );

                        response.on(
                            "error",
                            fail
                        );

                        response.on(
                            "data",
                            chunk => {
                                totalBytes +=
                                    chunk.length;

                                if (
                                    totalBytes >
                                    MAX_MANAGED_NODE_ARCHIVE_BYTES
                                ) {
                                    fail(
                                        new Error(
                                            `Node runtime archive exceeded the ${MAX_MANAGED_NODE_ARCHIVE_BYTES}-byte safety limit.`
                                        )
                                    );
                                }
                            }
                        );

                        output.on(
                            "finish",
                            () => {
                                if (settled) {
                                    return;
                                }

                                settled = true;

                                output.close(
                                    () => {
                                        resolvePromise({
                                            finalUrl:
                                                parsed.href,
                                            bytes:
                                                totalBytes
                                        });
                                    }
                                );
                            }
                        );

                        response.pipe(
                            output
                        );
                    }
                );

            request.on(
                "error",
                rejectPromise
            );

            request.setTimeout(
                180000,
                () => {
                    request.destroy(
                        new Error(
                            "Timed out while downloading the Node runtime archive."
                        )
                    );
                }
            );

            request.end();
        }
    );
}


function readManagedNodeRuntimeManifest(
    target
) {
    const manifestPath =
        join(
            target,
            "managed-node-manifest.json"
        );

    if (
        !isRegularNonEmptyFile(
            manifestPath
        )
    ) {
        return {
            available: false,
            manifestPath,
            reason:
                "Managed Node provenance manifest is missing."
        };
    }

    let manifest;

    try {
        manifest =
            JSON.parse(
                readFileSync(
                    manifestPath,
                    "utf8"
                )
            );
    } catch (error) {
        return {
            available: false,
            manifestPath,
            reason:
                `Managed Node provenance manifest is invalid: ${error?.message ?? "Unknown JSON error."}`
        };
    }

    const nodePath =
        join(
            target,
            "node.exe"
        );

    if (
        manifest?.runtime !== "node" ||
        manifest?.version !==
        MANAGED_NODE_VERSION ||
        manifest?.sourceHost !==
        NODE_DISTRIBUTION_HOST ||
        !/^[0-9a-f]{64}$/i.test(
            manifest?.archiveSha256 ?? ""
        ) ||
        !/^[0-9a-f]{64}$/i.test(
            manifest?.nodeExeSha256 ?? ""
        ) ||
        !isRegularNonEmptyFile(
            nodePath
        )
    ) {
        return {
            available: false,
            manifestPath,
            reason:
                "Managed Node provenance manifest or node.exe does not match the expected portable runtime format."
        };
    }

    const nodeExeSha256 =
        getFileSha256(
            nodePath
        );

    if (
        nodeExeSha256.toLowerCase() !==
        manifest.nodeExeSha256
            .toLowerCase()
    ) {
        return {
            available: false,
            manifestPath,
            reason:
                "Managed Node node.exe no longer matches its provenance manifest."
        };
    }

    return {
        available: true,
        manifestPath,
        manifest,
        nodePath,
        nodeExeSha256
    };
}


function runNodeRuntimeProbe(
    nodePath,
    args
) {
    return new Promise(
        (resolvePromise, rejectPromise) => {
            execFile(
                nodePath,
                args,
                {
                    windowsHide: true,
                    timeout: 30000
                },
                (
                    error,
                    stdout,
                    stderr
                ) => {
                    if (error) {
                        rejectPromise(
                            new Error(
                                stderr?.trim?.() ||
                                stdout?.trim?.() ||
                                error.message ||
                                "Managed Node runtime probe failed."
                            )
                        );

                        return;
                    }

                    resolvePromise(
                        stdout.trim()
                    );
                }
            );
        }
    );
}


async function prepareManagedNodeRuntimeAtToolchainRoot(
    toolchainRoot,
    {
        verifyManagedResolver = false
    } = {}
) {
    if (
        typeof toolchainRoot !== "string" ||
        toolchainRoot.length === 0
    ) {
        throw new Error(
            "Managed Node toolchain root is unavailable."
        );
    }

    const spec =
        getManagedNodeDistributionSpec();

    const target =
        join(
            toolchainRoot,
            "node"
        );

    if (
        existsSync(
            target
        )
    ) {
        const existingManifest =
            readManagedNodeRuntimeManifest(
                target
            );

        if (
            existingManifest.available
        ) {
            const existingVersion =
                await runNodeRuntimeProbe(
                    existingManifest.nodePath,
                    [
                        "--version"
                    ]
                );

            const existingArchitecture =
                await runNodeRuntimeProbe(
                    existingManifest.nodePath,
                    [
                        "-p",
                        "process.arch"
                    ]
                );

            if (
                existingVersion ===
                spec.expectedVersionOutput &&
                existingArchitecture ===
                spec.architecture
            ) {
                if (verifyManagedResolver) {
                    const resolvedNode =
                        await inspectManagedBuildTool(
                            "node"
                        );

                    if (
                        resolvedNode.available !== true ||
                        resolvedNode.source !== "managed" ||
                        resolvedNode.version !==
                        spec.expectedVersionOutput ||
                        normalize(
                            resolvedNode.command
                        ).toLowerCase() !==
                        normalize(
                            existingManifest.nodePath
                        ).toLowerCase()
                    ) {
                        throw new Error(
                            "Verified portable Managed Node exists, but the resolver did not select it."
                        );
                    }

                    return {
                        ok: true,
                        state: "ready",
                        alreadyPrepared: true,
                        version:
                            existingVersion,
                        architecture:
                            existingArchitecture,
                        command:
                            resolvedNode.command,
                        source:
                            resolvedNode.source,
                        manifestPath:
                            existingManifest.manifestPath,
                        target,
                        reason:
                            `Verified portable Managed Node ${existingVersion} is already active.`
                    };
                }

                return {
                    ok: true,
                    state: "ready",
                    alreadyPrepared: true,
                    version:
                        existingVersion,
                    architecture:
                        existingArchitecture,
                    command:
                        existingManifest.nodePath,
                    source:
                        "isolated",
                    manifestPath:
                        existingManifest.manifestPath,
                    target,
                    reason:
                        `Verified portable Node ${existingVersion} is already present in the isolated toolchain.`
                };
            }
        }

        throw new Error(
            `Refusing portable Node preparation: ${target} already exists but is not a verified portable Node ${spec.expectedVersionOutput} runtime. Existing contents will not be overwritten.`
        );
    }

    mkdirSync(
        toolchainRoot,
        {
            recursive: true
        }
    );

    const timestamp =
        new Date()
            .toISOString()
            .replace(
                /[:.]/g,
                "-"
            );

    const stagingRoot =
        join(
            toolchainRoot,
            `node-staging-${timestamp}`
        );

    const extractedRoot =
        join(
            stagingRoot,
            "extracted"
        );

    const archivePath =
        join(
            stagingRoot,
            spec.filename
        );

    mkdirSync(
        extractedRoot,
        {
            recursive: true
        }
    );

    const shasumsText =
        await getTrustedNodeText(
            spec.shasumsUrl
        );

    const expectedArchiveSha256 =
        parseNodeArchiveSha256(
            shasumsText,
            spec.filename
        );

    const download =
        await downloadTrustedNodeArchive(
            spec.archiveUrl,
            archivePath
        );

    if (
        !isRegularNonEmptyFile(
            archivePath
        )
    ) {
        throw new Error(
            "Downloaded Node runtime archive is missing or empty."
        );
    }

    const archiveStats =
        statSync(
            archivePath
        );

    if (
        archiveStats.size !==
        download.bytes
    ) {
        throw new Error(
            `Downloaded Node runtime archive size mismatch: stream reported ${download.bytes} bytes, file contains ${archiveStats.size} bytes.`
        );
    }

    const archiveSha256 =
        getFileSha256(
            archivePath
        );

    if (
        archiveSha256.toLowerCase() !==
        expectedArchiveSha256
    ) {
        throw new Error(
            "Downloaded Node runtime archive failed official SHASUMS256.txt verification."
        );
    }

    const archiveHeader =
        readFileSync(
            archivePath
        ).subarray(
            0,
            4
        );

    if (
        archiveHeader.length < 2 ||
        archiveHeader[0] !== 0x50 ||
        archiveHeader[1] !== 0x4b
    ) {
        throw new Error(
            "Downloaded Node runtime archive does not have a valid ZIP signature."
        );
    }

    const extraction =
        await extractZipWithWindowsPowerShell(
            archivePath,
            extractedRoot
        );

    const extractedDistributionRoot =
        join(
            extractedRoot,
            spec.extractedDirectory
        );

    if (
        !existsSync(
            extractedDistributionRoot
        ) ||
        !statSync(
            extractedDistributionRoot
        ).isDirectory()
    ) {
        throw new Error(
            `Extracted Node runtime directory was not found at ${extractedDistributionRoot}.`
        );
    }

    const extractedNodePath =
        join(
            extractedDistributionRoot,
            "node.exe"
        );

    if (
        !isRegularNonEmptyFile(
            extractedNodePath
        )
    ) {
        throw new Error(
            "Extracted Node distribution is missing node.exe."
        );
    }

    const extractedVersion =
        await runNodeRuntimeProbe(
            extractedNodePath,
            [
                "--version"
            ]
        );

    if (
        extractedVersion !==
        spec.expectedVersionOutput
    ) {
        throw new Error(
            `Extracted Node runtime reports ${extractedVersion || "(no version)"}, expected ${spec.expectedVersionOutput}.`
        );
    }

    const extractedArchitecture =
        await runNodeRuntimeProbe(
            extractedNodePath,
            [
                "-p",
                "process.arch"
            ]
        );

    if (
        extractedArchitecture !==
        spec.architecture
    ) {
        throw new Error(
            `Extracted Node runtime reports architecture "${extractedArchitecture}", expected "${spec.architecture}".`
        );
    }

    const extractedPlatform =
        await runNodeRuntimeProbe(
            extractedNodePath,
            [
                "-p",
                "process.platform"
            ]
        );

    if (
        extractedPlatform !== "win32"
    ) {
        throw new Error(
            `Extracted Node runtime reports platform "${extractedPlatform}", expected "win32".`
        );
    }

    const prepared =
        join(
            toolchainRoot,
            `.node-prepared-${timestamp}`
        );

    if (
        existsSync(
            prepared
        )
    ) {
        throw new Error(
            `Managed Node preparation path already exists: ${prepared}`
        );
    }

    mkdirSync(
        prepared,
        {
            recursive: false
        }
    );

    const preparedNodePath =
        join(
            prepared,
            "node.exe"
        );

    cpSync(
        extractedNodePath,
        preparedNodePath,
        {
            force: false,
            errorOnExist: true
        }
    );

    if (
        !isRegularNonEmptyFile(
            preparedNodePath
        )
    ) {
        throw new Error(
            "Prepared managed Node node.exe is missing or empty."
        );
    }

    const extractedNodeStats =
        statSync(
            extractedNodePath
        );

    const preparedNodeStats =
        statSync(
            preparedNodePath
        );

    const extractedNodeSha256 =
        getFileSha256(
            extractedNodePath
        );

    const preparedNodeSha256 =
        getFileSha256(
            preparedNodePath
        );

    if (
        extractedNodeStats.size !==
        preparedNodeStats.size ||
        extractedNodeSha256 !==
        preparedNodeSha256
    ) {
        throw new Error(
            "Prepared managed Node node.exe failed byte-for-byte verification against the verified official archive."
        );
    }

    const preparedVersion =
        await runNodeRuntimeProbe(
            preparedNodePath,
            [
                "--version"
            ]
        );

    const preparedArchitecture =
        await runNodeRuntimeProbe(
            preparedNodePath,
            [
                "-p",
                "process.arch"
            ]
        );

    if (
        preparedVersion !==
        spec.expectedVersionOutput ||
        preparedArchitecture !==
        spec.architecture
    ) {
        throw new Error(
            "Prepared managed Node runtime failed version/architecture verification."
        );
    }

    const runtimeManifest = {
        createdAt:
            new Date()
                .toISOString(),
        runtime:
            "node",
        version:
            spec.version,
        expectedVersionOutput:
            spec.expectedVersionOutput,
        platform:
            "win32",
        architecture:
            spec.architecture,
        distributionArchitecture:
            spec.distributionArchitecture,
        sourceHost:
            NODE_DISTRIBUTION_HOST,
        releaseRoot:
            spec.releaseRoot,
        shasumsUrl:
            spec.shasumsUrl,
        archiveUrl:
            spec.archiveUrl,
        finalArchiveUrl:
            download.finalUrl,
        archiveFilename:
            spec.filename,
        archiveBytes:
            archiveStats.size,
        archiveSha256,
        officialArchiveSha256:
            expectedArchiveSha256,
        nodeExeBytes:
            preparedNodeStats.size,
        nodeExeSha256:
            preparedNodeSha256,
        extraction: {
            method:
                "Windows PowerShell Expand-Archive",
            executable:
                extraction.executable
        },
        contents: [
            "node.exe",
            "managed-node-manifest.json"
        ],
        bundledPackageManagers:
            false
    };

    const manifestPath =
        join(
            prepared,
            "managed-node-manifest.json"
        );

    writeFileSync(
        manifestPath,
        JSON.stringify(
            runtimeManifest,
            null,
            2
        ),
        "utf8"
    );

    const preparedManifestState =
        readManagedNodeRuntimeManifest(
            prepared
        );

    if (
        !preparedManifestState.available
    ) {
        throw new Error(
            preparedManifestState.reason ??
            "Prepared managed Node provenance verification failed."
        );
    }

    if (
        existsSync(
            target
        )
    ) {
        throw new Error(
            `Refusing managed Node promotion: target appeared during verification at ${target}.`
        );
    }

    renameSync(
        prepared,
        target
    );

    const promotedManifestState =
        readManagedNodeRuntimeManifest(
            target
        );

    if (
        !promotedManifestState.available
    ) {
        throw new Error(
            promotedManifestState.reason ??
            "Managed Node was promoted, but provenance verification failed."
        );
    }

    const promotedVersion =
        await runNodeRuntimeProbe(
            promotedManifestState.nodePath,
            [
                "--version"
            ]
        );

    const promotedArchitecture =
        await runNodeRuntimeProbe(
            promotedManifestState.nodePath,
            [
                "-p",
                "process.arch"
            ]
        );

    if (
        promotedVersion !==
        spec.expectedVersionOutput ||
        promotedArchitecture !==
        spec.architecture
    ) {
        throw new Error(
            "Promoted portable Node runtime failed final version/architecture verification."
        );
    }

    if (verifyManagedResolver) {
        const resolvedNode =
            await inspectManagedBuildTool(
                "node"
            );

        if (
            resolvedNode.available !== true ||
            resolvedNode.source !== "managed" ||
            resolvedNode.version !==
            spec.expectedVersionOutput ||
            normalize(
                resolvedNode.command
            ).toLowerCase() !==
            normalize(
                promotedManifestState.nodePath
            ).toLowerCase()
        ) {
            throw new Error(
                "Portable Managed Node was promoted, but the resolver did not select the exact managed runtime."
            );
        }

        return {
            ok: true,
            state: "ready",
            alreadyPrepared: false,
            version:
                resolvedNode.version,
            architecture:
                spec.architecture,
            command:
                resolvedNode.command,
            source:
                resolvedNode.source,
            target,
            manifestPath:
                promotedManifestState.manifestPath,
            releaseRoot:
                spec.releaseRoot,
            shasumsUrl:
                spec.shasumsUrl,
            archiveUrl:
                spec.archiveUrl,
            archiveBytes:
                archiveStats.size,
            archiveSha256,
            officialArchiveSha256:
                expectedArchiveSha256,
            nodeExeSha256:
                promotedManifestState.nodeExeSha256,
            bundledPackageManagers:
                false,
            reason:
                `Portable Managed Node ${resolvedNode.version} was downloaded from the official Node.js release archive, verified against SHASUMS256.txt, reduced to the required node.exe runtime, and safely promoted without modifying any global Node installation.`
        };
    }

    return {
        ok: true,
        state: "ready",
        alreadyPrepared: false,
        version:
            promotedVersion,
        architecture:
            promotedArchitecture,
        command:
            promotedManifestState.nodePath,
        source:
            "isolated",
        target,
        manifestPath:
            promotedManifestState.manifestPath,
        releaseRoot:
            spec.releaseRoot,
        shasumsUrl:
            spec.shasumsUrl,
        archiveUrl:
            spec.archiveUrl,
        archiveBytes:
            archiveStats.size,
        archiveSha256,
        officialArchiveSha256:
            expectedArchiveSha256,
        nodeExeSha256:
            promotedManifestState.nodeExeSha256,
        bundledPackageManagers:
            false,
        reason:
            `Portable Node ${promotedVersion} was downloaded, checksum-verified, extracted, validated, and safely promoted inside the isolated test toolchain.`
    };
}


let activeManagedNodeSeedUpgrade = false;


async function upgradeTemporaryManagedNodeSeedToVerifiedPortableNode() {
    if (app.isPackaged) {
        throw new Error(
            "Temporary managed Node seed upgrade is a development-only maintenance operation."
        );
    }

    if (activeManagedNodeSeedUpgrade) {
        throw new Error(
            "Temporary managed Node seed upgrade is already running."
        );
    }

    activeManagedNodeSeedUpgrade = true;

    const paths =
        getManagedPaths();

    let target = null;
    let backup = null;
    let quarantine = null;
    let stagingToolchainRoot = null;
    let seedMovedToBackup = false;
    let verifiedRuntimePromoted = false;

    try {
        if (!paths?.toolchain) {
            throw new Error(
                "Managed toolchain path is unavailable."
            );
        }

        const spec =
            getManagedNodeDistributionSpec();

        target =
            join(
                paths.toolchain,
                "node"
            );

        const normalizedToolchain =
            normalize(
                resolve(
                    paths.toolchain
                )
            ).toLowerCase();

        const normalizedTargetParent =
            normalize(
                dirname(
                    resolve(
                        target
                    )
                )
            ).toLowerCase();

        if (
            normalizedTargetParent !==
            normalizedToolchain
        ) {
            throw new Error(
                "Managed Node seed target failed direct-child safety validation."
            );
        }

        if (
            !existsSync(
                target
            ) ||
            !statSync(
                target
            ).isDirectory()
        ) {
            throw new Error(
                `Temporary managed Node seed was not found at ${target}.`
            );
        }

        const existingManifest =
            readManagedNodeRuntimeManifest(
                target
            );

        if (
            existingManifest.available
        ) {
            throw new Error(
                "Managed Node is already an officially verified portable runtime; no seed upgrade is required."
            );
        }

        const seedEntries =
            readdirSync(
                target,
                {
                    withFileTypes: true
                }
            );

        if (
            seedEntries.length !== 1 ||
            !seedEntries[0].isFile() ||
            seedEntries[0].name.toLowerCase() !==
            "node.exe"
        ) {
            throw new Error(
                "Refusing temporary Node seed upgrade: the existing managed Node directory is not the exact legacy seed shape (node.exe only)."
            );
        }

        const seedNodePath =
            join(
                target,
                "node.exe"
            );

        if (
            !isRegularNonEmptyFile(
                seedNodePath
            )
        ) {
            throw new Error(
                "Refusing temporary Node seed upgrade: node.exe is missing or empty."
            );
        }

        const seedVersion =
            await runNodeRuntimeProbe(
                seedNodePath,
                [
                    "--version"
                ]
            );

        const seedArchitecture =
            await runNodeRuntimeProbe(
                seedNodePath,
                [
                    "-p",
                    "process.arch"
                ]
            );

        const seedPlatform =
            await runNodeRuntimeProbe(
                seedNodePath,
                [
                    "-p",
                    "process.platform"
                ]
            );

        if (
            seedVersion !==
            spec.expectedVersionOutput ||
            seedArchitecture !==
            spec.architecture ||
            seedPlatform !== "win32"
        ) {
            throw new Error(
                `Refusing temporary Node seed upgrade: existing seed reports version=${seedVersion || "?"}, architecture=${seedArchitecture || "?"}, platform=${seedPlatform || "?"}; expected ${spec.expectedVersionOutput}, ${spec.architecture}, win32.`
            );
        }

        const seedStats =
            statSync(
                seedNodePath
            );

        const seedSha256 =
            getFileSha256(
                seedNodePath
            );

        const timestamp =
            new Date()
                .toISOString()
                .replace(
                    /[:.]/g,
                    "-"
                );

        stagingToolchainRoot =
            join(
                paths.toolchain,
                `.node-verified-upgrade-staging-${timestamp}`
            );

        backup =
            join(
                paths.toolchain,
                `node-development-seed-backup-${timestamp}`
            );

        quarantine =
            join(
                paths.toolchain,
                `node-failed-verified-upgrade-${timestamp}`
            );

        for (
            const candidate of
            [
                stagingToolchainRoot,
                backup,
                quarantine
            ]
        ) {
            if (
                existsSync(
                    candidate
                )
            ) {
                throw new Error(
                    `Refusing temporary Node seed upgrade: safety destination already exists at ${candidate}.`
                );
            }

            const candidateParent =
                normalize(
                    dirname(
                        resolve(
                            candidate
                        )
                    )
                ).toLowerCase();

            if (
                candidateParent !==
                normalizedToolchain
            ) {
                throw new Error(
                    `Temporary Node seed upgrade path failed direct-child safety validation: ${candidate}`
                );
            }
        }

        // IMPORTANT:
        // Build and fully verify the official portable runtime BEFORE the
        // current development seed is moved.
        const prepared =
            await prepareManagedNodeRuntimeAtToolchainRoot(
                stagingToolchainRoot,
                {
                    verifyManagedResolver: false
                }
            );

        const preparedTarget =
            join(
                stagingToolchainRoot,
                "node"
            );

        const preparedManifest =
            readManagedNodeRuntimeManifest(
                preparedTarget
            );

        if (
            prepared?.ok !== true ||
            !preparedManifest.available
        ) {
            throw new Error(
                "Official portable Node was not fully verified in upgrade staging."
            );
        }

        const preparedVersion =
            await runNodeRuntimeProbe(
                preparedManifest.nodePath,
                [
                    "--version"
                ]
            );

        const preparedArchitecture =
            await runNodeRuntimeProbe(
                preparedManifest.nodePath,
                [
                    "-p",
                    "process.arch"
                ]
            );

        const preparedPlatform =
            await runNodeRuntimeProbe(
                preparedManifest.nodePath,
                [
                    "-p",
                    "process.platform"
                ]
            );

        if (
            preparedVersion !==
            spec.expectedVersionOutput ||
            preparedArchitecture !==
            spec.architecture ||
            preparedPlatform !==
            "win32"
        ) {
            throw new Error(
                "Verified portable Node staging failed final pre-swap runtime probes."
            );
        }

        // Same-volume atomic backup of the old development seed.
        renameSync(
            target,
            backup
        );

        seedMovedToBackup = true;

        if (
            existsSync(
                target
            )
        ) {
            throw new Error(
                "Managed Node target unexpectedly reappeared after backing up the development seed."
            );
        }

        // Same-volume promotion of the already-verified official runtime.
        renameSync(
            preparedTarget,
            target
        );

        verifiedRuntimePromoted = true;

        const promotedManifest =
            readManagedNodeRuntimeManifest(
                target
            );

        if (
            !promotedManifest.available
        ) {
            throw new Error(
                promotedManifest.reason ??
                "Promoted portable Node provenance verification failed."
            );
        }

        const promotedVersion =
            await runNodeRuntimeProbe(
                promotedManifest.nodePath,
                [
                    "--version"
                ]
            );

        const promotedArchitecture =
            await runNodeRuntimeProbe(
                promotedManifest.nodePath,
                [
                    "-p",
                    "process.arch"
                ]
            );

        const promotedPlatform =
            await runNodeRuntimeProbe(
                promotedManifest.nodePath,
                [
                    "-p",
                    "process.platform"
                ]
            );

        if (
            promotedVersion !==
            spec.expectedVersionOutput ||
            promotedArchitecture !==
            spec.architecture ||
            promotedPlatform !==
            "win32"
        ) {
            throw new Error(
                "Promoted verified portable Node failed final runtime probes."
            );
        }

        const resolvedNode =
            await inspectManagedBuildTool(
                "node"
            );

        if (
            resolvedNode.available !== true ||
            resolvedNode.source !== "managed" ||
            resolvedNode.version !==
            spec.expectedVersionOutput ||
            normalize(
                resolvedNode.command
            ).toLowerCase() !==
            normalize(
                promotedManifest.nodePath
            ).toLowerCase()
        ) {
            throw new Error(
                "Verified portable Node was promoted, but the managed resolver did not select the exact promoted runtime."
            );
        }

        const backupNodePath =
            join(
                backup,
                "node.exe"
            );

        if (
            !isRegularNonEmptyFile(
                backupNodePath
            ) ||
            getFileSha256(
                backupNodePath
            ) !==
            seedSha256 ||
            statSync(
                backupNodePath
            ).size !==
            seedStats.size
        ) {
            throw new Error(
                "Legacy development seed backup failed byte-for-byte preservation verification."
            );
        }

        const upgradeManifestPath =
            join(
                paths.toolchain,
                `managed-node-seed-upgrade-${timestamp}.json`
            );

        const upgradeManifest = {
            completedAt:
                new Date()
                    .toISOString(),
            developmentOnly:
                true,
            operation:
                "temporary-development-seed-to-verified-portable-node",
            target,
            backup,
            stagingToolchainRoot,
            oldSeed: {
                path:
                    backupNodePath,
                version:
                    seedVersion,
                architecture:
                    seedArchitecture,
                platform:
                    seedPlatform,
                bytes:
                    seedStats.size,
                sha256:
                    seedSha256,
                provenanceManifest:
                    false
            },
            verifiedPortableNode: {
                path:
                    promotedManifest.nodePath,
                manifestPath:
                    promotedManifest.manifestPath,
                version:
                    promotedVersion,
                architecture:
                    promotedArchitecture,
                platform:
                    promotedPlatform,
                sha256:
                    promotedManifest.nodeExeSha256,
                provenanceManifest:
                    true,
                sourceHost:
                    NODE_DISTRIBUTION_HOST
            },
            preservation: {
                oldSeedDeleted:
                    false,
                oldSeedBackupVerified:
                    true,
                overwriteUsed:
                    false,
                discordTouched:
                    false,
                vencordSourceTouched:
                    false,
                pluginPayloadTouched:
                    false,
                migrationBackupsTouched:
                    false
            }
        };

        writeFileSync(
            upgradeManifestPath,
            JSON.stringify(
                upgradeManifest,
                null,
                2
            ),
            "utf8"
        );

        return {
            ok: true,
            state:
                "upgraded",
            developmentOnly:
                true,
            target,
            backup,
            stagingToolchainRoot,
            upgradeManifestPath,
            oldSeed: {
                version:
                    seedVersion,
                architecture:
                    seedArchitecture,
                bytes:
                    seedStats.size,
                sha256:
                    seedSha256
            },
            verifiedPortableNode: {
                version:
                    promotedVersion,
                architecture:
                    promotedArchitecture,
                command:
                    resolvedNode.command,
                manifestPath:
                    promotedManifest.manifestPath,
                sha256:
                    promotedManifest.nodeExeSha256,
                source:
                    resolvedNode.source
            },
            oldSeedBackupPreserved:
                true,
            productionManagedNodeVerified:
                true,
            discordTouched:
                false,
            reason:
                `Temporary development Node seed was preserved at ${backup}, and officially verified portable Node ${promotedVersion} is now active at ${target}.`
        };
    } catch (error) {
        let rollback = {
            attempted:
                false,
            restoredLegacySeed:
                false,
            quarantinedFailedPromotion:
                false
        };

        if (
            seedMovedToBackup
        ) {
            rollback.attempted =
                true;

            try {
                if (
                    verifiedRuntimePromoted &&
                    target &&
                    existsSync(
                        target
                    )
                ) {
                    if (
                        !quarantine ||
                        existsSync(
                            quarantine
                        )
                    ) {
                        throw new Error(
                            "Unable to quarantine failed promoted runtime without overwrite."
                        );
                    }

                    renameSync(
                        target,
                        quarantine
                    );

                    rollback.quarantinedFailedPromotion =
                        true;
                }

                if (
                    target &&
                    !existsSync(
                        target
                    ) &&
                    backup &&
                    existsSync(
                        backup
                    )
                ) {
                    renameSync(
                        backup,
                        target
                    );

                    rollback.restoredLegacySeed =
                        true;
                }
            } catch (rollbackError) {
                throw new Error(
                    `Temporary managed Node seed upgrade failed: ${error?.message ?? "Unknown error."} Rollback also failed: ${rollbackError?.message ?? "Unknown rollback error."}`
                );
            }
        }

        const suffix =
            rollback.attempted
                ? rollback.restoredLegacySeed
                    ? " Legacy development seed was restored."
                    : " Rollback was attempted but did not restore the legacy seed."
                : "";

        throw new Error(
            `Temporary managed Node seed upgrade failed: ${error?.message ?? "Unknown error."}${suffix}`
        );
    } finally {
        activeManagedNodeSeedUpgrade =
            false;
    }
}


async function prepareManagedNodeRuntime() {
    const paths =
        getManagedPaths();

    if (!paths?.toolchain) {
        throw new Error(
            "Managed toolchain path is unavailable."
        );
    }

    return prepareManagedNodeRuntimeAtToolchainRoot(
        paths.toolchain,
        {
            verifyManagedResolver: true
        }
    );
}


async function prepareIsolatedPortableNodeRuntimeTest() {
    const paths =
        getManagedPaths();

    if (!paths?.root) {
        throw new Error(
            "Managed workspace root is unavailable."
        );
    }

    const isolatedToolchainRoot =
        join(
            paths.root,
            "portable-node-test-toolchain"
        );

    const productionToolchain =
        resolve(
            paths.toolchain
        ).toLowerCase();

    const isolatedToolchain =
        resolve(
            isolatedToolchainRoot
        ).toLowerCase();

    if (
        isolatedToolchain ===
        productionToolchain ||
        isPathInsideOrSame(
            productionToolchain,
            isolatedToolchainRoot
        ) ||
        isPathInsideOrSame(
            isolatedToolchainRoot,
            productionToolchain
        )
    ) {
        throw new Error(
            "Refusing isolated Node test: test toolchain overlaps the production managed toolchain."
        );
    }

    const result =
        await prepareManagedNodeRuntimeAtToolchainRoot(
            isolatedToolchainRoot,
            {
                verifyManagedResolver: false
            }
        );

    return {
        ...result,
        testOnly: true,
        isolatedToolchainRoot,
        productionToolchainUntouched:
            true,
        productionToolchain:
            paths.toolchain,
        reason:
            `${result.reason} Production managed toolchain was not used as the test destination.`
    };
}


function assertTrustedNpmRegistryUrl(
    rawUrl
) {
    let parsed;

    try {
        parsed =
            new URL(
                rawUrl
            );
    } catch {
        throw new Error(
            `Refusing pnpm runtime request: invalid URL "${rawUrl}".`
        );
    }

    if (
        parsed.protocol !== "https:" ||
        parsed.hostname.toLowerCase() !==
        NPM_REGISTRY_HOST
    ) {
        throw new Error(
            `Refusing pnpm runtime request: only HTTPS ${NPM_REGISTRY_HOST} URLs are trusted.`
        );
    }

    return parsed;
}


function getTrustedNpmJson(
    rawUrl,
    redirectsRemaining = 3
) {
    return new Promise(
        (resolvePromise, rejectPromise) => {
            const parsed =
                assertTrustedNpmRegistryUrl(
                    rawUrl
                );

            const request =
                https.request(
                    {
                        protocol:
                            parsed.protocol,
                        hostname:
                            parsed.hostname,
                        port:
                            parsed.port || undefined,
                        path:
                            `${parsed.pathname}${parsed.search}`,
                        method:
                            "GET",
                        headers: {
                            "User-Agent":
                                "MaruVencordInstaller/0.1.0",
                            "Accept":
                                "application/json"
                        }
                    },
                    response => {
                        const statusCode =
                            response.statusCode ?? 0;

                        if (
                            statusCode >= 300 &&
                            statusCode < 400 &&
                            response.headers.location
                        ) {
                            response.resume();

                            if (
                                redirectsRemaining <= 0
                            ) {
                                rejectPromise(
                                    new Error(
                                        "Too many redirects while resolving pnpm package metadata."
                                    )
                                );

                                return;
                            }

                            const redirectUrl =
                                new URL(
                                    response.headers.location,
                                    parsed
                                ).href;

                            getTrustedNpmJson(
                                redirectUrl,
                                redirectsRemaining - 1
                            )
                                .then(resolvePromise)
                                .catch(rejectPromise);

                            return;
                        }

                        if (
                            statusCode < 200 ||
                            statusCode >= 300
                        ) {
                            response.resume();

                            rejectPromise(
                                new Error(
                                    `pnpm metadata request failed with HTTP ${statusCode}.`
                                )
                            );

                            return;
                        }

                        const chunks = [];
                        let totalBytes = 0;
                        const maxBytes =
                            2 * 1024 * 1024;

                        response.on(
                            "data",
                            chunk => {
                                totalBytes +=
                                    chunk.length;

                                if (
                                    totalBytes >
                                    maxBytes
                                ) {
                                    request.destroy(
                                        new Error(
                                            "pnpm metadata response exceeded the allowed size."
                                        )
                                    );

                                    return;
                                }

                                chunks.push(
                                    chunk
                                );
                            }
                        );

                        response.on(
                            "end",
                            () => {
                                try {
                                    resolvePromise(
                                        JSON.parse(
                                            Buffer.concat(
                                                chunks
                                            ).toString(
                                                "utf8"
                                            )
                                        )
                                    );
                                } catch (error) {
                                    rejectPromise(
                                        new Error(
                                            `Unable to parse pnpm package metadata: ${error?.message ?? "Unknown JSON error."}`
                                        )
                                    );
                                }
                            }
                        );
                    }
                );

            request.on(
                "error",
                rejectPromise
            );

            request.setTimeout(
                30000,
                () => {
                    request.destroy(
                        new Error(
                            "Timed out while resolving pnpm package metadata."
                        )
                    );
                }
            );

            request.end();
        }
    );
}


function downloadTrustedNpmTarball(
    rawUrl,
    destinationPath,
    redirectsRemaining = 3
) {
    return new Promise(
        (resolvePromise, rejectPromise) => {
            const parsed =
                assertTrustedNpmRegistryUrl(
                    rawUrl
                );

            const request =
                https.request(
                    {
                        protocol:
                            parsed.protocol,
                        hostname:
                            parsed.hostname,
                        port:
                            parsed.port || undefined,
                        path:
                            `${parsed.pathname}${parsed.search}`,
                        method:
                            "GET",
                        headers: {
                            "User-Agent":
                                "MaruVencordInstaller/0.1.0",
                            "Accept":
                                "application/octet-stream"
                        }
                    },
                    response => {
                        const statusCode =
                            response.statusCode ?? 0;

                        if (
                            statusCode >= 300 &&
                            statusCode < 400 &&
                            response.headers.location
                        ) {
                            response.resume();

                            if (
                                redirectsRemaining <= 0
                            ) {
                                rejectPromise(
                                    new Error(
                                        "Too many redirects while downloading pnpm."
                                    )
                                );

                                return;
                            }

                            const redirectUrl =
                                new URL(
                                    response.headers.location,
                                    parsed
                                ).href;

                            downloadTrustedNpmTarball(
                                redirectUrl,
                                destinationPath,
                                redirectsRemaining - 1
                            )
                                .then(resolvePromise)
                                .catch(rejectPromise);

                            return;
                        }

                        if (
                            statusCode < 200 ||
                            statusCode >= 300
                        ) {
                            response.resume();

                            rejectPromise(
                                new Error(
                                    `pnpm tarball download failed with HTTP ${statusCode}.`
                                )
                            );

                            return;
                        }

                        let totalBytes = 0;

                        const output =
                            createWriteStream(
                                destinationPath,
                                {
                                    flags: "wx"
                                }
                            );

                        let settled = false;

                        const fail = error => {
                            if (settled) {
                                return;
                            }

                            settled = true;

                            output.destroy();
                            response.destroy();

                            rejectPromise(
                                error instanceof Error
                                    ? error
                                    : new Error(
                                        String(
                                            error
                                        )
                                    )
                            );
                        };

                        output.on(
                            "error",
                            fail
                        );

                        response.on(
                            "error",
                            fail
                        );

                        response.on(
                            "data",
                            chunk => {
                                totalBytes +=
                                    chunk.length;

                                if (
                                    totalBytes >
                                    MAX_MANAGED_PNPM_ARCHIVE_BYTES
                                ) {
                                    fail(
                                        new Error(
                                            `pnpm tarball exceeded the ${MAX_MANAGED_PNPM_ARCHIVE_BYTES}-byte safety limit.`
                                        )
                                    );
                                }
                            }
                        );

                        output.on(
                            "finish",
                            () => {
                                if (settled) {
                                    return;
                                }

                                settled = true;

                                output.close(
                                    () => {
                                        resolvePromise({
                                            finalUrl:
                                                parsed.href,
                                            bytes:
                                                totalBytes
                                        });
                                    }
                                );
                            }
                        );

                        response.pipe(
                            output
                        );
                    }
                );

            request.on(
                "error",
                rejectPromise
            );

            request.setTimeout(
                120000,
                () => {
                    request.destroy(
                        new Error(
                            "Timed out while downloading pnpm."
                        )
                    );
                }
            );

            request.end();
        }
    );
}


function verifyPackageIntegrity(
    filePath,
    integrity
) {
    if (
        typeof integrity !== "string" ||
        integrity.trim().length === 0
    ) {
        throw new Error(
            "pnpm package metadata did not provide an integrity value."
        );
    }

    const candidates =
        integrity
            .trim()
            .split(/\s+/)
            .map(token => {
                const separator =
                    token.indexOf("-");

                if (separator <= 0) {
                    return null;
                }

                return {
                    algorithm:
                        token
                            .slice(
                                0,
                                separator
                            )
                            .toLowerCase(),
                    digest:
                        token.slice(
                            separator + 1
                        )
                };
            })
            .filter(Boolean)
            .filter(candidate =>
                [
                    "sha512",
                    "sha384",
                    "sha256"
                ].includes(
                    candidate.algorithm
                )
            );

    if (
        candidates.length === 0
    ) {
        throw new Error(
            "pnpm package integrity does not contain a supported SHA digest."
        );
    }

    const fileBuffer =
        readFileSync(
            filePath
        );

    const matched =
        candidates.some(candidate => {
            const calculated =
                createHash(
                    candidate.algorithm
                )
                    .update(
                        fileBuffer
                    )
                    .digest(
                        "base64"
                    );

            return (
                calculated ===
                candidate.digest
            );
        });

    if (!matched) {
        throw new Error(
            "Downloaded pnpm package failed registry integrity verification."
        );
    }

    return {
        verified: true,
        integrity
    };
}


function extractTgzWithWindowsTar(
    archivePath,
    destinationPath
) {
    return new Promise(
        (resolvePromise, rejectPromise) => {
            const systemRoot =
                process.env.SystemRoot ||
                "C:\\Windows";

            const bundledTar =
                join(
                    systemRoot,
                    "System32",
                    "tar.exe"
                );

            const tarExecutable =
                existsSync(
                    bundledTar
                )
                    ? bundledTar
                    : "tar.exe";

            execFile(
                tarExecutable,
                [
                    "-xzf",
                    archivePath,
                    "-C",
                    destinationPath
                ],
                {
                    windowsHide: true,
                    timeout: 120000
                },
                (
                    error,
                    stdout,
                    stderr
                ) => {
                    if (error) {
                        rejectPromise(
                            new Error(
                                stderr?.trim?.() ||
                                stdout?.trim?.() ||
                                error.message ||
                                "Windows tar failed to extract pnpm."
                            )
                        );

                        return;
                    }

                    resolvePromise({
                        executable:
                            tarExecutable,
                        output:
                            stdout?.trim?.() ?? "",
                        warnings:
                            stderr?.trim?.() ?? ""
                    });
                }
            );
        }
    );
}


function validateExtractedPnpmPackage(
    packageRoot,
    requiredVersion
) {
    const packagePath =
        join(
            packageRoot,
            "package.json"
        );

    if (
        !isRegularNonEmptyFile(
            packagePath
        )
    ) {
        throw new Error(
            "Extracted pnpm package.json is missing or empty."
        );
    }

    let packageJson;

    try {
        packageJson =
            JSON.parse(
                readFileSync(
                    packagePath,
                    "utf8"
                )
            );
    } catch (error) {
        throw new Error(
            `Extracted pnpm package.json is invalid: ${error?.message ?? "Unknown JSON error."}`
        );
    }

    if (
        packageJson?.name !== "pnpm" ||
        packageJson?.version !==
        requiredVersion
    ) {
        throw new Error(
            `Extracted package is ${packageJson?.name ?? "unknown"}@${packageJson?.version ?? "unknown"}, expected pnpm@${requiredVersion}.`
        );
    }

    const binValue =
        typeof packageJson?.bin === "string"
            ? packageJson.bin
            : packageJson?.bin?.pnpm;

    if (
        typeof binValue !== "string" ||
        binValue.length === 0
    ) {
        throw new Error(
            "Extracted pnpm package does not declare a pnpm executable."
        );
    }

    const binPath =
        resolve(
            packageRoot,
            binValue
        );

    if (
        !isPathInsideOrSame(
            packageRoot,
            binPath
        ) ||
        !isRegularNonEmptyFile(
            binPath
        )
    ) {
        throw new Error(
            "Extracted pnpm executable is missing or resolves outside the package directory."
        );
    }

    return {
        packagePath,
        packageRoot:
            resolve(
                packageRoot
            ),
        version:
            packageJson.version,
        bin:
            binValue,
        binPath
    };
}


function writeManagedPnpmWrapper(
    wrapperPath,
    packageBinRelativePath,
    nodeRelativePath = "..\\node\\node.exe"
) {
    const normalizedBin =
        packageBinRelativePath
            .replace(
                /\//g,
                "\\"
            );

    const wrapper = [
        "@echo off",
        "setlocal",
        `set "MARU_NODE=%~dp0${nodeRelativePath}"`,
        'if not exist "%MARU_NODE%" (',
        "  echo Managed Node runtime not found. 1>&2",
        "  exit /b 1",
        ")",
        `"%MARU_NODE%" "%~dp0package\\${normalizedBin}" %*`,
        "exit /b %ERRORLEVEL%",
        ""
    ].join(
        "\r\n"
    );

    writeFileSync(
        wrapperPath,
        wrapper,
        "utf8"
    );
}


async function prepareManagedPnpmRuntime({ sourceRoot = null } = {}) {
    const paths =
        getManagedPaths();

    if (!paths?.toolchain) {
        throw new Error(
            "Managed toolchain path is unavailable."
        );
    }

    const requirement =
        sourceRoot ? { available: true, ...getVencordPackageManagerAtSource(sourceRoot) } : getManagedPackageManagerRequirement();

    if (
        requirement?.available !== true ||
        typeof requirement?.packageManager !==
        "string"
    ) {
        throw new Error(
            requirement?.reason ??
            "Managed Vencord package-manager requirement is unavailable."
        );
    }

    const match =
        requirement.packageManager.match(
            /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
        );

    if (!match) {
        throw new Error(
            `Unsupported managed package-manager requirement: "${requirement.packageManager}".`
        );
    }

    const requiredVersion =
        match[1];

    const managedNode =
        await inspectManagedBuildTool(
            "node"
        );

    if (
        managedNode.available !== true ||
        managedNode.source !== "managed"
    ) {
        throw new Error(
            "Managed pnpm preparation requires the managed Node runtime to be active first."
        );
    }

    const currentPnpm =
        await inspectManagedBuildTool(
            "pnpm"
        );

    if (
        currentPnpm.available === true &&
        currentPnpm.source === "managed" &&
        (!sourceRoot || currentPnpm.runtimeKind === "managed-node-script") &&
        currentPnpm.version ===
        requiredVersion
    ) {
        return {
            ok: true,
            state: "ready",
            alreadyPrepared: true,
            requiredVersion,
            version:
                currentPnpm.version,
            command:
                currentPnpm.command,
            runtimeKind:
                currentPnpm.runtimeKind ??
                null,
            reason:
                `Managed pnpm ${requiredVersion} is already active.`
        };
    }

    const legacyTarget = join(paths.toolchain, "pnpm");
    const target = sourceRoot || existsSync(legacyTarget)
        ? join(paths.toolchain, "pnpm-versions", requiredVersion)
        : legacyTarget;
    assertSafePath(target);
    if (existsSync(target)) {
        const existing = resolveManagedPnpmPackageRuntime(paths, target);
        if (!existing || existing.managedPackageVersion !== requiredVersion)
            throw new Error(`Managed pnpm cache is occupied but does not verify as pnpm ${requiredVersion}: ${target}. It was kept unchanged.`);
        const version = await runNodeRuntimeProbe(existing.executable, [existing.binPath, "--version"]);
        if (version.trim() !== requiredVersion) throw new Error("Cached managed pnpm failed its version probe; existing files were kept.");
        return { ok: true, state: "ready", alreadyPrepared: true, requiredVersion, version: requiredVersion, command: existing.command, target };
    }
    mkdirSync(dirname(target), { recursive: true });

    mkdirSync(
        paths.toolchain,
        {
            recursive: true
        }
    );

    const timestamp =
        new Date()
            .toISOString()
            .replace(
                /[:.]/g,
                "-"
            );

    const stagingRoot =
        join(
            paths.toolchain,
            `pnpm-staging-${timestamp}`
        );

    const extractedRoot =
        join(
            stagingRoot,
            "extracted"
        );

    const archivePath =
        join(
            stagingRoot,
            `pnpm-${requiredVersion}.tgz`
        );

    mkdirSync(
        extractedRoot,
        {
            recursive: true
        }
    );

    const metadataUrl =
        `https://${NPM_REGISTRY_HOST}/pnpm/${encodeURIComponent(requiredVersion)}`;

    const metadata =
        await getTrustedNpmJson(
            metadataUrl
        );

    if (
        metadata?.name !== "pnpm" ||
        metadata?.version !==
        requiredVersion
    ) {
        throw new Error(
            `npm registry metadata returned ${metadata?.name ?? "unknown"}@${metadata?.version ?? "unknown"}, expected pnpm@${requiredVersion}.`
        );
    }

    const tarballUrl =
        metadata?.dist?.tarball;

    const integrity =
        metadata?.dist?.integrity;

    if (
        typeof tarballUrl !== "string"
    ) {
        throw new Error(
            "pnpm registry metadata did not provide a tarball URL."
        );
    }

    assertTrustedNpmRegistryUrl(
        tarballUrl
    );

    const download =
        await downloadTrustedNpmTarball(
            tarballUrl,
            archivePath
        );

    if (
        !isRegularNonEmptyFile(
            archivePath
        )
    ) {
        throw new Error(
            "Downloaded pnpm archive is missing or empty."
        );
    }

    const integrityResult =
        verifyPackageIntegrity(
            archivePath,
            integrity
        );

    const extraction =
        await extractTgzWithWindowsTar(
            archivePath,
            extractedRoot
        );

    const extractedPackageRoot =
        join(
            extractedRoot,
            "package"
        );

    const validation =
        validateExtractedPnpmPackage(
            extractedPackageRoot,
            requiredVersion
        );

    const prepared =
        join(
            paths.toolchain,
            `.pnpm-prepared-${timestamp}`
        );

    if (
        existsSync(
            prepared
        )
    ) {
        throw new Error(
            `Managed pnpm preparation path already exists: ${prepared}`
        );
    }

    mkdirSync(
        prepared,
        {
            recursive: false
        }
    );

    const preparedPackage =
        join(
            prepared,
            "package"
        );

    cpSync(
        validation.packageRoot,
        preparedPackage,
        {
            recursive: true,
            force: false,
            errorOnExist: true
        }
    );

    const sourceFiles =
        getBackupFileManifest(
            validation.packageRoot
        );

    const preparedFiles =
        getBackupFileManifest(
            preparedPackage
        );

    const copyVerification =
        verifyBackupFileManifests(
            sourceFiles,
            preparedFiles
        );

    if (!copyVerification.verified) {
        throw new Error(
            `Managed pnpm prepared package failed byte-for-byte verification: ${copyVerification.reason}`
        );
    }

    const wrapperPath =
        join(
            prepared,
            "pnpm.cmd"
        );

    writeManagedPnpmWrapper(
        wrapperPath,
        validation.bin,
        relative(target, managedNode.command)
    );

    if (
        !isRegularNonEmptyFile(
            wrapperPath
        )
    ) {
        throw new Error(
            "Managed pnpm wrapper was not created correctly."
        );
    }

    const preparedBinPath =
        resolve(
            preparedPackage,
            validation.bin
        );

    if (
        !isPathInsideOrSame(
            preparedPackage,
            preparedBinPath
        ) ||
        !isRegularNonEmptyFile(
            preparedBinPath
        )
    ) {
        throw new Error(
            "Prepared managed pnpm executable is missing or resolves outside the prepared package directory."
        );
    }

    const preparedVersion =
        await new Promise(
            (resolvePromise, rejectPromise) => {
                execFile(
                    managedNode.command,
                    [
                        preparedBinPath,
                        "--version"
                    ],
                    {
                        windowsHide: true,
                        timeout: 30000,
                        env:
                            getResolvedToolEnvironment(
                                managedNode
                            )
                    },
                    (
                        error,
                        stdout,
                        stderr
                    ) => {
                        if (error) {
                            rejectPromise(
                                new Error(
                                    stderr?.trim?.() ||
                                    stdout?.trim?.() ||
                                    error.message ||
                                    "Prepared managed pnpm failed to execute through Managed Node."
                                )
                            );

                            return;
                        }

                        resolvePromise(
                            stdout.trim()
                        );
                    }
                );
            }
        );

    if (
        preparedVersion !==
        requiredVersion
    ) {
        throw new Error(
            `Prepared managed pnpm reports ${preparedVersion || "(no version)"}, expected ${requiredVersion}.`
        );
    }

    const runtimeManifest = {
        createdAt:
            new Date()
                .toISOString(),
        package:
            `pnpm@${requiredVersion}`,
        metadataUrl,
        tarballUrl,
        finalTarballUrl:
            download.finalUrl,
        archivePath,
        archiveBytes:
            statSync(
                archivePath
            ).size,
        archiveSha256:
            getFileSha256(
                archivePath
            ),
        integrity:
            integrityResult.integrity,
        packageBin:
            validation.bin,
        preparedVersion,
        preparedValidationMethod:
            "managed-node-direct-js-entry",
        managedNode: {
            version:
                managedNode.version,
            command:
                managedNode.command
        },
        extraction: {
            executable:
                extraction.executable
        }
    };

    writeFileSync(
        join(
            prepared,
            "managed-pnpm-manifest.json"
        ),
        JSON.stringify(
            runtimeManifest,
            null,
            2
        ),
        "utf8"
    );

    if (
        existsSync(
            target
        )
    ) {
        throw new Error(
            `Refusing managed pnpm promotion: target appeared during verification at ${target}.`
        );
    }

    renameSync(
        prepared,
        target
    );

    const promotedRuntime = resolveManagedPnpmPackageRuntime(paths, target);
    const resolvedPnpm = promotedRuntime ? {
        ...promotedRuntime, available: true, version: preparedVersion
    } : { available: false };

    if (
        resolvedPnpm.available !== true ||
        resolvedPnpm.source !== "managed" ||
        resolvedPnpm.version !==
        requiredVersion ||
        normalize(
            resolvedPnpm.command
        ).toLowerCase() !==
        normalize(
            join(
                target,
                "pnpm.cmd"
            )
        ).toLowerCase()
    ) {
        throw new Error(
            "Managed pnpm runtime was promoted, but the resolver did not select the exact managed pnpm runtime."
        );
    }

    return {
        ok: true,
        state: "ready",
        alreadyPrepared: false,
        requiredVersion,
        version:
            resolvedPnpm.version,
        command:
            resolvedPnpm.command,
        source:
            resolvedPnpm.source,
        target,
        metadataUrl,
        tarballUrl,
        archiveBytes:
            runtimeManifest.archiveBytes,
        archiveSha256:
            runtimeManifest.archiveSha256,
        integrity:
            runtimeManifest.integrity,
        packageBin:
            validation.bin,
        reason:
            `Managed pnpm ${requiredVersion} was downloaded from the trusted npm registry, integrity-verified, extracted, wrapped with managed Node, and promoted without relying on Corepack.`
    };
}


async function inspectManagedBuildTool(
    toolName
) {
    const resolved =
        resolveManagedBuildTool(
            toolName
        );

    try {
        const result =
            await runResolvedBuildTool(
                toolName,
                ["--version"],
                {
                    windowsHide: true,
                    timeout: 5000
                }
            );

        return {
            ...resolved,
            available:
                result.stdout.length > 0,
            version:
                result.stdout ||
                null,
            error:
                null,
            execution:
                resolved.runtimeKind ===
                    "managed-node-script"
                    ? {
                        kind:
                            resolved.runtimeKind,
                        executable:
                            resolved.executable,
                        binPath:
                            resolved.binPath
                    }
                    : null
        };
    } catch (error) {
        return {
            ...resolved,
            available:
                false,
            version:
                null,
            error:
                error?.message ??
                "Tool version check failed."
        };
    }
}


async function resolveManagedPnpmRunner(
    requiredVersion
) {
    const pnpm =
        await inspectManagedBuildTool(
            "pnpm"
        );

    if (
        pnpm.available &&
        pnpm.version === requiredVersion
    ) {
        return {
            toolName:
                "pnpm",
            source:
                pnpm.source,
            command:
                pnpm.command,
            requiredVersion,
            resolvedVersion:
                pnpm.version,
            argsPrefix: []
        };
    }

    const corepack =
        await inspectManagedBuildTool(
            "corepack"
        );

    if (corepack.available) {
        return {
            toolName:
                "corepack",
            source:
                corepack.source,
            command:
                corepack.command,
            requiredVersion,
            resolvedVersion:
                null,
            argsPrefix: [
                `pnpm@${requiredVersion}`
            ],
            fallbackPnpmVersion:
                pnpm.version
        };
    }

    const foundPnpm =
        pnpm.version
            ? ` Found pnpm ${pnpm.version}, but Vencord requires ${requiredVersion}.`
            : "";

    const policy =
        getManagedToolResolutionPolicy();

    throw new Error(
        policy.strictManagedTools
            ? `No usable managed pnpm runner is available.${foundPnpm} Strict managed-only mode forbids global pnpm/Corepack fallback.`
            : `No usable pnpm runner is available.${foundPnpm} Add the required pnpm/Corepack runtime to the managed toolchain or provide it globally.`
    );
}


async function detectBuildEnvironment() {
    const [
        nodeTool,
        pnpmTool,
        gitTool,
        corepackTool
    ] = await Promise.all([
        inspectManagedBuildTool("node"),
        inspectManagedBuildTool("pnpm"),
        inspectManagedBuildTool("git"),
        inspectManagedBuildTool("corepack")
    ]);

    const paths =
        getManagedPaths();

    const resolvedTools = {
        node:
            nodeTool,
        pnpm:
            pnpmTool,
        git:
            gitTool,
        corepack:
            corepackTool
    };

    return {
        node:
            nodeTool.version,
        pnpm:
            pnpmTool.version,
        git:
            gitTool.version,
        corepack:
            corepackTool.version,
        packageManagerAvailable:
            Boolean(
                pnpmTool.available ||
                corepackTool.available
            ),
        toolchainRoot:
            paths?.toolchain ?? null,
        usesManagedToolchain:
            Object.values(
                resolvedTools
            ).some(
                tool =>
                    tool.managed === true &&
                    tool.available === true
            ),
        resolvedTools
    };
}

const managedWorkspaceContext =
    new AsyncLocalStorage();


function getDefaultManagedWorkspaceRoot() {
    const localAppData =
        process.env.LOCALAPPDATA;

    if (!localAppData) {
        return null;
    }

    return join(
        localAppData,
        "MaruVencordInstaller"
    );
}


function getManagedPaths() {
    const defaultRoot =
        getDefaultManagedWorkspaceRoot();

    if (!defaultRoot) {
        return null;
    }

    const context =
        managedWorkspaceContext.getStore();

    const root =
        context?.root ??
        defaultRoot;

    return {
        root,
        vencord: join(root, "Vencord"),
        toolchain: join(root, "toolchain"),
        plugins: join(root, "plugins"),
        logs: join(root, "logs"),
        browserExtension: join(
            root,
            "browser-extension",
            "MaruTwitchPresence"
        ),
        kickBrowserExtension: join(
            root,
            "browser-extension",
            "MaruKickPresence"
        )
    };
}


function runWithManagedWorkspaceContext(
    context,
    callback
) {
    if (
        !context ||
        typeof context.root !== "string" ||
        context.root.length === 0 ||
        typeof context.purpose !== "string" ||
        context.purpose.length === 0
    ) {
        throw new Error(
            "Managed workspace context is invalid."
        );
    }

    if (
        typeof callback !== "function"
    ) {
        throw new Error(
            "Managed workspace context callback is invalid."
        );
    }

    const toolAudit =
        context.toolAudit &&
            typeof context.toolAudit === "object"
            ? context.toolAudit
            : null;

    return managedWorkspaceContext.run(
        Object.freeze({
            root:
                resolve(
                    context.root
                ),
            purpose:
                context.purpose,
            strictManagedTools:
                context.strictManagedTools === true,
            toolAudit
        }),
        callback
    );
}


function getManagedToolResolutionPolicy() {
    const context =
        managedWorkspaceContext.getStore();

    return {
        strictManagedTools:
            context?.strictManagedTools === true,
        toolAudit:
            context?.toolAudit &&
                typeof context.toolAudit === "object"
                ? context.toolAudit
                : null
    };
}


function recordManagedToolAudit(
    category,
    toolName,
    details = {}
) {
    const policy =
        getManagedToolResolutionPolicy();

    const audit =
        policy.toolAudit;

    if (!audit) {
        return;
    }

    if (
        !Array.isArray(
            audit[category]
        )
    ) {
        audit[category] = [];
    }

    const entry = {
        tool:
            toolName,
        ...details
    };

    const signature =
        JSON.stringify(
            entry
        );

    const exists =
        audit[category].some(
            existing =>
                JSON.stringify(
                    existing
                ) ===
                signature
        );

    if (!exists) {
        audit[category].push(
            entry
        );
    }
}

function getManagedWorkspaceState() {
    const paths =
        getManagedPaths();

    if (!paths) {
        return {
            state: "unavailable",
            reason: "Managed workspace unavailable."
        };
    }

    if (!existsSync(paths.root)) {
        return {
            state: "missing",
            path: paths.root,
            paths
        };
    }

    // The Vencord source path is deliberately NOT part of workspace
    // readiness. On a fresh installation it should remain nonexistent
    // until a validated source is acquired and promoted.
    const requiredDirectories = [
        paths.toolchain,
        paths.plugins,
        paths.logs
    ];

    const missingDirectories =
        requiredDirectories.filter(directory =>
            !existsSync(directory)
        );

    if (missingDirectories.length > 0) {
        return {
            state: "partial",
            path: paths.root,
            paths,
            missingDirectories,
            vencordPathExists:
                existsSync(
                    paths.vencord
                )
        };
    }

    return {
        state: "ready",
        path: paths.root,
        paths,
        vencordPathExists:
            existsSync(
                paths.vencord
            )
    };
}

function inspectManagedVencordSourceRoot(
    sourceRoot
) {
    const requiredPaths = [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        join(
            "scripts",
            "runInstaller.mjs"
        ),
        "src"
    ];

    const missingPaths =
        requiredPaths.filter(
            relativePath =>
                !existsSync(
                    join(
                        sourceRoot,
                        relativePath
                    )
                )
        );

    if (
        missingPaths.length > 0
    ) {
        return {
            valid: false,
            missingPaths,
            reason:
                `Managed Vencord source is missing required path${missingPaths.length === 1 ? "" : "s"}: ${missingPaths.join(", ")}`
        };
    }

    const packagePath =
        join(
            sourceRoot,
            "package.json"
        );

    if (
        !isRegularNonEmptyFile(
            packagePath
        )
    ) {
        return {
            valid: false,
            missingPaths: [],
            reason:
                "Managed Vencord package.json is missing or empty."
        };
    }

    let packageJson;

    try {
        packageJson =
            JSON.parse(
                readFileSync(
                    packagePath,
                    "utf8"
                )
            );
    } catch (error) {
        return {
            valid: false,
            missingPaths: [],
            reason:
                `Managed Vencord package.json is invalid: ${error?.message ?? "Unknown JSON error."}`
        };
    }

    if (
        packageJson?.name !==
        "vencord"
    ) {
        return {
            valid: false,
            missingPaths: [],
            reason:
                `Managed source package name is "${packageJson?.name ?? "missing"}", expected "vencord".`
        };
    }

    const repositoryUrl =
        typeof packageJson?.repository ===
            "string"
            ? packageJson.repository
            : packageJson?.repository?.url;

    if (
        typeof repositoryUrl !==
        "string" ||
        !repositoryUrl.includes(
            "github.com/Vendicated/Vencord"
        )
    ) {
        return {
            valid: false,
            missingPaths: [],
            reason:
                "Managed source package.json does not identify the trusted Vendicated/Vencord repository."
        };
    }

    if (
        typeof packageJson?.packageManager !==
        "string" ||
        !/^pnpm@\d+\.\d+\.\d+/.test(
            packageJson.packageManager
        )
    ) {
        return {
            valid: false,
            missingPaths: [],
            reason:
                "Managed Vencord package.json does not declare a supported pnpm packageManager."
        };
    }

    const runInstallerPath =
        join(
            sourceRoot,
            "scripts",
            "runInstaller.mjs"
        );

    if (
        !isRegularNonEmptyFile(
            runInstallerPath
        )
    ) {
        return {
            valid: false,
            missingPaths: [],
            reason:
                "Managed Vencord installer script is missing or empty."
        };
    }

    const srcPath =
        join(
            sourceRoot,
            "src"
        );

    try {
        if (
            !statSync(
                srcPath
            ).isDirectory()
        ) {
            return {
                valid: false,
                missingPaths: [],
                reason:
                    "Managed Vencord src path is not a directory."
            };
        }
    } catch (error) {
        return {
            valid: false,
            missingPaths: [],
            reason:
                error?.message ??
                "Unable to inspect managed Vencord src directory."
        };
    }

    return {
        valid: true,
        packagePath,
        packageManager:
            packageJson.packageManager,
        version:
            packageJson.version ?? null,
        repositoryUrl
    };
}


function getManagedVencordState() {
    const paths = getManagedPaths();

    if (!paths) {
        return {
            state: "unavailable"
        };
    }

    if (!existsSync(paths.vencord)) {
        return {
            state: "missing",
            path: paths.vencord
        };
    }

    let rootStats;

    try {
        rootStats =
            statSync(
                paths.vencord
            );
    } catch (error) {
        return {
            state: "unavailable",
            path:
                paths.vencord,
            reason:
                error?.message ??
                "Unable to inspect managed Vencord path."
        };
    }

    if (!rootStats.isDirectory()) {
        return {
            state: "occupied",
            path:
                paths.vencord,
            contents: [],
            reason:
                "Managed Vencord path exists but is not a directory."
        };
    }

    const contents =
        readdirSync(
            paths.vencord
        );

    if (contents.length === 0) {
        return {
            state: "empty",
            path: paths.vencord
        };
    }

    if (contents.includes(".git")) {
        return {
            state: "repository",
            path:
                paths.vencord,
            sourceType:
                "git",
            sourceReady: true
        };
    }

    const sourceInspection =
        inspectManagedVencordSourceRoot(
            paths.vencord
        );

    if (
        sourceInspection.valid
    ) {
        return {
            state: "repository",
            path:
                paths.vencord,
            sourceType:
                "archive",
            sourceReady: true,
            packageManager:
                sourceInspection.packageManager,
            version:
                sourceInspection.version,
            repositoryUrl:
                sourceInspection.repositoryUrl
        };
    }

    return {
        state: "occupied",
        path:
            paths.vencord,
        contents,
        sourceType:
            "unknown",
        sourceReady: false,
        reason:
            sourceInspection.reason,
        missingPaths:
            sourceInspection.missingPaths ??
            []
    };
}

async function prepareManagedVencordSourceFromArchive() {
    const before =
        getManagedVencordState();

    if (
        before.state === "repository"
    ) {
        return {
            ok: true,
            state: "repository",
            sourceType:
                before.sourceType ?? null,
            path:
                before.path,
            alreadyPrepared: true,
            reason:
                "Managed Vencord source is already ready."
        };
    }

    if (
        before.state !== "missing"
    ) {
        throw new Error(
            `Refusing archive source preparation: managed Vencord state is "${before.state}". The archive promotion path requires a completely absent destination and will not overwrite or remove existing contents.`
        );
    }

    const acquisition =
        await acquireVencordSourceArchiveToStaging();

    if (
        acquisition?.ok !== true ||
        acquisition?.state !== "staged" ||
        acquisition?.currentManagedVencordUntouched !==
        true
    ) {
        throw new Error(
            acquisition?.reason ??
            "Vencord source archive acquisition did not return a valid isolated staging result."
        );
    }

    // Compatibility must be checked before promoting any source into the managed workspace.
    validateSourceOverrides(acquisition.stagedSourceRoot, getInstallerResourceDirectory("sourceOverrides").path, BUNDLE_POLICY, acquisition.commit);

    const promotion =
        promoteStagedVencordSource({ stagingRoot: acquisition.stagingRoot, customize: true });

    if (
        promotion?.ok !== true ||
        promotion?.state !== "promoted" ||
        promotion?.overwritePerformed !== false
    ) {
        throw new Error(
            promotion?.reason ??
            "Validated Vencord source promotion did not complete safely."
        );
    }

    const after =
        getManagedVencordState();

    if (
        after.state !== "repository" ||
        after.sourceType !== "archive"
    ) {
        throw new Error(
            `Archive source preparation completed, but managed Vencord verification returned state="${after.state}" sourceType="${after.sourceType ?? "unknown"}".`
        );
    }

    writeManagedVencordSourceMetadata(after.path, {
        commit: promotion.commit,
        acquisitionManifestPath: acquisition.manifestPath,
        customizationBases: Object.fromEntries(planSourceOverrides(acquisition.stagedSourceRoot, getInstallerResourceDirectory("sourceOverrides").path, BUNDLE_POLICY).map(plan => [plan.rel, plan.output]))
    });

    return {
        ok: true,
        state: "repository",
        sourceType:
            after.sourceType,
        path:
            after.path,
        commit:
            promotion.commit,
        archiveSha256:
            acquisition.archiveSha256,
        sourceAcquisitionManifest:
            promotion.sourceAcquisitionManifest,
        promotionManifestPath:
            promotion.promotionManifestPath,
        packageManager:
            after.packageManager ??
            acquisition.packageManager,
        alreadyPrepared: false,
        reason:
            "Managed Vencord source was acquired from a trusted immutable GitHub commit archive, validated, and safely promoted without Git."
    };
}


function cloneManagedVencord() {
    return new Promise((resolve, reject) => {
        const state =
            getManagedVencordState();

        if (
            state.state !== "missing" &&
            state.state !== "empty"
        ) {
            reject(
                new Error(
                    `Refusing to clone: managed Vencord folder state is "${state.state}".`
                )
            );

            return;
        }

        const paths =
            getManagedPaths();

        if (!paths) {
            reject(
                new Error(
                    "Unable to determine managed workspace."
                )
            );

            return;
        }

        execResolvedBuildTool(
            "git",
            [
                "clone",
                "--depth",
                "1",
                VENCORD_REPO_URL,
                paths.vencord
            ],
            {
                windowsHide: true,
                timeout: 300000
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject(
                        new Error(
                            stderr.trim() ||
                            error.message
                        )
                    );

                    return;
                }

                resolve({
                    ok: true,
                    path: paths.vencord,
                    output: stdout.trim()
                });
            }
        );
    });
}

function getManagedUserPluginsState() {
    const paths =
        getManagedPaths();

    if (!paths) {
        return {
            state: "unavailable",
            reason: "Managed workspace unavailable."
        };
    }

    const userPluginsPath =
        join(
            paths.vencord,
            "src",
            "userplugins"
        );

    const vencordState =
        getManagedVencordState();

    if (vencordState.state !== "repository") {
        return {
            state: "unavailable",
            path: userPluginsPath,
            reason:
                `Managed Vencord state is "${vencordState.state}".`
        };
    }

    if (!existsSync(userPluginsPath)) {
        return {
            state: "missing",
            path: userPluginsPath
        };
    }

    return {
        state: "ready",
        path: userPluginsPath
    };
}

function ensureManagedUserPluginsDirectory() {
    const paths =
        getManagedPaths();

    if (!paths) {
        throw new Error(
            "Unable to determine managed workspace."
        );
    }

    const state =
        getManagedVencordState();

    if (state.state !== "repository") {
        throw new Error(
            `Refusing to create userplugins: managed Vencord state is "${state.state}".`
        );
    }

    const srcPath =
        join(
            paths.vencord,
            "src"
        );

    if (!existsSync(srcPath)) {
        throw new Error(
            "Managed Vencord repository is missing its src directory."
        );
    }

    const userPluginsPath =
        join(
            srcPath,
            "userplugins"
        );

    mkdirSync(
        userPluginsPath,
        {
            recursive: true
        }
    );

    return {
        ok: true,
        path: userPluginsPath
    };
}

function createManagedWorkspace() {
    const paths = getManagedPaths();

    if (!paths) {
        throw new Error(
            "Unable to determine managed workspace."
        );
    }

    const defaultRoot =
        getDefaultManagedWorkspaceRoot();

    if (!defaultRoot) {
        throw new Error(
            "LOCALAPPDATA is unavailable."
        );
    }

    const context =
        managedWorkspaceContext.getStore();

    const isolatedContextRoot =
        (
            context?.purpose ===
            "fresh-install-test" ||
            context?.purpose ===
            "setup-coordinator-test"
        ) &&
            typeof context?.root === "string"
            ? resolve(
                context.root
            )
            : null;

    const isolatedContextName =
        isolatedContextRoot
            ? basename(
                isolatedContextRoot
            )
            : null;

    const isolatedContextNameAllowed =
        (
            context?.purpose ===
            "fresh-install-test" &&
            typeof isolatedContextName ===
            "string" &&
            /^fresh-install-test(?:-\d+)?$/i.test(
                isolatedContextName
            )
        ) ||
        (
            context?.purpose ===
            "setup-coordinator-test" &&
            typeof isolatedContextName ===
            "string" &&
            /^fresh-coordinator-test(?:-\d+)?$/i.test(
                isolatedContextName
            )
        );

    const isolatedContextParentAllowed =
        isolatedContextRoot
            ? normalize(
                dirname(
                    isolatedContextRoot
                )
            ).toLowerCase() ===
            normalize(
                defaultRoot
            ).toLowerCase()
            : false;

    const productionWorkspace =
        normalize(
            paths.root
        ).toLowerCase() ===
        normalize(
            defaultRoot
        ).toLowerCase();

    const isolatedTestWorkspace =
        (
            context?.purpose ===
            "fresh-install-test" ||
            context?.purpose ===
            "setup-coordinator-test"
        ) &&
        isolatedContextNameAllowed &&
        isolatedContextParentAllowed &&
        normalize(
            paths.root
        ).toLowerCase() ===
        normalize(
            isolatedContextRoot
        ).toLowerCase();

    // Safety guard:
    // normal operations may create only the production workspace.
    // Isolated tests may create only their exact direct-child roots.
    if (
        !productionWorkspace &&
        !isolatedTestWorkspace
    ) {
        throw new Error(
            "Managed workspace failed safety validation."
        );
    }

    const directories = [
        paths.root,
        paths.toolchain,
        paths.plugins,
        paths.logs
    ];

    for (const directory of directories) {
        mkdirSync(directory, {
            recursive: true
        });
    }

    return {
        ok: true,
        paths,
        vencordPathCreated: false,
        reason:
            "Managed workspace infrastructure is ready. The Vencord source path was intentionally left absent for safe source acquisition."
    };
}

function getBundledPluginsState() {
    const resource =
        getInstallerResourceDirectory(
            "bundledPlugins"
        );

    const root =
        resource.path;

    const plugins =
        Object.entries(BUNDLED_PLUGIN_FILES)
            .map(([name, files]) => {
                const pluginPath =
                    join(root, name);

                const missingFiles =
                    files.filter(file =>
                        !isRegularNonEmptyFile(
                            join(
                                pluginPath,
                                file
                            )
                        )
                    );

                return {
                    name,
                    path: pluginPath,
                    complete:
                        missingFiles.length === 0,
                    missingFiles
                };
            });

    let validationError = null;
    try {
        validatePluginBundle(root, BUNDLED_PLUGIN_FILES, BUNDLE_POLICY);
    } catch (error) {
        validationError = error.message;
    }

    return {
        root,
        validationError,
        hashVerified: validationError === null,
        mode:
            resource.mode,
        source:
            resource.source,
        packagingPath:
            resource.mode === "packaged"
                ? resource.path
                : null,
        complete:
            validationError === null && plugins.every(
                plugin => plugin.complete
            ),
        plugins
    };
}

function getManagedInstalledPluginsState() {
    const paths =
        getManagedPaths();

    if (!paths) {
        return {
            available: false,
            state: "unavailable",
            reason: "Managed workspace unavailable."
        };
    }

    const vencordState =
        getManagedVencordState();

    if (vencordState.state !== "repository") {
        return {
            available: false,
            state: "unavailable",
            reason:
                `Managed Vencord state is "${vencordState.state}".`
        };
    }

    const root =
        join(
            paths.vencord,
            "src",
            "userplugins"
        );

    if (!existsSync(root)) {
        return {
            available: true,
            state: "missing",
            root,
            complete: false,
            plugins: Object.entries(
                BUNDLED_PLUGIN_FILES
            ).map(([name, files]) => ({
                name,
                path: join(root, name),
                exists: false,
                complete: false,
                missingFiles: [...files]
            }))
        };
    }

    const plugins =
        Object.entries(BUNDLED_PLUGIN_FILES)
            .map(([name, files]) => {
                const pluginPath =
                    join(root, name);

                const exists =
                    existsSync(pluginPath);

                const missingFiles =
                    files.filter(file =>
                        !isRegularNonEmptyFile(
                            join(
                                pluginPath,
                                file
                            )
                        )
                    );

                return {
                    name,
                    path: pluginPath,
                    exists,
                    complete:
                        exists &&
                        missingFiles.length === 0,
                    missingFiles
                };
            });

    const complete =
        plugins.every(
            plugin => plugin.complete
        );

    const anyPluginFolder =
        plugins.some(
            plugin => plugin.exists
        );

    return {
        available: true,
        state:
            complete
                ? "installed"
                : anyPluginFolder
                    ? "partial"
                    : "missing",
        root,
        complete,
        plugins,
        ...getMaruPluginInstallationAssessment(root)
    };
}

function installBundledPlugins() {
    const paths =
        getManagedPaths();

    if (!paths) {
        throw new Error(
            "Unable to determine managed workspace."
        );
    }

    const vencordState =
        getManagedVencordState();

    if (vencordState.state !== "repository") {
        throw new Error(
            `Refusing to install plugins: managed Vencord state is "${vencordState.state}".`
        );
    }

    const bundleState =
        getBundledPluginsState();

    if (!bundleState.complete) {
        throw new Error(
            bundleState.mode === "packaged"
                ? `Refusing to install plugins: packaged bundled-plugin payload is incomplete at ${bundleState.root}. Ensure "bundled-plugins" is included as an Electron extraResource.`
                : `Refusing to install plugins: development bundled-plugin payload is incomplete at ${bundleState.root}.`
        );
    }

    const userPluginsPath =
        join(
            paths.vencord,
            "src",
            "userplugins"
        );

    if (!existsSync(userPluginsPath)) {
        throw new Error(
            "Managed Vencord userplugins directory does not exist."
        );
    }

    const destinations =
        bundleState.plugins.map(plugin => ({
            name: plugin.name,
            source: plugin.path,
            destination: join(
                userPluginsPath,
                plugin.name
            )
        }));

    const existing =
        destinations.filter(plugin =>
            existsSync(plugin.destination)
        );

    if (existing.length > 0) {
        throw new Error(
            `Refusing to overwrite existing plugin folders: ${existing
                .map(plugin => plugin.name)
                .join(", ")}`
        );
    }

    for (const plugin of destinations) {
        copyApprovedPlugin(bundleState.root, plugin.destination, plugin.name, BUNDLED_PLUGIN_FILES, BUNDLE_POLICY);
    }

    return {
        ok: true,
        plugins:
            destinations.map(plugin => ({
                name: plugin.name,
                path: plugin.destination
            }))
    };
}

function getMaruManagedFileComparison(
    sourceRoot,
    destinationRoot,
    files
) {
    return files.map(file => {
        const sourcePath =
            join(
                sourceRoot,
                file
            );

        const destinationPath =
            join(
                destinationRoot,
                file
            );

        const sourceExists =
            existsSync(sourcePath) &&
            statSync(sourcePath).isFile();

        const destinationExists =
            existsSync(destinationPath) &&
            statSync(destinationPath).isFile();

        const sourceSha256 =
            sourceExists
                ? getFileSha256(sourcePath)
                : null;

        const destinationSha256 =
            destinationExists
                ? getFileSha256(destinationPath)
                : null;

        return {
            file,
            sourcePath,
            destinationPath,
            sourceExists,
            destinationExists,
            sourceSha256,
            destinationSha256,
            matches:
                sourceExists &&
                destinationExists &&
                sourceSha256 ===
                destinationSha256
        };
    });
}


function getMaruPluginUpdateState() {
    const paths =
        getManagedPaths();

    if (!paths?.root) {
        return {
            available: false,
            state: "unavailable",
            updateAvailable: false,
            reason:
                "Managed workspace path is unavailable."
        };
    }

    const vencordState =
        getManagedVencordState();

    if (
        vencordState.state !==
        "repository"
    ) {
        return {
            available: false,
            state: "not-ready",
            updateAvailable: false,
            reason:
                "Maru plug-in update checks become available after Managed Vencord is set up."
        };
    }

    const bundleState =
        getBundledPluginsState();

    if (!bundleState.complete) {
        return {
            available: false,
            state: "unavailable",
            updateAvailable: false,
            reason:
                "Bundled Maru plug-in payload is incomplete."
        };
    }

    const userPluginsRoot =
        join(
            paths.vencord,
            "src",
            "userplugins"
        );

    const installationAssessment = getMaruPluginInstallationAssessment(userPluginsRoot);
    if (!installationAssessment.updateSafe && !installationAssessment.repairEligible) {
        return { available: false, state: "blocked-modified-or-partial", updateAvailable: false, reason: installationAssessment.reason };
    }

    const plugins =
        bundleState.plugins.map(plugin => {
            const files =
                getMaruManagedFileComparison(
                    plugin.path,
                    join(
                        userPluginsRoot,
                        plugin.name
                    ),
                    BUNDLED_PLUGIN_FILES[
                    plugin.name
                    ]
                );

            const changedFiles =
                files.filter(
                    file =>
                        !file.matches
                );

            const obsoleteFiles =
                listManagedPluginFiles(
                    join(userPluginsRoot, plugin.name)
                ).filter(file =>
                    !BUNDLED_PLUGIN_FILES[plugin.name].includes(file)
                );

            return {
                name:
                    plugin.name,
                source:
                    plugin.path,
                destination:
                    join(
                        userPluginsRoot,
                        plugin.name
                    ),
                updateAvailable:
                    changedFiles.length > 0 || obsoleteFiles.length > 0,
                changedFiles:
                    changedFiles.map(
                        file => file.file
                    ),
                obsoleteFiles,
                files
            };
        });

    const pluginFilesChanged =
        plugins.reduce(
            (total, plugin) =>
                total +
                plugin.changedFiles.length +
                plugin.obsoleteFiles.length,
            0
        );

    const twitchResource =
        getInstallerResourceDirectory(
            "twitchExtension"
        );

    const managedExtensionPath =
        paths.browserExtension;

    const extensionProvisioned =
        existsSync(
            managedExtensionPath
        ) &&
        statSync(
            managedExtensionPath
        ).isDirectory();

    let extension = {
        provisioned:
            extensionProvisioned,
        updateAvailable:
            false,
        changedFiles: [],
        files: [],
        source:
            twitchResource.path,
        destination:
            managedExtensionPath
    };

    if (extensionProvisioned) {
        const sourceComplete =
            TWITCH_EXTENSION_FILES.every(
                file => {
                    const candidate =
                        join(
                            twitchResource.path,
                            file
                        );

                    return (
                        existsSync(candidate) &&
                        statSync(candidate)
                            .isFile()
                    );
                }
            );

        if (!sourceComplete) {
            return {
                available: false,
                state: "unavailable",
                updateAvailable: false,
                reason:
                    "Bundled Twitch Presence extension payload is incomplete."
            };
        }

        const files =
            getMaruManagedFileComparison(
                twitchResource.path,
                managedExtensionPath,
                TWITCH_EXTENSION_FILES
            );

        const changedFiles =
            files.filter(
                file =>
                    !file.matches
            );

        extension = {
            ...extension,
            updateAvailable:
                changedFiles.length > 0,
            changedFiles:
                changedFiles.map(
                    file => file.file
                ),
            files
        };
    }

    const kickResource =
        getInstallerResourceDirectory(
            "kickExtension"
        );

    const managedKickExtensionPath =
        paths.kickBrowserExtension;

    const kickExtensionProvisioned =
        existsSync(
            managedKickExtensionPath
        ) &&
        statSync(
            managedKickExtensionPath
        ).isDirectory();

    let kickExtension = {
        provisioned:
            kickExtensionProvisioned,
        updateAvailable:
            false,
        changedFiles: [],
        files: [],
        source:
            kickResource.path,
        destination:
            managedKickExtensionPath
    };

    if (kickExtensionProvisioned) {
        const sourceComplete =
            KICK_EXTENSION_FILES.every(
                file => {
                    const candidate =
                        join(
                            kickResource.path,
                            file
                        );

                    return (
                        existsSync(candidate) &&
                        statSync(candidate)
                            .isFile()
                    );
                }
            );

        if (!sourceComplete) {
            return {
                available: false,
                state: "unavailable",
                updateAvailable: false,
                reason:
                    "Bundled Kick Presence extension payload is incomplete."
            };
        }

        const files =
            getMaruManagedFileComparison(
                kickResource.path,
                managedKickExtensionPath,
                KICK_EXTENSION_FILES
            );

        const changedFiles =
            files.filter(
                file =>
                    !file.matches
            );

        kickExtension = {
            ...kickExtension,
            updateAvailable:
                changedFiles.length > 0,
            changedFiles:
                changedFiles.map(
                    file => file.file
                ),
            files
        };
    }

    const twitchExtensionFilesChanged =
        extension.changedFiles.length;

    const kickExtensionFilesChanged =
        kickExtension.changedFiles.length;

    const extensionFilesChanged =
        twitchExtensionFilesChanged +
        kickExtensionFilesChanged;

    const updateAvailable =
        pluginFilesChanged > 0 ||
        extensionFilesChanged > 0;

    return {
        available: true,
        state:
            updateAvailable
                ? "update-available"
                : "current",
        updateAvailable,

        repairEligible: installationAssessment.repairEligible === true,
        missingFiles: installationAssessment.missingFiles ?? [],

        pluginFilesChanged,
        extensionFilesChanged,
        twitchExtensionFilesChanged,
        kickExtensionFilesChanged,
        plugins,
        extension,
        twitchExtension:
            extension,
        kickExtension,
        reason:
            updateAvailable
                ? "One or more installer-owned Maru components differ from the bundled versions."
                : "Installed Maru plug-ins match the bundled versions."
    };
}


async function assertManagedDiscordTargetsClosedForMaruPluginUpdate() {
    const ownershipStates =
        getManagedUninstallStates();

    const managedStates = ownershipStates.filter(state => state.state === "managed");
    const unsafeTarget = managedStates.find(state => state.eligible !== true);
    if (unsafeTarget) {
        throw new Error(unsafeTarget.reason ?? "Managed Discord target is not safe to modify; plug-in recovery is blocked.");
    }

    const installs =
        detectDiscordInstalls();

    const closedTargets = [];

    for (const state of managedStates) {
        const discord =
            installs.find(
                install =>
                    install.name ===
                    state.name
            );

        if (!discord) {
            throw new Error(
                `Managed Discord ${state.name} is no longer detected. Refusing Maru plug-in update until its target state can be verified.`
            );
        }

        const runningState =
            await getDiscordRunningState(
                discord
            );

        if (runningState.running) {
            throw new Error(
                `Fully quit Discord ${discord.name} from the system tray before updating Maru plug-ins. Closing the Discord window is not enough because Discord can keep running in the background.`
            );
        }

        closedTargets.push(
            discord.name
        );
    }

    return {
        managedTargets:
            managedStates.map(
                state =>
                    state.name
            ),
        closedTargets
    };
}


async function updateMaruPlugins() {
    const paths =
        getManagedPaths();

    if (!paths?.root) {
        throw new Error(
            "Managed workspace path is unavailable."
        );
    }

    const before =
        getMaruPluginUpdateState();

    if (before.available !== true) {
        throw new Error(
            before.reason ??
            "Maru plug-in update state is unavailable."
        );
    }

    if (before.updateAvailable !== true) {
        return {
            ok: true,
            updated: false,
            alreadyCurrent: true,
            reason:
                "Maru plug-ins are already up to date."
        };
    }

    const targetSafety =
        await assertManagedDiscordTargetsClosedForMaruPluginUpdate();

    const dependencyState = before.repairEligible ? getManagedPluginDependenciesState() : null;
    if (dependencyState && dependencyState.available !== true) {
        throw new Error(dependencyState.reason ?? "Plugin recovery cannot safely inspect the managed package.json.");
    }
    // Partial legacy setups cannot reach Automatic Setup's tool/dependency
    // preparation. Reuse those guarded routines here before the verified build.
    if (before.repairEligible) {
        await prepareManagedNodeRuntime();
        await prepareManagedPnpmRuntime();
    }
    const dependencyRepairNeeded = dependencyState !== null && dependencyState.state !== "installed";

    const timestamp =
        new Date()
            .toISOString()
            .replace(
                /[:.]/g,
                "-"
            );

    const backupRoot =
        join(
            paths.root,
            `Maru-plugin-update-backup-${timestamp}`
        );

    if (existsSync(backupRoot)) {
        throw new Error(
            `Refusing Maru plug-in update because backup path already exists: ${backupRoot}`
        );
    }

    mkdirSync(
        backupRoot,
        {
            recursive: true
        }
    );

    const pluginChanges =
        before.plugins.flatMap(
            plugin =>
                plugin.files
                    .filter(
                        file =>
                            !file.matches
                    )
                    .map(file => ({
                        kind:
                            "plugin",
                        component:
                            plugin.name,
                        file:
                            file.file,
                        sourcePath:
                            file.sourcePath,
                        destinationPath:
                            file.destinationPath,
                        destinationExisted:
                            file.destinationExists,
                        destinationSha256:
                            file.destinationSha256,
                        sourceSha256:
                            file.sourceSha256,
                        backupPath:
                            join(
                                backupRoot,
                                "plugin-files",
                                plugin.name,
                                file.file
                            )
                    }))
        );

    const obsoleteChanges = before.plugins.flatMap(plugin =>
        plugin.obsoleteFiles.map(file => {
            const destinationPath = assertSafePath(
                join(plugin.destination, file)
            );

            if (!isRegularNonEmptyFile(destinationPath)) {
                throw new Error(
                    `Obsolete plugin file is unavailable: ${plugin.name}/${file}`
                );
            }

            return {
                kind: "plugin-removal",
                component: plugin.name,
                file,
                destinationPath,
                destinationExisted: true,
                destinationSha256: getFileSha256(destinationPath),
                backupPath: join(
                    backupRoot,
                    "plugin-files",
                    plugin.name,
                    file
                )
            };
        })
    );

    const twitchExtensionChanges =
        before.extension.provisioned
            ? before.extension.files
                .filter(
                    file =>
                        !file.matches
                )
                .map(file => ({
                    kind:
                        "browser-extension",
                    component:
                        "MaruTwitchPresence",
                    file:
                        file.file,
                    sourcePath:
                        file.sourcePath,
                    destinationPath:
                        file.destinationPath,
                    destinationExisted:
                        file.destinationExists,
                    destinationSha256:
                        file.destinationSha256,
                    sourceSha256:
                        file.sourceSha256,
                    backupPath:
                        join(
                            backupRoot,
                            "browser-extension",
                            "MaruTwitchPresence",
                            file.file
                        )
                }))
            : [];

    const kickExtensionChanges =
        before.kickExtension?.provisioned
            ? before.kickExtension.files
                .filter(
                    file =>
                        !file.matches
                )
                .map(file => ({
                    kind:
                        "browser-extension",
                    component:
                        "MaruKickPresence",
                    file:
                        file.file,
                    sourcePath:
                        file.sourcePath,
                    destinationPath:
                        file.destinationPath,
                    destinationExisted:
                        file.destinationExists,
                    destinationSha256:
                        file.destinationSha256,
                    sourceSha256:
                        file.sourceSha256,
                    backupPath:
                        join(
                            backupRoot,
                            "browser-extension",
                            "MaruKickPresence",
                            file.file
                        )
                }))
            : [];

    const extensionChanges = [
        ...twitchExtensionChanges,
        ...kickExtensionChanges
    ];

    const dependencyChanges = (dependencyRepairNeeded || pluginChanges.length > 0 || obsoleteChanges.length > 0)
        ? ["package.json", "pnpm-lock.yaml"].map(file => {
            const destinationPath = assertSafePath(join(paths.vencord, file));
            if (!isRegularNonEmptyFile(destinationPath)) {
                throw new Error("Plugin recovery requires a valid package.json and lockfile; source integrity must be repaired first.");
            }
            const hash = getFileSha256(destinationPath);
            return { kind: "dependency", component: "Vencord", file, sourcePath: destinationPath,
                destinationPath, destinationExisted: true, destinationSha256: hash, sourceSha256: hash,
                backupPath: join(backupRoot, "dependency-files", file) };
        }) : [];
    const allChanges = [
        ...pluginChanges,
        ...obsoleteChanges,
        ...extensionChanges,
        ...dependencyChanges
    ];

    const distPath =
        join(
            paths.vencord,
            "dist"
        );

    const distBackupPath =
        join(
            backupRoot,
            "Vencord-dist"
        );

    assertSafePath(distPath);
    const originalDistManifest = existsSync(distPath) ? getBackupFileManifest(distPath) : null;
    const createdDirectories = [];
    const appliedChanges = [];
    let buildAttempted = false;
    const transactionManifestPath = join(backupRoot, "maru-plugin-update-manifest.json");
    let transactionManifest = null;
    const persistTransaction = (status, error = null) => {
        if (!transactionManifest) return;
        writeFileSync(transactionManifestPath, JSON.stringify({ ...transactionManifest, status, error, createdDirectories, appliedFiles: appliedChanges.map(change => change.destinationPath), updatedAt: new Date().toISOString() }, null, 2), "utf8");
    };
    let distBackedUp = false;
    let buildRebuilt = false;
    let modificationsStarted = false;
    let rollbackStarted = false;

    const restoreChange = restoreUpdatedFile;

    const rollback = originalError => {
        if (rollbackStarted) {
            throw originalError;
        }

        rollbackStarted = true;
        const rollbackErrors = [];

        if (modificationsStarted) {
            for (
                const change of
                [...appliedChanges].reverse()
            ) {
                try {
                    restoreChange(
                        change
                    );
                } catch (error) {
                    rollbackErrors.push(
                        `Could not restore ${change.component}/${change.file}: ${error?.message ?? error}`
                    );
                }
            }
        }

        try {
            removeCreatedEmptyDirectories(createdDirectories);
        } catch (error) {
            rollbackErrors.push(error.message);
        }
        if (buildAttempted) {
            try {
                restoreBuildOutput(distPath, distBackupPath, join(backupRoot, "failed-Vencord-dist"), originalDistManifest, getBackupFileManifest, verifyBackupFileManifests);
            } catch (error) {
                rollbackErrors.push("Could not verify/restore managed build: " + error.message);
            }
        }
        try {
            persistTransaction(rollbackErrors.length ? "rollback-failed" : "rolled-back", { original: originalError.message, rollbackErrors });
        } catch (error) {
            rollbackErrors.push("Could not record rollback outcome: " + error.message);
        }

        const suffix =
            rollbackErrors.length > 0
                ? ` Rollback also reported: ${rollbackErrors.join(" ")}`
                : modificationsStarted
                    ? " Previous Maru plug-in files were restored; backed-up managed Vencord build artifacts were restored when available."
                    : " Existing Maru plug-in files were not modified.";

        throw new Error(
            `${originalError?.message ?? originalError}${suffix}`
        );
    };

    try {
        for (const change of allChanges) {
            if (change.kind === "plugin-removal") {
                verifyObsoletePluginFile(change);
            } else {
                verifyUnchangedDestination(change);
            }

            assertSafePath(change.backupPath);
            if (
                change.kind !== "plugin-removal" &&
                (
                    !change.sourceSha256 ||
                    !existsSync(change.sourcePath)
                )
            ) {
                throw new Error(
                    `Bundled update source is missing for ${change.component}/${change.file}.`
                );
            }

            if (change.destinationExisted) {
                mkdirSync(
                    dirname(
                        change.backupPath
                    ),
                    {
                        recursive: true
                    }
                );

                cpSync(
                    change.destinationPath,
                    change.backupPath,
                    {
                        force: false,
                        errorOnExist: true
                    }
                );

                if (
                    getFileSha256(
                        change.backupPath
                    ) !==
                    change.destinationSha256
                ) {
                    throw new Error(
                        `Backup verification failed for ${change.component}/${change.file}.`
                    );
                }
            }
        }

        if (
            (pluginChanges.length > 0 || obsoleteChanges.length > 0) &&
            existsSync(distPath) &&
            statSync(distPath).isDirectory()
        ) {
            cpSync(
                distPath,
                distBackupPath,
                {
                    recursive: true,
                    force: false,
                    errorOnExist: true
                }
            );

            const distVerification =
                verifyBackupFileManifests(
                    originalDistManifest,
                    getBackupFileManifest(
                        distBackupPath
                    )
                );

            if (!distVerification.verified) {
                throw new Error(
                    `Managed Vencord build backup verification failed: ${distVerification.reason}`
                );
            }

            distBackedUp = true;
        }

        transactionManifest = {
                    schemaVersion: 1,
                    createdAt:
                        new Date()
                            .toISOString(),
                    managedTargets:
                        targetSafety.managedTargets,
                    pluginFiles:
                        pluginChanges.map(
                            change => ({
                                component:
                                    change.component,
                                file:
                                    change.file,
                                destinationExisted:
                                    change.destinationExisted,
                                previousSha256:
                                    change.destinationSha256,
                                bundledSha256:
                                    change.sourceSha256
                            })
                        ),
                    pluginFilesRemoved:
                        obsoleteChanges.map(change => ({
                            component: change.component,
                            file: change.file,
                            previousSha256: change.destinationSha256
                        })),
                    browserExtensionFiles:
                        extensionChanges.map(
                            change => ({
                                component:
                                    change.component,
                                file:
                                    change.file,
                                destinationExisted:
                                    change.destinationExisted,
                                previousSha256:
                                    change.destinationSha256,
                                bundledSha256:
                                    change.sourceSha256
                            })
                        ),
                    dependencyFiles: dependencyChanges.map(change => ({ file: change.file, previousSha256: change.destinationSha256 })),
                    distBackedUp
                };
        persistTransaction("prepared");

        modificationsStarted = true;

        if (dependencyChanges.length > 0) {
            for (const change of dependencyChanges) verifyUnchangedDestination(change);
            appliedChanges.push(...dependencyChanges);
            persistTransaction("dependency-files-protected");
        }

        if (dependencyRepairNeeded) {
            persistTransaction("repairing-dependencies");
            await installManagedPluginDependencies();
            if (getManagedPluginDependenciesState().state !== "installed") {
                throw new Error("Required plugin dependency failed post-repair verification.");
            }
        }

        for (const change of pluginChanges) {
            verifyUnchangedDestination(change);
            ensureTrackedDirectory(dirname(change.destinationPath), createdDirectories);
            appliedChanges.push(change);
            persistTransaction("applying");

            cpSync(
                change.sourcePath,
                change.destinationPath,
                {
                    force: change.destinationExisted,
                    errorOnExist: !change.destinationExisted
                }
            );

            if (
                getFileSha256(
                    change.destinationPath
                ) !==
                change.sourceSha256
            ) {
                throw new Error(
                    `Updated Maru plug-in file failed verification: ${change.component}/${change.file}`
                );
            }
        }

        for (const change of obsoleteChanges) {
            verifyObsoletePluginFile(change);
            appliedChanges.push(change);
            persistTransaction("applying");

            removeObsoletePluginFile(change);
        }

        if (pluginChanges.length > 0 || obsoleteChanges.length > 0) {
            buildAttempted = true;
            persistTransaction("building");
            let build;
            try {
                build = await buildManagedVencord();
            } catch (error) {
                if (!String(error?.message ?? "").includes("ERR_PNPM_OUTDATED_LOCKFILE")) {
                    throw error;
                }

                persistTransaction("repairing-outdated-lockfile");

                const packagePath = assertSafePath(join(paths.vencord, "package.json"));
                const packageHash = getFileSha256(packagePath);
                const verification = await verifyManagedPackageManager();
                const runner = verification.runner;
                const environment = getManagedVencordBuildEnvironment();

                await runResolvedBuildTool(
                    runner.toolName,
                    [
                        ...runner.argsPrefix,
                        "--config.confirmModulesPurge=false",
                        "install",
                        "--lockfile-only",
                        "--no-frozen-lockfile",
                        "--ignore-scripts"
                    ],
                    {
                        cwd: paths.vencord,
                        windowsHide: true,
                        timeout: 300000,
                        env: {
                            ...environment.env,
                            CI: "true",
                            pnpm_config_verify_deps_before_run: "false"
                        }
                    }
                );

                if (getFileSha256(packagePath) !== packageHash) {
                    throw new Error(
                        "Lockfile repair unexpectedly modified package.json; restoring transaction backup."
                    );
                }

                persistTransaction("retrying-frozen-build");
                build = await buildManagedVencord();
            }

            if (!build?.ok) {
                throw new Error(
                    "Managed Vencord rebuild did not complete after updating Maru plug-ins."
                );
            }

            const buildState =
                getManagedBuildState();

            if (
                buildState.state !== "built" ||
                buildState.complete !== true
            ) {
                throw new Error(
                    "Managed Vencord rebuild failed post-update verification."
                );
            }

            buildRebuilt = true;
        }

        for (const change of extensionChanges) {
            verifyUnchangedDestination(change);
            ensureTrackedDirectory(dirname(change.destinationPath), createdDirectories);
            appliedChanges.push(change);
            persistTransaction("applying");

            cpSync(
                change.sourcePath,
                change.destinationPath,
                {
                    force: change.destinationExisted,
                    errorOnExist: !change.destinationExisted
                }
            );

            if (
                getFileSha256(
                    change.destinationPath
                ) !==
                change.sourceSha256
            ) {
                throw new Error(
                    `Updated ${change.component} browser-extension file failed verification: ${change.file}`
                );
            }
        }

        const after =
            getMaruPluginUpdateState();

        if (
            after.available !== true ||
            after.updateAvailable === true
        ) {
            throw new Error(
                after.reason ??
                "Maru plug-in update did not reach a verified current state."
            );
        }

        persistTransaction("completed");

        return {
            ok: true,
            updated: true,
            pluginFilesUpdated:
                pluginChanges.length,
            pluginFilesRemoved:
                obsoleteChanges.length,
            extensionFilesUpdated:
                extensionChanges.length,
            twitchExtensionFilesUpdated:
                twitchExtensionChanges.length,
            kickExtensionFilesUpdated:
                kickExtensionChanges.length,
            extensionUpdated:
                extensionChanges.length > 0,
            twitchExtensionUpdated:
                twitchExtensionChanges.length > 0,
            kickExtensionUpdated:
                kickExtensionChanges.length > 0,
            buildRebuilt,
            managedTargets:
                targetSafety.managedTargets,
            backupPath:
                backupRoot,
            reason:
                "Maru plug-ins updated successfully."
        };
    } catch (error) {
        rollback(error);
    }
}


function getManagedPackageManagerRequirement() {
    const paths =
        getManagedPaths();

    if (!paths) {
        return {
            available: false,
            reason: "Managed workspace unavailable."
        };
    }

    const packageJsonPath =
        join(
            paths.vencord,
            "package.json"
        );

    if (!existsSync(packageJsonPath)) {
        return {
            available: false,
            reason: "Managed Vencord package.json not found."
        };
    }

    let packageJson;
    try {
        packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    } catch (error) {
        return { available: false, reason: `Managed package.json needs source recovery: ${error?.message ?? error}` };
    }

    const packageManager =
        packageJson.packageManager ?? null;

    return {
        available:
            typeof packageManager === "string",
        packageManager
    };
}

function getManagedPluginDependenciesState() {
    const paths =
        getManagedPaths();

    const dependency =
        "socket.io-client";

    const requiredVersion =
        "^4.8.3";

    if (!paths) {
        return {
            available: false,
            state: "unavailable",
            dependency,
            requiredVersion,
            reason: "Managed workspace unavailable."
        };
    }

    const vencordState =
        getManagedVencordState();

    if (vencordState.state !== "repository") {
        return {
            available: false,
            state: "unavailable",
            dependency,
            requiredVersion,
            reason:
                `Managed Vencord state is "${vencordState.state}".`
        };
    }

    const packageJsonPath =
        join(
            paths.vencord,
            "package.json"
        );

    if (!existsSync(packageJsonPath)) {
        return {
            available: false,
            state: "unavailable",
            dependency,
            requiredVersion,
            packageJsonPath,
            reason: "Managed Vencord package.json not found."
        };
    }

    let packageJson;

    try {
        packageJson =
            JSON.parse(
                readFileSync(
                    packageJsonPath,
                    "utf8"
                )
            );
    } catch (error) {
        return {
            available: false,
            state: "unavailable",
            dependency,
            requiredVersion,
            packageJsonPath,
            reason:
                error?.message
                    ? `Unable to read managed Vencord package.json: ${error.message}`
                    : "Unable to read managed Vencord package.json."
        };
    }

    const declaredVersion =
        packageJson.dependencies?.[dependency] ??
        packageJson.devDependencies?.[dependency] ??
        null;

    if (typeof declaredVersion !== "string") {
        return {
            available: true,
            state: "missing",
            dependency,
            requiredVersion,
            declaredVersion: null,
            packageJsonPath
        };
    }

    const exactRequiredVersion =
        requiredVersion.startsWith("^")
            ? requiredVersion.slice(1)
            : requiredVersion;

    const compatibleDeclarations =
        new Set([
            requiredVersion,
            exactRequiredVersion
        ]);

    const requiredParts = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(requiredVersion);
    const declaredParts = /^(\^?)(\d+)\.(\d+)\.(\d+)$/.exec(declaredVersion);

    const rangeCompatible =
        requiredParts !== null &&
        declaredParts !== null &&
        Number(requiredParts[1]) > 0 &&
        Number(declaredParts[2]) === Number(requiredParts[1]) &&
        (
            Number(declaredParts[3]) > Number(requiredParts[2]) ||
            (
                Number(declaredParts[3]) === Number(requiredParts[2]) &&
                Number(declaredParts[4]) >= Number(requiredParts[3])
            )
        );

    if (!compatibleDeclarations.has(declaredVersion) && !rangeCompatible) {
        return {
            available: true,
            state: "mismatch",
            dependency,
            requiredVersion,
            declaredVersion,
            packageJsonPath
        };
    }

    return {
        available: true,
        state: "installed",
        dependency,
        requiredVersion,
        declaredVersion,
        packageJsonPath
    };
}

async function verifyManagedPackageManager() {
    const paths =
        getManagedPaths();

    if (!paths) {
        throw new Error(
            "Unable to determine managed workspace."
        );
    }

    const vencordState =
        getManagedVencordState();

    if (vencordState.state !== "repository") {
        throw new Error(
            `Refusing package manager verification: managed Vencord state is "${vencordState.state}".`
        );
    }

    const requirement =
        getManagedPackageManagerRequirement();

    if (
        !requirement.available ||
        typeof requirement.packageManager !== "string"
    ) {
        throw new Error(
            requirement.reason ??
            "Managed Vencord package manager requirement is unavailable."
        );
    }

    const match =
        requirement.packageManager.match(
            /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
        );

    if (!match) {
        throw new Error(
            `Unsupported package manager requirement: "${requirement.packageManager}".`
        );
    }

    const requiredVersion =
        match[1];

    const runner =
        await resolveManagedPnpmRunner(
            requiredVersion
        );

    const result =
        await runResolvedBuildTool(
            runner.toolName,
            [
                ...runner.argsPrefix,
                "--version"
            ],
            {
                cwd: paths.vencord,
                windowsHide: true,
                timeout: 30000
            }
        );

    const resolvedVersion =
        result.stdout.trim();

    if (resolvedVersion !== requiredVersion) {
        throw new Error(
            `${runner.toolName === "corepack" ? "Corepack resolved" : "pnpm resolved"} pnpm ${resolvedVersion || "(no version returned)"} instead of required ${requiredVersion}.`
        );
    }

    return {
        ok: true,
        packageManager:
            requirement.packageManager,
        requiredVersion,
        resolvedVersion,
        runner: {
            toolName:
                runner.toolName,
            source:
                runner.source,
            command:
                runner.command,
            argsPrefix:
                runner.argsPrefix
        }
    };
}

async function installManagedPluginDependencies() {
    const paths =
        getManagedPaths();

    if (!paths) {
        throw new Error(
            "Unable to determine managed workspace."
        );
    }

    const vencordState =
        getManagedVencordState();

    if (vencordState.state !== "repository") {
        throw new Error(
            `Refusing dependency installation: managed Vencord state is "${vencordState.state}".`
        );
    }

    const verification =
        await verifyManagedPackageManager();

    if (!verification?.ok) {
        throw new Error(
            "Required pnpm verification did not complete."
        );
    }

    const dependency =
        "socket.io-client@^4.8.3";

    const runner =
        verification.runner;

    if (
        !runner ||
        typeof runner.toolName !== "string"
    ) {
        throw new Error(
            "Verified pnpm runner is unavailable."
        );
    }

    const result =
        await runResolvedBuildTool(
            runner.toolName,
            [
                ...runner.argsPrefix,
                // Keep dependency installation non-interactive for the
                // same reason as managed builds: pnpm must never wait for
                // a node_modules purge confirmation inside Electron.
                "--config.confirmModulesPurge=false",
                "add",
                "-w",
                dependency
            ],
            {
                cwd: paths.vencord,
                windowsHide: true,
                timeout: 300000
            }
        );

    return {
        ok: true,
        dependency,
        packageManager:
            verification.packageManager,
        packageManagerSource:
            runner.source,
        output:
            result.stdout,
        warnings:
            result.stderr
    };
}

function isManagedBuildReady(
    state
) {
    return Boolean(
        state &&
        state.state === "built" &&
        state.complete === true
    );
}


function getManagedBuildState() {
    const paths =
        getManagedPaths();

    if (!paths) {
        return {
            state: "unavailable",
            reason: "Managed workspace unavailable."
        };
    }

    const vencordState =
        getManagedVencordState();

    if (vencordState.state !== "repository") {
        return {
            state: "unavailable",
            reason:
                `Managed Vencord state is "${vencordState.state}".`
        };
    }

    const distPath =
        join(
            paths.vencord,
            "dist"
        );

    const requiredFiles = [
        "patcher.js",
        "preload.js",
        "renderer.js",
        "renderer.css",
        "vencordDesktopMain.js",
        "vencordDesktopPreload.js",
        "vencordDesktopRenderer.js",
        "vencordDesktopRenderer.css"
    ];

    if (!existsSync(distPath)) {
        return {
            state: "missing",
            path: distPath,
            complete: false,
            files: requiredFiles.map(name => ({
                name,
                path: join(distPath, name),
                exists: false,
                nonEmpty: false,
                size: 0
            }))
        };
    }

    const files =
        requiredFiles.map(name => {
            const filePath =
                join(
                    distPath,
                    name
                );

            if (!existsSync(filePath)) {
                return {
                    name,
                    path: filePath,
                    exists: false,
                    nonEmpty: false,
                    size: 0
                };
            }

            try {
                const size =
                    statSync(filePath).size;

                return {
                    name,
                    path: filePath,
                    exists: true,
                    nonEmpty: size > 0,
                    size
                };
            } catch (error) {
                return {
                    name,
                    path: filePath,
                    exists: true,
                    nonEmpty: false,
                    size: 0,
                    error:
                        error?.message ??
                        "Unable to inspect build artifact."
                };
            }
        });

    const complete =
        files.every(
            file =>
                file.exists &&
                file.nonEmpty
        );

    const anyArtifact =
        files.some(
            file => file.exists
        );

    return {
        state:
            complete
                ? "built"
                : anyArtifact
                    ? "partial"
                    : "missing",
        path: distPath,
        complete,
        files
    };
}

function getExternalVencordMigrationState(
    discordName,
    patchDetailsOverride = null,
    ownershipStatesOverride = null
) {
    const requestedName =
        typeof discordName === "string"
            ? discordName.trim()
            : "";

    const installs =
        detectDiscordInstalls();

    const discord =
        requestedName
            ? installs.find(
                install =>
                    install.name === requestedName
            ) ?? null
            : null;

    if (!requestedName) {
        return {
            readOnly: true,
            state: "missing-selection",
            migrationRequired: false,
            canMigrate: false,
            reason:
                "Select a detected Discord installation before checking migration state."
        };
    }

    if (!discord) {
        return {
            readOnly: true,
            state: "target-not-detected",
            migrationRequired: false,
            canMigrate: false,
            target: {
                name: requestedName,
                path: null
            },
            reason:
                `Discord ${requestedName} is not currently detected.`
        };
    }

    const patchDetails =
        Array.isArray(
            patchDetailsOverride
        )
            ? patchDetailsOverride
            : getDiscordPatchDetails();

    const ownershipStates =
        Array.isArray(
            ownershipStatesOverride
        )
            ? ownershipStatesOverride
            : getManagedUninstallStates(
                patchDetails
            );

    const ownershipState =
        ownershipStates.find(
            state =>
                state.name === discord.name
        ) ?? null;

    const patchDetail =
        patchDetails.find(
            detail =>
                detail.name === discord.name
        ) ?? null;

    const baseResult = {
        readOnly: true,
        target: {
            name:
                discord.name,
            path:
                discord.path
        },
        ownershipState:
            ownershipState?.state ?? null,
        patcherPath:
            patchDetail?.patcherPath ?? null,
        pointsToManaged:
            patchDetail?.pointsToManaged === true
    };

    if (
        ownershipState?.state === "managed"
    ) {
        return {
            ...baseResult,
            state: "already-managed",
            migrationRequired: false,
            canMigrate: false,
            reason:
                "Discord is already using the Vencord build managed by Maru Vencord Installer."
        };
    }

    if (
        ownershipState?.state === "unpatched"
    ) {
        return {
            ...baseResult,
            state: "not-required",
            migrationRequired: false,
            canMigrate: false,
            reason:
                "Discord is not currently patched with Vencord, so no existing-Vencord migration is required."
        };
    }

    if (
        ownershipState?.state !== "external"
    ) {
        return {
            ...baseResult,
            state: "unavailable",
            migrationRequired: false,
            canMigrate: false,
            reason:
                ownershipState?.reason ??
                patchDetail?.reason ??
                "Unable to verify an existing external Vencord installation."
        };
    }

    const appData =
        process.env.APPDATA;

    const candidates = [];

    const addCandidate = (
        source,
        candidatePath
    ) => {
        if (
            typeof candidatePath !== "string" ||
            candidatePath.length === 0
        ) {
            return;
        }

        const normalized =
            normalize(candidatePath);

        if (
            candidates.some(
                candidate =>
                    normalize(
                        candidate.path
                    ).toLowerCase() ===
                    normalized.toLowerCase()
            )
        ) {
            return;
        }

        candidates.push({
            source,
            path:
                candidatePath
        });
    };

    addCandidate(
        "VENCORD_USER_DATA_DIR",
        process.env.VENCORD_USER_DATA_DIR
    );

    if (
        typeof process.env.DISCORD_USER_DATA_DIR === "string" &&
        process.env.DISCORD_USER_DATA_DIR.length > 0
    ) {
        addCandidate(
            "DISCORD_USER_DATA_DIR",
            join(
                process.env.DISCORD_USER_DATA_DIR,
                "..",
                "VencordData"
            )
        );
    }

    if (
        typeof appData === "string" &&
        appData.length > 0
    ) {
        addCandidate(
            "default",
            join(
                appData,
                "Vencord"
            )
        );
    }

    const inspectedCandidates =
        candidates.map(candidate => {
            const exists =
                existsSync(
                    candidate.path
                );

            if (!exists) {
                return {
                    ...candidate,
                    exists: false,
                    accessible: true,
                    settingsPath:
                        join(
                            candidate.path,
                            "settings"
                        ),
                    themesPath:
                        join(
                            candidate.path,
                            "themes"
                        )
                };
            }

            try {
                const rootStat =
                    statSync(
                        candidate.path
                    );

                if (!rootStat.isDirectory()) {
                    return {
                        ...candidate,
                        exists: true,
                        accessible: false,
                        error:
                            "Vencord user-data candidate exists but is not a directory."
                    };
                }

                const settingsPath =
                    join(
                        candidate.path,
                        "settings"
                    );

                const themesPath =
                    join(
                        candidate.path,
                        "themes"
                    );

                const settingsFile =
                    join(
                        settingsPath,
                        "settings.json"
                    );

                const nativeSettingsFile =
                    join(
                        settingsPath,
                        "native-settings.json"
                    );

                const quickCssFile =
                    join(
                        settingsPath,
                        "quickCss.css"
                    );

                let themeFiles = [];

                if (
                    existsSync(themesPath)
                ) {
                    themeFiles =
                        readdirSync(
                            themesPath,
                            {
                                withFileTypes: true
                            }
                        )
                            .filter(entry =>
                                entry.isFile() &&
                                entry.name
                                    .toLowerCase()
                                    .endsWith(".css")
                            )
                            .map(entry =>
                                entry.name
                            );
                }

                return {
                    ...candidate,
                    exists: true,
                    accessible: true,
                    settingsPath,
                    themesPath,
                    settings: {
                        directoryExists:
                            existsSync(
                                settingsPath
                            ),
                        settingsJsonExists:
                            existsSync(
                                settingsFile
                            ),
                        nativeSettingsExists:
                            existsSync(
                                nativeSettingsFile
                            ),
                        quickCssExists:
                            existsSync(
                                quickCssFile
                            ),
                        settingsFile,
                        nativeSettingsFile,
                        quickCssFile
                    },
                    themes: {
                        directoryExists:
                            existsSync(
                                themesPath
                            ),
                        cssFileCount:
                            themeFiles.length,
                        files:
                            themeFiles
                    }
                };
            } catch (error) {
                return {
                    ...candidate,
                    exists: true,
                    accessible: false,
                    error:
                        error?.message ??
                        "Unable to inspect Vencord user data."
                };
            }
        });

    const selectedData =
        inspectedCandidates.find(
            candidate =>
                candidate.exists &&
                candidate.accessible
        ) ?? null;

    const inaccessibleExisting =
        inspectedCandidates.find(
            candidate =>
                candidate.exists &&
                !candidate.accessible
        ) ?? null;

    if (
        !selectedData &&
        inaccessibleExisting
    ) {
        return {
            ...baseResult,
            state: "blocked",
            migrationRequired: true,
            canMigrate: false,
            dataState:
                "unavailable",
            candidates:
                inspectedCandidates,
            reason:
                `Existing Vencord user data could not be inspected: ${inaccessibleExisting.error}`
        };
    }

    const managedPaths =
        getManagedPaths();

    const backupRoot =
        managedPaths
            ? join(
                managedPaths.root,
                "migration-backups"
            )
            : null;

    const preserve = selectedData
        ? {
            sourceDataDir:
                selectedData.path,
            settings: {
                source:
                    selectedData.settingsPath,
                exists:
                    selectedData.settings
                        ?.directoryExists === true,
                settingsJsonExists:
                    selectedData.settings
                        ?.settingsJsonExists === true,
                nativeSettingsExists:
                    selectedData.settings
                        ?.nativeSettingsExists === true,
                quickCssExists:
                    selectedData.settings
                        ?.quickCssExists === true
            },
            themes: {
                source:
                    selectedData.themesPath,
                exists:
                    selectedData.themes
                        ?.directoryExists === true,
                cssFileCount:
                    selectedData.themes
                        ?.cssFileCount ?? 0,
                files:
                    selectedData.themes
                        ?.files ?? []
            }
        }
        : {
            sourceDataDir:
                null,
            settings: {
                source: null,
                exists: false,
                settingsJsonExists: false,
                nativeSettingsExists: false,
                quickCssExists: false
            },
            themes: {
                source: null,
                exists: false,
                cssFileCount: 0,
                files: []
            }
        };

    return {
        ...baseResult,
        state:
            selectedData
                ? "migration-ready"
                : "migration-ready-no-user-data",
        migrationRequired: true,
        canMigrate: true,
        dataState:
            selectedData
                ? "found"
                : "not-found",
        selectedDataSource:
            selectedData?.source ?? null,
        selectedDataDir:
            selectedData?.path ?? null,
        candidates:
            inspectedCandidates,
        preserve,
        plannedBackupRoot:
            backupRoot,
        reason:
            selectedData
                ? "Existing external Vencord and its user data are ready for a managed migration."
                : "Existing external Vencord is ready for migration. No standard Vencord user-data directory was found to preserve."
    };
}


function getFileSha256(filePath) {
    const hash =
        createHash("sha256");

    hash.update(
        readFileSync(filePath)
    );

    return hash.digest("hex");
}


function getBackupFileManifest(rootPath) {
    const files = [];

    const walk = (
        currentPath,
        relativePath = ""
    ) => {
        const entries =
            readdirSync(
                currentPath,
                {
                    withFileTypes: true
                }
            );

        for (const entry of entries) {
            const entryRelativePath =
                relativePath
                    ? join(
                        relativePath,
                        entry.name
                    )
                    : entry.name;

            const entryPath =
                join(
                    currentPath,
                    entry.name
                );

            if (entry.isDirectory()) {
                walk(
                    entryPath,
                    entryRelativePath
                );

                continue;
            }

            if (!entry.isFile()) {
                throw new Error(
                    `Unsupported non-file entry in Vencord user data: ${entryRelativePath}`
                );
            }

            const stats =
                statSync(
                    entryPath
                );

            files.push({
                path:
                    entryRelativePath,
                size:
                    stats.size,
                sha256:
                    getFileSha256(
                        entryPath
                    )
            });
        }
    };

    walk(rootPath);

    files.sort(
        (left, right) =>
            left.path.localeCompare(
                right.path
            )
    );

    return files;
}


function verifyBackupFileManifests(
    sourceFiles,
    backupFiles
) {
    if (
        sourceFiles.length !==
        backupFiles.length
    ) {
        return {
            verified: false,
            reason:
                `File count mismatch. Source: ${sourceFiles.length}; backup: ${backupFiles.length}.`
        };
    }

    for (
        let index = 0;
        index < sourceFiles.length;
        index += 1
    ) {
        const source =
            sourceFiles[index];

        const backup =
            backupFiles[index];

        if (
            source.path !== backup.path ||
            source.size !== backup.size ||
            source.sha256 !== backup.sha256
        ) {
            return {
                verified: false,
                reason:
                    `Backup verification failed for ${source.path}.`
            };
        }
    }

    return {
        verified: true,
        reason: null
    };
}


function createMigrationBackupDirectory(
    backupRoot,
    discordName
) {
    mkdirSync(
        backupRoot,
        {
            recursive: true
        }
    );

    const timestamp =
        new Date()
            .toISOString()
            .replace(
                /[:.]/g,
                "-"
            );

    const safeDiscordName =
        String(discordName)
            .replace(
                /[^a-z0-9_-]+/gi,
                "-"
            );

    const baseName =
        `${timestamp}-Discord-${safeDiscordName}`;

    let candidate =
        join(
            backupRoot,
            baseName
        );

    let suffix = 1;

    while (existsSync(candidate)) {
        candidate =
            join(
                backupRoot,
                `${baseName}-${suffix}`
            );

        suffix += 1;
    }

    mkdirSync(
        candidate,
        {
            recursive: false
        }
    );

    return candidate;
}


function backupExternalVencordUserData(
    discordName
) {
    const migration =
        getExternalVencordMigrationState(
            discordName
        );

    if (
        migration.migrationRequired !== true ||
        migration.canMigrate !== true
    ) {
        throw new Error(
            migration.reason ??
            "Existing Vencord migration is not eligible for backup."
        );
    }

    if (
        migration.dataState !== "found" ||
        typeof migration.selectedDataDir !== "string" ||
        migration.selectedDataDir.length === 0
    ) {
        return {
            success: true,
            state: "not-required",
            target:
                migration.target,
            sourceDataDir: null,
            backupDirectory: null,
            backupDataDir: null,
            manifestPath: null,
            verified: true,
            fileCount: 0,
            totalBytes: 0,
            reason:
                "No existing Vencord user-data directory was found, so there is nothing to back up."
        };
    }

    const managedPaths =
        getManagedPaths();

    if (!managedPaths) {
        throw new Error(
            "Managed workspace path is unavailable."
        );
    }

    const sourceDataDir =
        normalize(
            migration.selectedDataDir
        );

    const managedRoot =
        normalize(
            managedPaths.root
        );

    const sourceLower =
        sourceDataDir.toLowerCase();

    const managedLower =
        managedRoot.toLowerCase();

    if (
        sourceLower === managedLower ||
        sourceLower.startsWith(
            `${managedLower}\\`
        ) ||
        sourceLower.startsWith(
            `${managedLower}/`
        )
    ) {
        throw new Error(
            "Refusing to back up Vencord user data from inside the Maru installer managed workspace."
        );
    }

    if (!existsSync(sourceDataDir)) {
        throw new Error(
            `Vencord user-data directory disappeared before backup: ${sourceDataDir}`
        );
    }

    const sourceStats =
        statSync(
            sourceDataDir
        );

    if (!sourceStats.isDirectory()) {
        throw new Error(
            `Vencord user-data source is not a directory: ${sourceDataDir}`
        );
    }

    // Snapshot the source before copying. The same recursive manifest
    // routine is used after the copy so every regular file is compared
    // by relative path, byte size, and SHA-256 hash.
    const sourceFiles =
        getBackupFileManifest(
            sourceDataDir
        );

    const totalBytes =
        sourceFiles.reduce(
            (total, file) =>
                total + file.size,
            0
        );

    const backupRoot =
        join(
            managedRoot,
            "migration-backups"
        );

    const backupDirectory =
        createMigrationBackupDirectory(
            backupRoot,
            migration.target?.name ??
            discordName
        );

    const backupDataDir =
        join(
            backupDirectory,
            "Vencord"
        );

    try {
        cpSync(
            sourceDataDir,
            backupDataDir,
            {
                recursive: true,
                force: false,
                errorOnExist: true
            }
        );
    } catch (error) {
        throw new Error(
            `Failed to copy Vencord user data to ${backupDataDir}: ${error?.message ?? "Unknown copy error."}`
        );
    }

    let backupFiles;

    try {
        backupFiles =
            getBackupFileManifest(
                backupDataDir
            );
    } catch (error) {
        throw new Error(
            `Backup was copied to ${backupDataDir}, but verification could not inspect it: ${error?.message ?? "Unknown verification error."}`
        );
    }

    const verification =
        verifyBackupFileManifests(
            sourceFiles,
            backupFiles
        );

    if (!verification.verified) {
        const failedManifestPath =
            join(
                backupDirectory,
                "backup-verification-failed.json"
            );

        writeFileSync(
            failedManifestPath,
            JSON.stringify(
                {
                    createdAt:
                        new Date()
                            .toISOString(),
                    verified: false,
                    target:
                        migration.target,
                    sourceDataDir,
                    backupDataDir,
                    sourceFileCount:
                        sourceFiles.length,
                    backupFileCount:
                        backupFiles.length,
                    reason:
                        verification.reason
                },
                null,
                2
            ),
            "utf8"
        );

        throw new Error(
            `Vencord user-data backup verification failed. The copied backup was kept for inspection at ${backupDirectory}. ${verification.reason}`
        );
    }

    const manifestPath =
        join(
            backupDirectory,
            "backup-manifest.json"
        );

    const manifest = {
        createdAt:
            new Date()
                .toISOString(),
        verified: true,
        target:
            migration.target,
        sourceDataDir,
        backupDataDir,
        fileCount:
            sourceFiles.length,
        totalBytes,
        files:
            sourceFiles
    };

    writeFileSync(
        manifestPath,
        JSON.stringify(
            manifest,
            null,
            2
        ),
        "utf8"
    );

    // Re-check the live ownership state after the backup. This does not
    // mutate Discord; it makes sure the target did not change while we
    // were preserving user data.
    const postBackupMigration =
        getExternalVencordMigrationState(
            discordName
        );

    if (
        postBackupMigration.migrationRequired !== true ||
        postBackupMigration.canMigrate !== true
    ) {
        throw new Error(
            `Vencord user data was backed up and verified at ${backupDirectory}, but the Discord migration state changed afterward. No uninstall or patch action was performed.`
        );
    }

    return {
        success: true,
        state: "verified",
        target:
            migration.target,
        sourceDataDir,
        backupDirectory,
        backupDataDir,
        manifestPath,
        verified: true,
        fileCount:
            sourceFiles.length,
        totalBytes,
        preserved: {
            settings:
                migration.preserve
                    ?.settings ?? null,
            themes:
                migration.preserve
                    ?.themes ?? null
        },
        reason:
            "Existing Vencord user data was copied and verified successfully. No Discord or Vencord installation changes were made."
    };
}


function getExternalVencordBackupState(
    discordName
) {
    const requestedName =
        typeof discordName === "string"
            ? discordName.trim()
            : "";

    if (!requestedName) {
        return {
            readOnly: true,
            state: "missing-selection",
            verified: false,
            canUseForMigration: false,
            reason:
                "Select a detected Discord installation before checking migration backup state."
        };
    }

    const installs =
        detectDiscordInstalls();

    const discord =
        installs.find(
            install =>
                install.name === requestedName
        ) ?? null;

    if (!discord) {
        return {
            readOnly: true,
            state: "target-not-detected",
            verified: false,
            canUseForMigration: false,
            target: {
                name: requestedName,
                path: null
            },
            reason:
                `Discord ${requestedName} is not currently detected.`
        };
    }

    const migration =
        getExternalVencordMigrationState(
            requestedName
        );

    const target = {
        name:
            discord.name,
        path:
            discord.path
    };

    if (
        migration.migrationRequired === true &&
        migration.canMigrate === true &&
        migration.dataState === "not-found"
    ) {
        return {
            readOnly: true,
            state: "not-required",
            verified: true,
            canUseForMigration: true,
            target,
            backupRequired: false,
            reason:
                "No existing Vencord user-data directory is currently detected, so a user-data backup is not required."
        };
    }

    const managedPaths =
        getManagedPaths();

    if (!managedPaths?.root) {
        return {
            readOnly: true,
            state: "unavailable",
            verified: false,
            canUseForMigration: false,
            target,
            backupRequired: true,
            reason:
                "Managed workspace path is unavailable."
        };
    }

    const backupRoot =
        join(
            managedPaths.root,
            "migration-backups"
        );

    if (!existsSync(backupRoot)) {
        return {
            readOnly: true,
            state: "missing",
            verified: false,
            canUseForMigration: false,
            target,
            backupRequired: true,
            backupRoot,
            reason:
                "No migration backup directory exists yet."
        };
    }

    let backupRootStats;

    try {
        backupRootStats =
            statSync(
                backupRoot
            );
    } catch (error) {
        return {
            readOnly: true,
            state: "unavailable",
            verified: false,
            canUseForMigration: false,
            target,
            backupRequired: true,
            backupRoot,
            reason:
                error?.message ??
                "Unable to inspect the migration backup directory."
        };
    }

    if (!backupRootStats.isDirectory()) {
        return {
            readOnly: true,
            state: "unavailable",
            verified: false,
            canUseForMigration: false,
            target,
            backupRequired: true,
            backupRoot,
            reason:
                "Migration backup path exists but is not a directory."
        };
    }

    let backupDirectories;

    try {
        backupDirectories =
            readdirSync(
                backupRoot,
                {
                    withFileTypes: true
                }
            )
                .filter(entry =>
                    entry.isDirectory()
                )
                .map(entry =>
                    join(
                        backupRoot,
                        entry.name
                    )
                );
    } catch (error) {
        return {
            readOnly: true,
            state: "unavailable",
            verified: false,
            canUseForMigration: false,
            target,
            backupRequired: true,
            backupRoot,
            reason:
                error?.message ??
                "Unable to list migration backup directories."
        };
    }

    const normalizedTargetPath =
        normalize(
            discord.path
        ).toLowerCase();

    const expectedSourceDataDir =
        migration.dataState === "found" &&
            typeof migration.selectedDataDir === "string"
            ? normalize(
                migration.selectedDataDir
            )
            : null;

    const inspected = [];

    for (
        const backupDirectory of
        backupDirectories
    ) {
        const manifestPath =
            join(
                backupDirectory,
                "backup-manifest.json"
            );

        if (!existsSync(manifestPath)) {
            continue;
        }

        const backupDataDir =
            join(
                backupDirectory,
                "Vencord"
            );

        let manifest;

        try {
            manifest =
                JSON.parse(
                    readFileSync(
                        manifestPath,
                        "utf8"
                    )
                );
        } catch (error) {
            inspected.push({
                backupDirectory,
                manifestPath,
                state: "invalid-manifest",
                verified: false,
                createdAt: null,
                reason:
                    error?.message ??
                    "Backup manifest could not be parsed."
            });

            continue;
        }

        const createdAt =
            typeof manifest?.createdAt === "string"
                ? manifest.createdAt
                : null;

        const manifestTargetName =
            typeof manifest?.target?.name === "string"
                ? manifest.target.name
                : null;

        const manifestTargetPath =
            typeof manifest?.target?.path === "string"
                ? normalize(
                    manifest.target.path
                ).toLowerCase()
                : null;

        if (
            manifestTargetName !==
            discord.name
        ) {
            continue;
        }

        if (
            manifestTargetPath &&
            manifestTargetPath !==
            normalizedTargetPath
        ) {
            inspected.push({
                backupDirectory,
                manifestPath,
                state: "target-mismatch",
                verified: false,
                createdAt,
                reason:
                    "Backup manifest target path does not match the currently detected Discord installation."
            });

            continue;
        }

        if (
            manifest?.verified !== true ||
            !Array.isArray(
                manifest?.files
            ) ||
            typeof manifest?.sourceDataDir !== "string"
        ) {
            inspected.push({
                backupDirectory,
                manifestPath,
                state: "invalid-manifest",
                verified: false,
                createdAt,
                reason:
                    "Backup manifest is missing required verified backup metadata."
            });

            continue;
        }

        const manifestSourceDataDir =
            normalize(
                manifest.sourceDataDir
            );

        if (
            expectedSourceDataDir &&
            manifestSourceDataDir
                .toLowerCase() !==
            expectedSourceDataDir
                .toLowerCase()
        ) {
            inspected.push({
                backupDirectory,
                manifestPath,
                state: "source-mismatch",
                verified: false,
                createdAt,
                reason:
                    "Backup was created from a different Vencord user-data directory than the one currently detected."
            });

            continue;
        }

        if (
            !existsSync(backupDataDir)
        ) {
            inspected.push({
                backupDirectory,
                manifestPath,
                backupDataDir,
                state: "missing-data",
                verified: false,
                createdAt,
                reason:
                    "Backup manifest exists, but its Vencord data directory is missing."
            });

            continue;
        }

        let backupFiles;

        try {
            backupFiles =
                getBackupFileManifest(
                    backupDataDir
                );
        } catch (error) {
            inspected.push({
                backupDirectory,
                manifestPath,
                backupDataDir,
                state: "verification-error",
                verified: false,
                createdAt,
                reason:
                    error?.message ??
                    "Unable to inspect backup files."
            });

            continue;
        }

        const backupVerification =
            verifyBackupFileManifests(
                manifest.files,
                backupFiles
            );

        if (!backupVerification.verified) {
            inspected.push({
                backupDirectory,
                manifestPath,
                backupDataDir,
                state: "backup-changed",
                verified: false,
                createdAt,
                reason:
                    backupVerification.reason
            });

            continue;
        }

        const calculatedBytes =
            backupFiles.reduce(
                (total, file) =>
                    total + file.size,
                0
            );

        if (
            Number.isFinite(
                manifest.fileCount
            ) &&
            manifest.fileCount !==
            backupFiles.length
        ) {
            inspected.push({
                backupDirectory,
                manifestPath,
                backupDataDir,
                state: "manifest-mismatch",
                verified: false,
                createdAt,
                reason:
                    `Backup manifest file count is ${manifest.fileCount}, but ${backupFiles.length} files are present.`
            });

            continue;
        }

        if (
            Number.isFinite(
                manifest.totalBytes
            ) &&
            manifest.totalBytes !==
            calculatedBytes
        ) {
            inspected.push({
                backupDirectory,
                manifestPath,
                backupDataDir,
                state: "manifest-mismatch",
                verified: false,
                createdAt,
                reason:
                    `Backup manifest byte count is ${manifest.totalBytes}, but ${calculatedBytes} bytes are present.`
            });

            continue;
        }

        let sourceCurrent = null;
        let sourceReason = null;

        if (
            expectedSourceDataDir &&
            existsSync(
                expectedSourceDataDir
            )
        ) {
            try {
                const liveSourceFiles =
                    getBackupFileManifest(
                        expectedSourceDataDir
                    );

                const liveVerification =
                    verifyBackupFileManifests(
                        manifest.files,
                        liveSourceFiles
                    );

                sourceCurrent =
                    liveVerification.verified;

                sourceReason =
                    liveVerification.reason;
            } catch (error) {
                sourceCurrent = false;

                sourceReason =
                    error?.message ??
                    "Unable to verify the current Vencord user-data directory against the backup.";
            }
        }

        inspected.push({
            backupDirectory,
            manifestPath,
            backupDataDir,
            state:
                sourceCurrent === false
                    ? "source-changed"
                    : "verified",
            verified: true,
            sourceCurrent,
            createdAt,
            fileCount:
                backupFiles.length,
            totalBytes:
                calculatedBytes,
            sourceDataDir:
                manifestSourceDataDir,
            reason:
                sourceCurrent === false
                    ? sourceReason ??
                    "Current Vencord user data has changed since this backup was created."
                    : "Backup files still match the verified manifest."
        });
    }

    const timestampValue =
        entry => {
            const parsed =
                Date.parse(
                    entry.createdAt ?? ""
                );

            if (
                Number.isFinite(parsed)
            ) {
                return parsed;
            }

            try {
                return statSync(
                    entry.backupDirectory
                ).mtimeMs;
            } catch {
                return 0;
            }
        };

    inspected.sort(
        (left, right) =>
            timestampValue(right) -
            timestampValue(left)
    );

    const newestVerified =
        inspected.find(
            entry =>
                entry.state === "verified" &&
                entry.verified === true &&
                entry.sourceCurrent !== false
        ) ?? null;

    if (newestVerified) {
        return {
            readOnly: true,
            state: "verified",
            verified: true,
            canUseForMigration: true,
            backupRequired: true,
            target,
            backupRoot,
            backupDirectory:
                newestVerified.backupDirectory,
            backupDataDir:
                newestVerified.backupDataDir,
            manifestPath:
                newestVerified.manifestPath,
            createdAt:
                newestVerified.createdAt,
            sourceDataDir:
                newestVerified.sourceDataDir,
            sourceCurrent:
                newestVerified.sourceCurrent,
            fileCount:
                newestVerified.fileCount,
            totalBytes:
                newestVerified.totalBytes,
            reason:
                "A persistent migration backup was found and all backup files still match its verified manifest."
        };
    }

    const newestStale =
        inspected.find(
            entry =>
                entry.state === "source-changed" &&
                entry.verified === true
        ) ?? null;

    if (newestStale) {
        return {
            readOnly: true,
            state: "stale",
            verified: true,
            canUseForMigration: false,
            backupRequired: true,
            target,
            backupRoot,
            backupDirectory:
                newestStale.backupDirectory,
            backupDataDir:
                newestStale.backupDataDir,
            manifestPath:
                newestStale.manifestPath,
            createdAt:
                newestStale.createdAt,
            sourceDataDir:
                newestStale.sourceDataDir,
            sourceCurrent: false,
            fileCount:
                newestStale.fileCount,
            totalBytes:
                newestStale.totalBytes,
            reason:
                "The backup itself is still verified, but the live Vencord user data changed after it was created. Create a fresh backup before migration."
        };
    }

    if (inspected.length > 0) {
        return {
            readOnly: true,
            state: "invalid",
            verified: false,
            canUseForMigration: false,
            backupRequired: true,
            target,
            backupRoot,
            inspectedBackups:
                inspected.map(entry => ({
                    backupDirectory:
                        entry.backupDirectory,
                    state:
                        entry.state,
                    createdAt:
                        entry.createdAt,
                    reason:
                        entry.reason
                })),
            reason:
                "Migration backup folders were found, but none currently pass verification for this Discord installation."
        };
    }

    return {
        readOnly: true,
        state: "missing",
        verified: false,
        canUseForMigration: false,
        backupRequired: true,
        target,
        backupRoot,
        reason:
            "No verified migration backup was found for this Discord installation."
    };
}


async function getManagedInstallPlan(
    discordName,
    {
        setupOnly = false
    } = {}
) {
    const requestedName =
        typeof discordName === "string"
            ? discordName.trim()
            : "";

    const plannerTargetName =
        setupOnly
            ? (
                requestedName ||
                "Isolated Setup Coordinator"
            )
            : requestedName;

    const installs =
        detectDiscordInstalls();

    const discord =
        requestedName
            ? installs.find(
                install =>
                    install.name === requestedName
            )
            : null;

    const workspaceState =
        getManagedWorkspaceState();

    const vencordState =
        getManagedVencordState();
    const sourceHealth = getManagedSourceHealth();

    const userPluginsState =
        getManagedUserPluginsState();

    const bundledPluginsState =
        getBundledPluginsState();

    const installedPluginsState =
        getManagedInstalledPluginsState();

    const dependencyState =
        getManagedPluginDependenciesState();

    const buildState =
        getManagedBuildHealth();
    const customizationState = getManagedCustomizationState();

    const patchDetails =
        setupOnly
            ? getDiscordPatchDetails()
            : await getDiscordPatchDetailsWithRuntime();

    const patchDetail =
        discord
            ? patchDetails.find(
                detail =>
                    detail.name === discord.name
            ) ?? null
            : null;

    const uninstallStates =
        getManagedUninstallStates(
            patchDetails
        );

    const ownershipState =
        discord
            ? uninstallStates.find(
                state =>
                    state.name === discord.name
            ) ?? null
            : null;

    const isExternalVencord =
        Boolean(discord) &&
        ownershipState?.state === "external";

    const migrationState =
        isExternalVencord
            ? getExternalVencordMigrationState(
                discord.name,
                patchDetails,
                uninstallStates
            )
            : null;

    const backupState =
        isExternalVencord &&
            migrationState?.migrationRequired === true &&
            migrationState?.canMigrate === true
            ? getExternalVencordBackupState(
                discord.name
            )
            : null;

    const environment =
        await detectBuildEnvironment();

    const checks = {
        target: {
            state:
                setupOnly
                    ? "setup-only"
                    : !requestedName
                        ? "missing-selection"
                        : !discord
                            ? "not-detected"
                            : ownershipState?.state ??
                            patchDetail?.state ??
                            "unavailable",
            ready:
                setupOnly ||
                (
                    Boolean(discord) &&
                    patchDetail?.mutationSafe !== false &&
                    (
                        ownershipState?.state === "unpatched" ||
                        ownershipState?.state === "managed" ||
                        (
                            isExternalVencord &&
                            migrationState?.migrationRequired === true &&
                            migrationState?.canMigrate === true
                        )
                    )
                ),
            name:
                setupOnly
                    ? plannerTargetName
                    : discord?.name ??
                    (requestedName || null),
            path:
                setupOnly
                    ? null
                    : discord?.path ?? null,
            patchState:
                patchDetail?.state ?? null,
            detailState:
                patchDetail?.detailState ?? null,
            ownershipState:
                ownershipState?.state ?? null,
            pointsToManaged:
                patchDetail?.pointsToManaged === true,
            discordRunning:
                patchDetail?.discordRunning ?? null,
            runningAppVersion:
                patchDetail?.runningAppVersion ?? null,
            runningAppPath:
                patchDetail?.runningAppPath ?? null,
            vencordCliAppVersion:
                patchDetail?.vencordCliAppVersion ?? null,
            vencordCliAppPath:
                patchDetail?.vencordCliAppPath ?? null,
            mutationSafe:
                patchDetail?.mutationSafe !== false,
            mutationTargetMismatch:
                patchDetail?.mutationTargetMismatch === true,
            mutationBlockReason:
                patchDetail?.mutationBlockReason ?? null,
            reason:
                ownershipState?.reason ??
                patchDetail?.reason ??
                null
        },

        workspace: {
            state:
                workspaceState.state,
            ready:
                workspaceState.state === "ready",
            path:
                workspaceState.path ?? null,
            reason:
                workspaceState.reason ?? null
        },

        vencord: {
            state:
                vencordState.state,
            ready:
                vencordState.state === "repository" && sourceHealth.valid === true,
            path:
                vencordState.path ?? null,
            reason:
                sourceHealth.reason ?? vencordState.reason ?? null
        },

        userplugins: {
            state:
                userPluginsState.state,
            ready:
                userPluginsState.state === "ready",
            path:
                userPluginsState.path ?? null,
            reason:
                userPluginsState.reason ?? null
        },

        bundledPayload: {
            state:
                bundledPluginsState.complete
                    ? "complete"
                    : "incomplete",
            ready:
                bundledPluginsState.complete === true,
            root:
                bundledPluginsState.root,
            plugins:
                bundledPluginsState.plugins
        },

        installedPlugins: {
            state:
                installedPluginsState.state,
            ready:
                installedPluginsState.state === "installed",
            root:
                installedPluginsState.root ?? null,
            reason:
                installedPluginsState.reason ?? null,
            plugins:
                installedPluginsState.plugins ?? []
        },

        dependencies: {
            state:
                dependencyState.state,
            ready:
                dependencyState.state === "installed",
            dependency:
                dependencyState.dependency,
            requiredVersion:
                dependencyState.requiredVersion,
            declaredVersion:
                dependencyState.declaredVersion ?? null,
            reason:
                dependencyState.reason ?? null
        },

        managedNode: (() => {
            const managedPaths =
                getManagedPaths();

            const target =
                managedPaths?.toolchain
                    ? join(
                        managedPaths.toolchain,
                        "node"
                    )
                    : null;

            const resolved =
                environment.resolvedTools?.node ??
                null;

            const exactResolvedManagedNode =
                resolved?.available === true &&
                resolved?.source === "managed" &&
                resolved?.version ===
                `v${MANAGED_NODE_VERSION}`;

            let portableState = {
                available: false,
                reason:
                    "Portable Managed Node provenance is not available."
            };

            if (
                target &&
                existsSync(
                    target
                )
            ) {
                portableState =
                    readManagedNodeRuntimeManifest(
                        target
                    );
            }

            const verifiedPortableReady =
                Boolean(
                    exactResolvedManagedNode &&
                    portableState?.available === true &&
                    normalize(
                        resolved.command
                    ).toLowerCase() ===
                    normalize(
                        portableState.nodePath
                    ).toLowerCase()
                );

            // Temporary development compatibility only. A packaged
            // installer never accepts a seed/copy without provenance.
            const developmentSeedReady =
                Boolean(
                    !app.isPackaged &&
                    exactResolvedManagedNode &&
                    portableState?.available !== true
                );

            const ready =
                verifiedPortableReady ||
                developmentSeedReady;

            return {
                state:
                    verifiedPortableReady
                        ? "ready"
                        : developmentSeedReady
                            ? "development-seed"
                            : target &&
                                existsSync(target)
                                ? "occupied-unverified"
                                : "missing",
                ready,
                verifiedPortable:
                    verifiedPortableReady,
                developmentSeed:
                    developmentSeedReady,
                requiredVersion:
                    `v${MANAGED_NODE_VERSION}`,
                resolvedVersion:
                    resolved?.version ??
                    null,
                source:
                    resolved?.source ??
                    null,
                command:
                    resolved?.command ??
                    null,
                target,
                manifestPath:
                    portableState?.manifestPath ??
                    null,
                reason:
                    ready
                        ? developmentSeedReady
                            ? "Temporary development seed accepted only because this Electron app is not packaged."
                            : null
                        : portableState?.reason ??
                        `Exact verified portable Managed Node v${MANAGED_NODE_VERSION} is not active.`
            };
        })(),

        managedPnpm: (() => {
            const requirement =
                getManagedPackageManagerRequirement();

            const match =
                requirement?.available === true &&
                    typeof requirement?.packageManager === "string"
                    ? requirement.packageManager.match(
                        /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
                    )
                    : null;

            const requiredVersion =
                match?.[1] ?? null;

            const resolved =
                environment.resolvedTools?.pnpm ??
                null;

            const ready =
                Boolean(
                    requiredVersion &&
                    resolved?.available === true &&
                    resolved?.source === "managed" &&
                    resolved?.version ===
                    requiredVersion
                );

            return {
                state:
                    ready
                        ? "ready"
                        : requirement?.available === true
                            ? "needs-managed-runtime"
                            : "unavailable",
                ready,
                packageManager:
                    requirement?.packageManager ??
                    null,
                requiredVersion,
                resolvedVersion:
                    resolved?.version ??
                    null,
                source:
                    resolved?.source ??
                    null,
                command:
                    resolved?.command ??
                    null,
                reason:
                    ready
                        ? null
                        : requirement?.reason ??
                        (
                            requiredVersion
                                ? `Exact managed pnpm ${requiredVersion} is not active.`
                                : "Managed pnpm requirement is not available yet."
                        )
            };
        })(),

        customizations: { ready: customizationState.ready === true, reason: customizationState.reason ?? null },

        build: {
            state:
                buildState.state,
            ready:
                buildState.state === "built",
            path:
                buildState.path ?? null,
            reason:
                buildState.reason ?? null
        },

        migration: {
            state:
                isExternalVencord
                    ? migrationState?.state ??
                    "unavailable"
                    : "not-required",
            required:
                isExternalVencord,
            ready:
                !isExternalVencord ||
                (
                    migrationState?.migrationRequired === true &&
                    migrationState?.canMigrate === true
                ),
            dataState:
                migrationState?.dataState ?? null,
            selectedDataDir:
                migrationState?.selectedDataDir ?? null,
            plannedBackupRoot:
                migrationState?.plannedBackupRoot ?? null,
            reason:
                migrationState?.reason ?? null
        },

        migrationBackup: {
            state:
                isExternalVencord
                    ? backupState?.state ??
                    "unavailable"
                    : "not-required",
            required:
                isExternalVencord &&
                backupState?.backupRequired !== false,
            ready:
                !isExternalVencord ||
                backupState?.canUseForMigration === true,
            verified:
                backupState?.verified === true,
            canUseForMigration:
                backupState?.canUseForMigration === true,
            backupDirectory:
                backupState?.backupDirectory ?? null,
            manifestPath:
                backupState?.manifestPath ?? null,
            sourceCurrent:
                backupState?.sourceCurrent ?? null,
            reason:
                backupState?.reason ?? null
        },

        environment: {
            state:
                environment.node &&
                    environment.packageManagerAvailable
                    ? "ready"
                    : "bootstrap-required",
            ready:
                Boolean(
                    environment.node &&
                    environment.packageManagerAvailable
                ),
            bootstrapSupported: true,
            tools: environment
        }
    };

    const actions = [];
    const blockers = [];

    const addAction = (
        id,
        label,
        description
    ) => {
        if (
            actions.some(
                action =>
                    action.id === id
            )
        ) {
            return;
        }

        actions.push({
            id,
            label,
            description
        });
    };

    const addBlocker = (
        id,
        message
    ) => {
        if (
            blockers.some(
                blocker =>
                    blocker.id === id
            )
        ) {
            return;
        }

        blockers.push({
            id,
            message
        });
    };

    if (!setupOnly) {
        if (!requestedName) {
            addBlocker(
                "target-selection",
                "Select a detected Discord installation before creating an install plan."
            );
        } else if (!discord) {
            addBlocker(
                "target-not-detected",
                `Discord ${requestedName} is not currently detected.`
            );
        } else if (
            patchDetail?.mutationSafe === false
        ) {
            addBlocker(
                "discord-mutation-target",
                patchDetail.mutationBlockReason ??
                `Discord ${discord.name} has a version/target mismatch and is not currently safe to modify.`
            );
        } else if (
            ownershipState?.state === "external"
        ) {
            if (
                migrationState?.migrationRequired !== true ||
                migrationState?.canMigrate !== true
            ) {
                addBlocker(
                    "external-vencord-migration",
                    migrationState?.reason ??
                    `Discord ${discord.name} has an existing Vencord installation, but it is not currently safe to migrate automatically.`
                );
            }
        } else if (
            ownershipState?.state !== "unpatched" &&
            ownershipState?.state !== "managed"
        ) {
            addBlocker(
                "target-state",
                ownershipState?.reason ??
                patchDetail?.reason ??
                `Discord ${discord.name} is not in a verified installable state.`
            );
        }
    }

    const alreadyManaged =
        Boolean(discord) &&
        ownershipState?.state === "managed" &&
        patchDetail?.pointsToManaged === true;

    const managedPrerequisitesReady = checks.vencord.ready && checks.userplugins.ready && checks.installedPlugins.ready && checks.dependencies.ready && checks.build.ready && checks.customizations.ready;
    if (alreadyManaged && !managedPrerequisitesReady && blockers.length === 0)
        addAction("repair-managed-vencord", "Recover managed Vencord", "Assess and recover source, plugins, or build at the installed commit, then verify the Discord patch.");

    const migrationBackupReady =
        !isExternalVencord ||
        backupState?.canUseForMigration === true;

    if (
        blockers.length === 0 &&
        !alreadyManaged &&
        isExternalVencord &&
        !migrationBackupReady
    ) {
        addAction(
            "backup-external-vencord-user-data",
            "Back up existing Vencord data",
            backupState?.state === "stale"
                ? "Create a fresh verified backup because the existing Vencord user data changed after the previous backup."
                : "Create and verify a safety backup of the existing Vencord user data before any migration can continue."
        );
    }

    if (
        blockers.length === 0 &&
        !alreadyManaged &&
        migrationBackupReady
    ) {
        let willHaveWorkspace =
            workspaceState.state === "ready";

        if (
            workspaceState.state === "missing" ||
            workspaceState.state === "partial"
        ) {
            addAction(
                "create-managed-workspace",
                workspaceState.state === "partial"
                    ? "Complete managed workspace"
                    : "Create managed workspace",
                "Create only the installer-owned directories under LocalAppData."
            );

            willHaveWorkspace = true;
        } else if (
            workspaceState.state !== "ready"
        ) {
            addBlocker(
                "workspace-state",
                workspaceState.reason ??
                `Managed workspace state is "${workspaceState.state}".`
            );
        }

        let managedNodeWillChange = false;

        if (
            blockers.length === 0 &&
            willHaveWorkspace
        ) {
            const managedPaths =
                getManagedPaths();

            const managedNodePath =
                managedPaths?.toolchain
                    ? join(
                        managedPaths.toolchain,
                        "node"
                    )
                    : null;

            const resolvedNode =
                environment.resolvedTools?.node ??
                null;

            const exactResolvedManagedNode =
                resolvedNode?.available === true &&
                resolvedNode?.source === "managed" &&
                resolvedNode?.version ===
                `v${MANAGED_NODE_VERSION}`;

            let portableNodeState = {
                available: false,
                reason:
                    "Portable Managed Node provenance is not available."
            };

            if (
                managedNodePath &&
                existsSync(
                    managedNodePath
                )
            ) {
                portableNodeState =
                    readManagedNodeRuntimeManifest(
                        managedNodePath
                    );
            }

            const exactVerifiedPortableNode =
                Boolean(
                    exactResolvedManagedNode &&
                    portableNodeState?.available === true &&
                    normalize(
                        resolvedNode.command
                    ).toLowerCase() ===
                    normalize(
                        portableNodeState.nodePath
                    ).toLowerCase()
                );

            const developmentSeedReady =
                Boolean(
                    !app.isPackaged &&
                    exactResolvedManagedNode &&
                    portableNodeState?.available !== true
                );

            if (
                !exactVerifiedPortableNode &&
                !developmentSeedReady
            ) {
                if (
                    managedNodePath &&
                    existsSync(
                        managedNodePath
                    )
                ) {
                    addBlocker(
                        "managed-node-path-occupied",
                        `Managed Node path exists at ${managedNodePath}, but it is not a verified portable Node v${MANAGED_NODE_VERSION} runtime. Automatic setup will not overwrite it.`
                    );
                } else {
                    addAction(
                        "prepare-managed-node-runtime",
                        `Prepare portable Node v${MANAGED_NODE_VERSION}`,
                        "Download the pinned official Node.js Windows runtime, verify it against the official SHASUMS256.txt, validate node.exe, and safely promote it into the managed toolchain."
                    );

                    managedNodeWillChange = true;
                }
            }
        }

        let willHaveRepository =
            vencordState.state === "repository";

        let repositoryWillChange = false;

        if (
            blockers.length === 0 &&
            willHaveWorkspace
        ) {
            if (
                vencordState.state === "missing"
            ) {
                addAction(
                    "prepare-managed-vencord-source",
                    "Prepare managed Vencord source",
                    "Resolve the trusted Vencord main branch to an exact GitHub commit, download and validate its source archive, then safely promote it into the isolated managed workspace."
                );

                willHaveRepository = true;
                repositoryWillChange = true;
            } else if (
                vencordState.state === "empty"
            ) {
                addBlocker(
                    "legacy-empty-vencord-folder",
                    "Managed Vencord folder exists but is empty. Automatic archive setup will not remove even an empty destination automatically."
                );
            } else if (
                vencordState.state === "occupied"
            ) {
                addBlocker(
                    "vencord-folder-occupied",
                    "Managed Vencord folder contains unexpected files. Automatic setup will not overwrite it."
                );
            } else if (
                vencordState.state !== "repository"
            ) {
                addBlocker(
                    "vencord-state",
                    vencordState.reason ??
                    `Managed Vencord state is "${vencordState.state}".`
                );
            }
        }

        if (blockers.length === 0 && !repositoryWillChange && willHaveRepository && (!checks.customizations.ready || !checks.vencord.ready)) {
            addAction("repair-managed-source", "Prepare compatible source customizations", "Prepare the installed commit with checked customizations in staging, preserve local files, then activate a verified build with rollback.");
        }

        let willHaveUserPlugins =
            userPluginsState.state === "ready";

        if (
            blockers.length === 0 &&
            willHaveRepository
        ) {
            if (
                repositoryWillChange ||
                userPluginsState.state === "missing" ||
                userPluginsState.state === "unavailable"
            ) {
                addAction(
                    "ensure-managed-userplugins",
                    "Create userplugins folder",
                    "Ensure src\\userplugins exists inside the managed Vencord repository."
                );

                willHaveUserPlugins = true;
            } else if (
                userPluginsState.state !== "ready"
            ) {
                addBlocker(
                    "userplugins-state",
                    userPluginsState.reason ??
                    `Managed userplugins state is "${userPluginsState.state}".`
                );
            }
        }

        let pluginsWillChange = false;

        if (
            blockers.length === 0 &&
            willHaveUserPlugins
        ) {
            const pluginInstallNeeded =
                repositoryWillChange ||
                installedPluginsState.state === "missing" ||
                installedPluginsState.state === "unavailable";

            if (pluginInstallNeeded) {
                if (
                    bundledPluginsState.complete !== true
                ) {
                    addBlocker(
                        "bundled-payload",
                        "Bundled plugin payload is incomplete. Automatic installation cannot continue."
                    );
                } else {
                    addAction(
                        "install-bundled-plugins",
                        "Install bundled plugins",
                        "Copy the bundled Maru plugins into the managed Vencord userplugins folder without overwriting existing plugin folders."
                    );

                    pluginsWillChange = true;
                }
            } else if (
                installedPluginsState.state === "partial"
            ) {
                addBlocker(
                    "partial-plugin-install",
                    installedPluginsState.reason ?? "Managed Maru plug-ins need updating. Use Update Maru Plug-ins, then continue setup."
                );
            } else if (
                installedPluginsState.state !== "installed"
            ) {
                addBlocker(
                    "installed-plugins-state",
                    installedPluginsState.reason ??
                    `Managed plugin state is "${installedPluginsState.state}".`
                );
            }
        }

        let managedPnpmWillChange = false;

        if (
            blockers.length === 0 &&
            willHaveRepository &&
            !managedNodeWillChange
        ) {
            // When the repository is being created during this plan,
            // package.json does not exist yet. The coordinator executes
            // only the first action and replans after every successful
            // step, so exact pnpm preparation is intentionally deferred
            // until the next plan when Vencord's packageManager can be
            // read and verified.
            if (!repositoryWillChange) {
                const packageManagerRequirement =
                    getManagedPackageManagerRequirement();

                if (
                    packageManagerRequirement?.available !== true ||
                    typeof packageManagerRequirement?.packageManager !==
                    "string"
                ) {
                    addBlocker(
                        "package-manager-requirement",
                        packageManagerRequirement?.reason ??
                        "Managed Vencord package-manager requirement is unavailable."
                    );
                } else {
                    const requirementMatch =
                        packageManagerRequirement.packageManager.match(
                            /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
                        );

                    if (!requirementMatch) {
                        addBlocker(
                            "unsupported-package-manager-requirement",
                            `Unsupported managed Vencord package-manager requirement: "${packageManagerRequirement.packageManager}".`
                        );
                    } else {
                        const requiredPnpmVersion =
                            requirementMatch[1];

                        const resolvedPnpm =
                            environment.resolvedTools?.pnpm ??
                            null;

                        const exactManagedPnpmReady =
                            resolvedPnpm?.available === true &&
                            resolvedPnpm?.source === "managed" &&
                            resolvedPnpm?.version ===
                            requiredPnpmVersion;

                        if (!exactManagedPnpmReady) {
                            const managedPaths =
                                getManagedPaths();

                            const managedPnpmPath =
                                managedPaths?.toolchain
                                    ? join(
                                        managedPaths.toolchain,
                                        "pnpm"
                                    )
                                    : null;

                            addAction(
                                "prepare-managed-pnpm-runtime",
                                `Prepare managed pnpm ${requiredPnpmVersion}`,
                                "Prepare and integrity-verify the exact required managed pnpm version without overwriting any existing runtime."
                            );
                            managedPnpmWillChange = true;
                        }
                    }
                }
            }
        }

        let dependenciesWillChange = false;

        if (
            blockers.length === 0 &&
            willHaveRepository &&
            !managedNodeWillChange &&
            !managedPnpmWillChange
        ) {
            const dependencyInstallNeeded =
                repositoryWillChange ||
                dependencyState.state === "missing" ||
                dependencyState.state === "mismatch" ||
                dependencyState.state === "unavailable";

            if (dependencyInstallNeeded) {
                addAction(
                    "install-managed-plugin-dependencies",
                    "Install plugin dependencies",
                    "Install the required socket.io-client dependency inside the managed Vencord repository."
                );

                dependenciesWillChange = true;
            } else if (
                dependencyState.state !== "installed"
            ) {
                addBlocker(
                    "dependency-state",
                    dependencyState.reason ??
                    `Managed plugin dependency state is "${dependencyState.state}".`
                );
            }
        }

        if (
            blockers.length === 0 &&
            willHaveRepository &&
            !managedNodeWillChange &&
            !managedPnpmWillChange
        ) {
            const buildNeeded =
                repositoryWillChange ||
                pluginsWillChange ||
                dependenciesWillChange ||
                buildState.state === "missing" ||
                buildState.state === "partial" ||
                buildState.state === "unavailable";

            if (buildNeeded) {
                addAction(
                    "build-managed-vencord",
                    "Build managed Vencord",
                    "Build the isolated managed Vencord repository after all source, plugin, and dependency changes are complete."
                );
            } else if (
                buildState.state !== "built"
            ) {
                addBlocker(
                    "build-state",
                    buildState.reason ??
                    `Managed Vencord build state is "${buildState.state}".`
                );
            }
        }

        if (
            blockers.length === 0 &&
            !setupOnly &&
            discord &&
            !managedNodeWillChange &&
            !managedPnpmWillChange
        ) {
            if (isExternalVencord) {
                addAction(
                    "migrate-external-vencord",
                    `Replace existing Vencord with managed Vencord on Discord ${discord.name}`,
                    "Use the verified migration backup as a hard safety gate, then replace the existing Vencord patch through Vencord's supported installer flow."
                );
            } else {
                addAction(
                    "install-managed-vencord",
                    `Install managed Vencord to Discord ${discord.name}`,
                    "Use Vencord's supported installer flow to patch only the selected Discord installation."
                );
            }
        }
    }

    const nextPlannedAction =
        actions[0] ??
        null;

    const requiredTools =
        new Set();

    // The coordinator executes ONLY nextPlannedAction and then replans.
    // Never reject the current plan because a later action needs a tool
    // that an earlier action is specifically responsible for preparing.
    switch (
    nextPlannedAction?.id
    ) {
        case "prepare-managed-pnpm-runtime":
            requiredTools.add(
                "node"
            );
            break;

        case "install-managed-plugin-dependencies":
        case "build-managed-vencord":
            requiredTools.add(
                "node"
            );
            requiredTools.add(
                "packageManager"
            );
            break;

        case "install-managed-vencord":
        case "migrate-external-vencord":
            requiredTools.add(
                "node"
            );
            break;

        // These actions intentionally require no external build tool:
        // create-managed-workspace, prepare-managed-node-runtime,
        // prepare-managed-vencord-source, ensure-managed-userplugins,
        // install-bundled-plugins, backup-external-vencord-user-data.
        default:
            break;
    }

    const missingTools =
        [...requiredTools].filter(
            tool =>
                tool === "packageManager"
                    ? !environment.packageManagerAvailable
                    : !environment[tool]
        );

    if (missingTools.length > 0) {
        addBlocker(
            "missing-build-tools",
            `Required build tools are unavailable for next action "${nextPlannedAction?.id ?? "none"}": ${missingTools.join(", ")}.`
        );
    }

    const status =
        blockers.length > 0
            ? "blocked"
            : setupOnly
                ? actions.length === 0 &&
                    isManagedBuildReady(
                        buildState
                    )
                    ? "setup-complete"
                    : "setup-required"
                : alreadyManaged
                    ? managedPrerequisitesReady ? "complete" : "setup-required"
                    : isExternalVencord
                        ? "migration-required"
                        : actions.length === 1 &&
                            actions[0].id === "install-managed-vencord"
                            ? "ready-to-install"
                            : "setup-required";

    return {
        readOnly: true,
        setupOnly,
        target:
            setupOnly
                ? {
                    name:
                        plannerTargetName,
                    path: null,
                    synthetic: true
                }
                : discord
                    ? {
                        name: discord.name,
                        path: discord.path
                    }
                    : {
                        name:
                            requestedName || null,
                        path: null
                    },
        status,
        toolGate: {
            actionId:
                nextPlannedAction?.id ??
                null,
            requiredTools:
                [...requiredTools],
            missingTools:
                [...missingTools]
        },
        alreadyManaged,
        migrationRequired:
            isExternalVencord &&
            blockers.length === 0,
        migrationBackupReady:
            isExternalVencord &&
            migrationBackupReady,
        installRequired:
            !setupOnly &&
            !alreadyManaged &&
            blockers.length === 0,
        readyForInstall:
            !setupOnly &&
            status === "ready-to-install",
        checks,
        actions,
        blockers,
        nextAction:
            blockers.length === 0
                ? actions[0] ?? null
                : null
    };
}


const activeIsolatedFreshInstallTests =
    new Set();


function summarizeFreshInstallTestStep(
    id,
    result
) {
    const summary = {
        id,
        ok:
            result?.ok !== false
    };

    const fields = [
        "state",
        "version",
        "architecture",
        "source",
        "sourceType",
        "path",
        "target",
        "command",
        "commit",
        "dependency",
        "packageManager",
        "packageManagerSource",
        "archiveBytes",
        "archiveSha256",
        "officialArchiveSha256",
        "nodeExeSha256",
        "alreadyPrepared",
        "reason"
    ];

    for (const field of fields) {
        if (
            result?.[field] !== undefined
        ) {
            summary[field] =
                result[field];
        }
    }

    return summary;
}


async function runIsolatedFreshInstallBuildTest() {
    const defaultRoot =
        getDefaultManagedWorkspaceRoot();

    if (!defaultRoot) {
        throw new Error(
            "LOCALAPPDATA is unavailable."
        );
    }

    let testRoot =
        null;

    for (
        let index = 1;
        index <= 25;
        index += 1
    ) {
        const name =
            index === 1
                ? "fresh-install-test"
                : `fresh-install-test-${index}`;

        const candidate =
            join(
                defaultRoot,
                name
            );

        const candidateKey =
            normalize(
                candidate
            ).toLowerCase();

        if (
            !existsSync(
                candidate
            ) &&
            !activeIsolatedFreshInstallTests.has(
                candidateKey
            )
        ) {
            testRoot =
                candidate;

            break;
        }
    }

    if (!testRoot) {
        throw new Error(
            "No unused isolated fresh-install test root is available. Existing test roots were left untouched."
        );
    }

    const testKey =
        normalize(
            testRoot
        ).toLowerCase();

    if (
        activeIsolatedFreshInstallTests.has(
            testKey
        )
    ) {
        throw new Error(
            "Selected isolated fresh-install build test root is already running."
        );
    }

    const productionPaths =
        getManagedPaths();

    if (!productionPaths) {
        throw new Error(
            "Production managed workspace is unavailable."
        );
    }

    const productionRoot =
        resolve(
            productionPaths.root
        );

    const productionToolchain =
        resolve(
            productionPaths.toolchain
        );

    const productionVencord =
        resolve(
            productionPaths.vencord
        );

    if (
        isPathInsideOrSame(
            testRoot,
            productionToolchain
        ) ||
        isPathInsideOrSame(
            testRoot,
            productionVencord
        ) ||
        normalize(
            testRoot
        ).toLowerCase() ===
        normalize(
            productionRoot
        ).toLowerCase()
    ) {
        throw new Error(
            "Refusing fresh-install test: isolated root overlaps production managed paths."
        );
    }

    activeIsolatedFreshInstallTests.add(
        testKey
    );

    try {
        return await runWithManagedWorkspaceContext(
            {
                root:
                    testRoot,
                purpose:
                    "fresh-install-test"
            },
            async () => {
                const scopedPaths =
                    getManagedPaths();

                if (
                    !scopedPaths ||
                    normalize(
                        scopedPaths.root
                    ).toLowerCase() !==
                    normalize(
                        testRoot
                    ).toLowerCase()
                ) {
                    throw new Error(
                        "Isolated fresh-install context did not resolve to the expected test root."
                    );
                }

                const steps = [];

                const runStep =
                    async (
                        id,
                        callback,
                        verify
                    ) => {
                        const result =
                            await callback();

                        if (
                            typeof verify ===
                            "function"
                        ) {
                            await verify(
                                result
                            );
                        }

                        steps.push(
                            summarizeFreshInstallTestStep(
                                id,
                                result
                            )
                        );

                        return result;
                    };

                await runStep(
                    "create-managed-workspace",
                    async () =>
                        createManagedWorkspace(),
                    async () => {
                        const state =
                            getManagedWorkspaceState();

                        if (
                            state.state !==
                            "ready"
                        ) {
                            throw new Error(
                                `Fresh-test workspace verification returned "${state.state}".`
                            );
                        }

                        if (
                            existsSync(
                                scopedPaths.vencord
                            )
                        ) {
                            throw new Error(
                                "Fresh-test workspace unexpectedly pre-created the Vencord source destination."
                            );
                        }
                    }
                );

                await runStep(
                    "prepare-managed-node-runtime",
                    async () =>
                        prepareManagedNodeRuntime(),
                    async result => {
                        if (
                            result?.ok !== true ||
                            result?.state !==
                            "ready" ||
                            result?.source !==
                            "managed"
                        ) {
                            throw new Error(
                                "Fresh-test portable Node did not become the scoped managed runtime."
                            );
                        }

                        const manifest =
                            readManagedNodeRuntimeManifest(
                                scopedPaths.toolchain
                                    ? join(
                                        scopedPaths.toolchain,
                                        "node"
                                    )
                                    : ""
                            );

                        if (
                            manifest?.available !==
                            true
                        ) {
                            throw new Error(
                                manifest?.reason ??
                                "Fresh-test portable Node provenance verification failed."
                            );
                        }
                    }
                );

                await runStep(
                    "prepare-managed-vencord-source",
                    async () =>
                        prepareManagedVencordSourceFromArchive(),
                    async result => {
                        if (
                            result?.ok !== true ||
                            result?.state !==
                            "repository" ||
                            result?.sourceType !==
                            "archive"
                        ) {
                            throw new Error(
                                "Fresh-test Vencord source was not verified as an archive-managed repository."
                            );
                        }

                        const state =
                            getManagedVencordState();

                        if (
                            state.state !==
                            "repository" ||
                            state.sourceType !==
                            "archive"
                        ) {
                            throw new Error(
                                "Fresh-test Vencord source state verification failed after promotion."
                            );
                        }
                    }
                );

                await runStep(
                    "prepare-managed-pnpm-runtime",
                    async () =>
                        prepareManagedPnpmRuntime(),
                    async result => {
                        if (
                            result?.ok !== true ||
                            result?.state !==
                            "ready" ||
                            result?.source !==
                            "managed"
                        ) {
                            throw new Error(
                                "Fresh-test pnpm did not become the scoped managed runtime."
                            );
                        }

                        const verification =
                            await verifyManagedPackageManager();

                        if (
                            verification?.ok !==
                            true ||
                            verification?.runner?.source !==
                            "managed"
                        ) {
                            throw new Error(
                                "Fresh-test exact managed pnpm verification failed."
                            );
                        }
                    }
                );

                await runStep(
                    "ensure-managed-userplugins",
                    async () =>
                        ensureManagedUserPluginsDirectory(),
                    async () => {
                        const state =
                            getManagedUserPluginsState();

                        if (
                            state.state !==
                            "ready"
                        ) {
                            throw new Error(
                                `Fresh-test userplugins verification returned "${state.state}".`
                            );
                        }
                    }
                );

                await runStep(
                    "install-bundled-plugins",
                    async () =>
                        installBundledPlugins(),
                    async () => {
                        const state =
                            getManagedInstalledPluginsState();

                        if (
                            state.state !==
                            "installed" ||
                            state.complete !==
                            true
                        ) {
                            throw new Error(
                                "Fresh-test bundled plugin verification failed."
                            );
                        }
                    }
                );

                await runStep(
                    "install-managed-plugin-dependencies",
                    async () =>
                        installManagedPluginDependencies(),
                    async () => {
                        const state =
                            getManagedPluginDependenciesState();

                        if (
                            state.state !==
                            "installed"
                        ) {
                            throw new Error(
                                `Fresh-test plugin dependency verification returned "${state.state}".`
                            );
                        }
                    }
                );

                await runStep(
                    "build-managed-vencord",
                    async () =>
                        buildManagedVencord(),
                    async () => {
                        const state =
                            getManagedBuildState();

                        if (
                            !isManagedBuildReady(
                                state
                            )
                        ) {
                            throw new Error(
                                `Fresh-test Vencord build verification returned state="${state.state}" complete=${state.complete ?? false}.`
                            );
                        }
                    }
                );

                const finalEnvironment =
                    await detectBuildEnvironment();

                const finalNode =
                    finalEnvironment
                        ?.resolvedTools
                        ?.node;

                const finalPnpm =
                    finalEnvironment
                        ?.resolvedTools
                        ?.pnpm;

                if (
                    finalNode?.source !==
                    "managed" ||
                    finalNode?.version !==
                    `v${MANAGED_NODE_VERSION}`
                ) {
                    throw new Error(
                        "Fresh-test final environment did not retain exact Managed Node."
                    );
                }

                const packageManagerRequirement =
                    getManagedPackageManagerRequirement();

                const requiredPnpmVersion =
                    typeof packageManagerRequirement?.packageManager ===
                        "string"
                        ? packageManagerRequirement.packageManager.replace(
                            /^pnpm@/,
                            ""
                        )
                        : null;

                if (
                    finalPnpm?.source !==
                    "managed" ||
                    !requiredPnpmVersion ||
                    finalPnpm?.version !==
                    requiredPnpmVersion
                ) {
                    throw new Error(
                        "Fresh-test final environment did not retain the exact Managed pnpm required by Vencord."
                    );
                }

                const result = {
                    ok: true,
                    state:
                        "build-complete",
                    testOnly: true,
                    stoppedBeforeDiscordPatch:
                        true,
                    isolatedRoot:
                        scopedPaths.root,
                    productionRoot,
                    productionToolchain,
                    productionVencord,
                    productionManagedPathsUntouched:
                        true,
                    steps,
                    final: {
                        workspace:
                            getManagedWorkspaceState(),
                        vencord:
                            getManagedVencordState(),
                        plugins:
                            getManagedInstalledPluginsState(),
                        dependencies:
                            getManagedPluginDependenciesState(),
                        build:
                            getManagedBuildState(),
                        node: {
                            source:
                                finalNode.source,
                            version:
                                finalNode.version,
                            command:
                                finalNode.command
                        },
                        pnpm: {
                            source:
                                finalPnpm.source,
                            version:
                                finalPnpm.version,
                            command:
                                finalPnpm.command,
                            requiredVersion:
                                requiredPnpmVersion
                        }
                    },
                    reason:
                        "Isolated fresh-install setup completed through a verified Vencord build and intentionally stopped before any Discord patch/install action."
                };

                const manifestPath =
                    join(
                        scopedPaths.root,
                        "fresh-install-test-manifest.json"
                    );

                writeFileSync(
                    manifestPath,
                    JSON.stringify(
                        {
                            completedAt:
                                new Date()
                                    .toISOString(),
                            ...result
                        },
                        null,
                        2
                    ),
                    "utf8"
                );

                return {
                    ...result,
                    manifestPath
                };
            }
        );
    } finally {
        activeIsolatedFreshInstallTests.delete(
            testKey
        );
    }
}


const activeIsolatedSetupCoordinatorTests =
    new Set();

const ISOLATED_SETUP_COORDINATOR_ALLOWED_ACTIONS =
    new Set([
        "create-managed-workspace",
        "prepare-managed-node-runtime",
        "prepare-managed-vencord-source",
        "ensure-managed-userplugins",
        "install-bundled-plugins",
        "prepare-managed-pnpm-runtime",
        "install-managed-plugin-dependencies",
        "build-managed-vencord"
    ]);


function chooseUnusedIsolatedCoordinatorRoot(
    defaultRoot
) {
    for (
        let index = 1;
        index <= 25;
        index += 1
    ) {
        const name =
            index === 1
                ? "fresh-coordinator-test"
                : `fresh-coordinator-test-${index}`;

        const candidate =
            join(
                defaultRoot,
                name
            );

        const candidateKey =
            normalize(
                candidate
            ).toLowerCase();

        if (
            !existsSync(
                candidate
            ) &&
            !activeIsolatedSetupCoordinatorTests.has(
                candidateKey
            )
        ) {
            return candidate;
        }
    }

    throw new Error(
        "No unused isolated setup-coordinator test root is available. Existing test roots were left untouched."
    );
}


async function runIsolatedSetupCoordinatorTest() {
    const defaultRoot =
        getDefaultManagedWorkspaceRoot();

    if (!defaultRoot) {
        throw new Error(
            "LOCALAPPDATA is unavailable."
        );
    }

    const testRoot =
        chooseUnusedIsolatedCoordinatorRoot(
            defaultRoot
        );

    const testKey =
        normalize(
            testRoot
        ).toLowerCase();

    const productionPaths =
        getManagedPaths();

    if (!productionPaths) {
        throw new Error(
            "Production managed workspace is unavailable."
        );
    }

    if (
        normalize(
            testRoot
        ).toLowerCase() ===
        normalize(
            productionPaths.root
        ).toLowerCase() ||
        isPathInsideOrSame(
            testRoot,
            productionPaths.toolchain
        ) ||
        isPathInsideOrSame(
            testRoot,
            productionPaths.vencord
        )
    ) {
        throw new Error(
            "Refusing isolated setup-coordinator test: test root overlaps production managed paths."
        );
    }

    activeIsolatedSetupCoordinatorTests.add(
        testKey
    );

    try {
        const toolAudit = {
            blockedGlobalFallbacks: [],
            managedSelections: [],
            strictPaths: []
        };

        return await runWithManagedWorkspaceContext(
            {
                root:
                    testRoot,
                purpose:
                    "setup-coordinator-test",
                strictManagedTools:
                    true,
                toolAudit
            },
            async () => {
                const targetName =
                    "Isolated Setup Coordinator";

                const scopedPaths =
                    getManagedPaths();

                if (
                    !scopedPaths ||
                    normalize(
                        scopedPaths.root
                    ).toLowerCase() !==
                    normalize(
                        testRoot
                    ).toLowerCase()
                ) {
                    throw new Error(
                        "Isolated setup-coordinator context did not resolve to the expected test root."
                    );
                }

                let plan =
                    await getManagedInstallPlan(
                        targetName,
                        {
                            setupOnly: true
                        }
                    );

                if (
                    plan?.setupOnly !== true ||
                    plan?.target?.synthetic !==
                    true ||
                    plan?.target?.name !==
                    targetName
                ) {
                    throw new Error(
                        "Setup-only planner did not return the expected synthetic test target."
                    );
                }

                const initialPlan = plan;
                const steps = [];
                const planHistory = [];
                const maxSteps = 12;

                const recordPlan =
                    currentPlan => {
                        planHistory.push({
                            status:
                                currentPlan?.status ??
                                null,
                            nextAction:
                                currentPlan
                                    ?.nextAction
                                    ?.id ??
                                null,
                            actions:
                                Array.isArray(
                                    currentPlan?.actions
                                )
                                    ? currentPlan.actions.map(
                                        action =>
                                            action.id
                                    )
                                    : [],
                            blockers:
                                Array.isArray(
                                    currentPlan?.blockers
                                )
                                    ? currentPlan.blockers.map(
                                        blocker =>
                                            blocker.id
                                    )
                                    : [],
                            toolGate:
                                currentPlan?.toolGate
                                    ? {
                                        actionId:
                                            currentPlan
                                                .toolGate
                                                .actionId ??
                                            null,
                                        requiredTools:
                                            currentPlan
                                                .toolGate
                                                .requiredTools ??
                                            [],
                                        missingTools:
                                            currentPlan
                                                .toolGate
                                                .missingTools ??
                                            []
                                    }
                                    : null
                        });
                    };

                recordPlan(
                    plan
                );

                for (
                    let stepNumber = 1;
                    stepNumber <= maxSteps;
                    stepNumber += 1
                ) {
                    if (
                        plan?.setupOnly !== true ||
                        plan?.target?.synthetic !==
                        true ||
                        plan?.target?.name !==
                        targetName
                    ) {
                        throw new Error(
                            "Isolated setup coordinator stopped because the setup-only planner target changed."
                        );
                    }

                    if (
                        plan.status === "blocked"
                    ) {
                        const blockers =
                            Array.isArray(
                                plan.blockers
                            )
                                ? plan.blockers
                                    .map(blocker =>
                                        blocker.message ??
                                        blocker.id
                                    )
                                    .filter(Boolean)
                                : [];

                        throw new Error(
                            blockers.length > 0
                                ? `Isolated setup coordinator became blocked: ${blockers.join("; ")}`
                                : "Isolated setup coordinator became blocked."
                        );
                    }

                    if (
                        plan.status ===
                        "setup-complete"
                    ) {
                        const buildState =
                            getManagedBuildState();

                        if (
                            !isManagedBuildReady(
                                buildState
                            )
                        ) {
                            throw new Error(
                                `Setup-only planner reported completion, but build state is "${buildState.state}" complete=${buildState.complete ?? false}.`
                            );
                        }

                        const finalEnvironment =
                            await detectBuildEnvironment();

                        const finalNode =
                            finalEnvironment
                                ?.resolvedTools
                                ?.node;

                        const finalPnpm =
                            finalEnvironment
                                ?.resolvedTools
                                ?.pnpm;

                        const requirement =
                            getManagedPackageManagerRequirement();

                        const requiredPnpmVersion =
                            typeof requirement
                                ?.packageManager ===
                                "string"
                                ? requirement
                                    .packageManager
                                    .replace(
                                        /^pnpm@/,
                                        ""
                                    )
                                : null;

                        if (
                            finalNode?.source !==
                            "managed" ||
                            finalNode?.version !==
                            `v${MANAGED_NODE_VERSION}`
                        ) {
                            throw new Error(
                                "Isolated setup coordinator final environment did not retain exact Managed Node."
                            );
                        }

                        if (
                            finalPnpm?.source !==
                            "managed" ||
                            !requiredPnpmVersion ||
                            finalPnpm?.version !==
                            requiredPnpmVersion
                        ) {
                            throw new Error(
                                "Isolated setup coordinator final environment did not retain exact Managed pnpm."
                            );
                        }

                        const finalGit =
                            finalEnvironment
                                ?.resolvedTools
                                ?.git;

                        const finalCorepack =
                            finalEnvironment
                                ?.resolvedTools
                                ?.corepack;

                        if (
                            finalGit?.available !==
                            false ||
                            finalGit?.source !==
                            "unavailable"
                        ) {
                            throw new Error(
                                "Strict managed-only proof failed: Git was not fully unavailable to the isolated coordinator."
                            );
                        }

                        if (
                            finalCorepack?.available !==
                            false ||
                            finalCorepack?.source !==
                            "unavailable"
                        ) {
                            throw new Error(
                                "Strict managed-only proof failed: Corepack was not fully unavailable to the isolated coordinator."
                            );
                        }

                        const blockedTools =
                            new Set(
                                (
                                    toolAudit
                                        .blockedGlobalFallbacks ??
                                    []
                                ).map(
                                    entry =>
                                        entry.tool
                                )
                            );

                        for (
                            const toolName of
                            [
                                "git",
                                "corepack"
                            ]
                        ) {
                            if (
                                !blockedTools.has(
                                    toolName
                                )
                            ) {
                                throw new Error(
                                    `Strict managed-only proof did not record blocked global fallback for ${toolName}.`
                                );
                            }
                        }

                        const result = {
                            ok: true,
                            state:
                                "setup-complete",
                            testOnly: true,
                            plannerDriven: true,
                            actionExecutorDriven:
                                true,
                            replannedAfterEveryAction:
                                true,
                            strictManagedTools:
                                true,
                            globalFallbackAllowed:
                                false,
                            globalPathInherited:
                                false,
                            stoppedBeforeDiscordLifecycle:
                                true,
                            productionManagedPathsUntouched:
                                true,
                            toolAudit,
                            isolatedRoot:
                                scopedPaths.root,
                            productionRoot:
                                productionPaths.root,
                            steps,
                            planHistory,
                            initialPlan,
                            finalPlan:
                                plan,
                            final: {
                                workspace:
                                    getManagedWorkspaceState(),
                                vencord:
                                    getManagedVencordState(),
                                plugins:
                                    getManagedInstalledPluginsState(),
                                dependencies:
                                    getManagedPluginDependenciesState(),
                                build:
                                    buildState,
                                node: {
                                    source:
                                        finalNode.source,
                                    version:
                                        finalNode.version,
                                    command:
                                        finalNode.command
                                },
                                pnpm: {
                                    source:
                                        finalPnpm.source,
                                    version:
                                        finalPnpm.version,
                                    command:
                                        finalPnpm.command,
                                    requiredVersion:
                                        requiredPnpmVersion
                                },
                                git: {
                                    source:
                                        finalGit.source,
                                    available:
                                        finalGit.available
                                },
                                corepack: {
                                    source:
                                        finalCorepack.source,
                                    available:
                                        finalCorepack.available
                                }
                            },
                            reason:
                                "The real install planner and action executor completed the isolated setup in strict managed-only mode: Managed Node and pnpm were used, global build-tool fallback and inherited global PATH were disabled, Git/Corepack remained unavailable, and execution stopped before all Discord lifecycle actions."
                        };

                        const manifestPath =
                            join(
                                scopedPaths.root,
                                "setup-coordinator-test-manifest.json"
                            );

                        writeFileSync(
                            manifestPath,
                            JSON.stringify(
                                {
                                    completedAt:
                                        new Date()
                                            .toISOString(),
                                    ...result
                                },
                                null,
                                2
                            ),
                            "utf8"
                        );

                        return {
                            ...result,
                            manifestPath
                        };
                    }

                    const action =
                        plan.nextAction;

                    if (
                        !action ||
                        typeof action.id !==
                        "string"
                    ) {
                        throw new Error(
                            `Isolated setup coordinator stopped because planner status "${plan.status}" has no executable next action.`
                        );
                    }

                    if (
                        !ISOLATED_SETUP_COORDINATOR_ALLOWED_ACTIONS.has(
                            action.id
                        )
                    ) {
                        throw new Error(
                            `Hard stop before Discord lifecycle: setup-only planner requested forbidden action "${action.id}".`
                        );
                    }

                    const startedAt =
                        new Date()
                            .toISOString();

                    let actionResult;

                    try {
                        actionResult =
                            await executeManagedInstallPlanAction(
                                action.id,
                                null
                            );
                    } catch (error) {
                        const failure = {
                            step:
                                stepNumber,
                            actionId:
                                action.id,
                            label:
                                action.label ??
                                action.id,
                            startedAt,
                            finishedAt:
                                new Date()
                                    .toISOString(),
                            ok: false,
                            error:
                                error?.message ??
                                "Unknown isolated setup coordinator error."
                        };

                        steps.push(
                            failure
                        );

                        const wrapped =
                            new Error(
                                `Isolated setup coordinator failed during "${failure.label}": ${failure.error}`
                            );

                        wrapped.coordinator = {
                            ok: false,
                            state: "failed",
                            testOnly: true,
                            strictManagedTools:
                                true,
                            globalFallbackAllowed:
                                false,
                            globalPathInherited:
                                false,
                            stoppedBeforeDiscordLifecycle:
                                true,
                            toolAudit,
                            isolatedRoot:
                                scopedPaths.root,
                            steps,
                            finalPlan:
                                plan
                        };

                        throw wrapped;
                    }

                    const step = {
                        step:
                            stepNumber,
                        actionId:
                            action.id,
                        label:
                            action.label ??
                            action.id,
                        startedAt,
                        finishedAt:
                            new Date()
                                .toISOString(),
                        ok: true,
                        result:
                            summarizeCoordinatorActionResult(
                                action.id,
                                actionResult
                            )
                    };

                    steps.push(
                        step
                    );

                    const nextPlan =
                        await getManagedInstallPlan(
                            targetName,
                            {
                                setupOnly: true
                            }
                        );

                    if (
                        nextPlan?.setupOnly !==
                        true ||
                        nextPlan?.target?.synthetic !==
                        true ||
                        nextPlan?.target?.name !==
                        targetName
                    ) {
                        throw new Error(
                            `Isolated setup coordinator stopped after "${step.label}" because the setup-only planner target changed during re-validation.`
                        );
                    }

                    if (
                        nextPlan.status !==
                        "setup-complete" &&
                        nextPlan.nextAction?.id ===
                        action.id
                    ) {
                        throw new Error(
                            `Isolated setup coordinator stopped after "${step.label}" because re-validation still requests the same action. Refusing to loop or repeat it automatically.`
                        );
                    }

                    plan =
                        nextPlan;

                    recordPlan(
                        plan
                    );
                }

                throw new Error(
                    `Isolated setup coordinator exceeded its ${maxSteps}-step safety limit and was stopped.`
                );
            }
        );
    } finally {
        activeIsolatedSetupCoordinatorTests.delete(
            testKey
        );
    }
}


const activeManagedInstallCoordinators =
    new Set();


function summarizeCoordinatorActionResult(
    actionId,
    result
) {
    if (!result || typeof result !== "object") {
        return {
            actionId,
            ok: true
        };
    }

    const summary = {
        actionId,
        ok:
            result.ok !== false &&
            result.success !== false
    };

    const copyIfPresent = key => {
        if (
            Object.prototype.hasOwnProperty.call(
                result,
                key
            )
        ) {
            summary[key] =
                result[key];
        }
    };

    for (const key of [
        "state",
        "path",
        "dependency",
        "packageManager",
        "requiredVersion",
        "version",
        "source",
        "command",
        "runtimeKind",
        "alreadyPrepared",
        "architecture",
        "target",
        "manifestPath",
        "archiveBytes",
        "archiveSha256",
        "officialArchiveSha256",
        "nodeExeSha256",
        "bundledPackageManagers",
        "name",
        "location",
        "managedPatcherPath",
        "verifiedPatcherPath",
        "userDataPreserved",
        "backupDirectory",
        "manifestPath",
        "fileCount",
        "totalBytes",
        "reason"
    ]) {
        copyIfPresent(key);
    }

    if (
        result.backup &&
        typeof result.backup === "object"
    ) {
        summary.backup = {
            state:
                result.backup.state ?? null,
            verified:
                result.backup.verified === true,
            backupRequired:
                result.backup.backupRequired !== false,
            backupDirectory:
                result.backup.backupDirectory ?? null,
            manifestPath:
                result.backup.manifestPath ?? null,
            fileCount:
                result.backup.fileCount ?? 0,
            totalBytes:
                result.backup.totalBytes ?? 0
        };
    }

    return summary;
}


async function executeManagedInstallPlanAction(
    actionId,
    discordName
) {
    switch (actionId) {
        case "repair-managed-vencord":
            return repairManagedVencord(discordName);

        case "repair-managed-source":
            return repairManagedSource();

        case "create-managed-workspace":
            return createManagedWorkspace();

        case "prepare-managed-node-runtime":
            return prepareManagedNodeRuntime();

        case "prepare-managed-vencord-source":
            return prepareManagedVencordSourceFromArchive();

        case "prepare-managed-pnpm-runtime":
            return prepareManagedPnpmRuntime();

        case "clone-managed-vencord":
            return cloneManagedVencord();

        case "ensure-managed-userplugins":
            return ensureManagedUserPluginsDirectory();

        case "install-bundled-plugins":
            return installBundledPlugins();

        case "install-managed-plugin-dependencies":
            return installManagedPluginDependencies();

        case "build-managed-vencord":
            return buildManagedVencord();

        case "backup-external-vencord-user-data":
            return backupExternalVencordUserData(
                discordName
            );

        case "install-managed-vencord":
            return installManagedVencord(
                discordName
            );

        case "migrate-external-vencord":
            return migrateExternalVencord(
                discordName
            );

        default:
            throw new Error(
                `Refusing automatic setup: unsupported planned action "${actionId}".`
            );
    }
}


async function runManagedInstallCoordinatorSteps(
    discordName
) {
    if (
        typeof discordName !== "string" ||
        discordName.trim().length === 0
    ) {
        throw new Error(
            "Automatic setup requires a detected Discord installation."
        );
    }

    const requestedName =
        discordName.trim();

    if (
        activeManagedInstallCoordinators.has(
            requestedName
        )
    ) {
        throw new Error(
            `Automatic setup is already running for Discord ${requestedName}.`
        );
    }

    activeManagedInstallCoordinators.add(
        requestedName
    );

    try {
        const initialPlan =
            await getManagedInstallPlan(
                requestedName
            );

        if (
            initialPlan?.target?.name !==
            requestedName
        ) {
            throw new Error(
                "Refusing automatic setup: planner target does not match the requested Discord installation."
            );
        }

        if (
            typeof initialPlan?.target?.path !== "string" ||
            initialPlan.target.path.length === 0
        ) {
            throw new Error(
                `Refusing automatic setup: Discord ${requestedName} does not have a verified installation path.`
            );
        }

        const lockedTargetPath =
            normalize(
                initialPlan.target.path
            ).toLowerCase();

        if (
            initialPlan.status === "blocked"
        ) {
            const blockers =
                Array.isArray(
                    initialPlan.blockers
                )
                    ? initialPlan.blockers
                        .map(blocker =>
                            blocker.message ??
                            blocker.id
                        )
                        .filter(Boolean)
                    : [];

            throw new Error(
                blockers.length > 0
                    ? `Automatic setup is blocked: ${blockers.join("; ")}`
                    : "Automatic setup is blocked by the current installation plan."
            );
        }

        if (
            initialPlan.status === "complete" &&
            initialPlan.alreadyManaged === true
        ) {
            return {
                ok: true,
                state: "complete",
                target:
                    initialPlan.target,
                alreadyManaged: true,
                steps: [],
                finalPlan:
                    initialPlan,
                reason:
                    `Discord ${requestedName} is already using the managed Vencord build.`
            };
        }

        const steps = [];
        const maxSteps = 12;

        let plan =
            initialPlan;

        for (
            let stepNumber = 1;
            stepNumber <= maxSteps;
            stepNumber += 1
        ) {
            if (
                plan?.target?.name !==
                requestedName
            ) {
                throw new Error(
                    "Automatic setup stopped because the planner target changed."
                );
            }

            if (
                typeof plan?.target?.path !== "string" ||
                normalize(
                    plan.target.path
                ).toLowerCase() !==
                lockedTargetPath
            ) {
                throw new Error(
                    "Automatic setup stopped because the detected Discord installation path changed."
                );
            }

            if (
                plan.status === "blocked"
            ) {
                const blockers =
                    Array.isArray(
                        plan.blockers
                    )
                        ? plan.blockers
                            .map(blocker =>
                                blocker.message ??
                                blocker.id
                            )
                            .filter(Boolean)
                        : [];

                throw new Error(
                    blockers.length > 0
                        ? `Automatic setup stopped: ${blockers.join("; ")}`
                        : "Automatic setup stopped because the recalculated plan became blocked."
                );
            }

            if (
                plan.status === "complete" &&
                plan.alreadyManaged === true
            ) {
                return {
                    ok: true,
                    state: "complete",
                    target:
                        plan.target,
                    alreadyManaged: false,
                    steps,
                    finalPlan:
                        plan,
                    reason:
                        `Automatic setup completed successfully for Discord ${requestedName}.`
                };
            }

            const action =
                plan.nextAction;

            if (
                !action ||
                typeof action.id !== "string"
            ) {
                throw new Error(
                    `Automatic setup stopped because plan status "${plan.status}" has no executable next action.`
                );
            }

            const actionStartedAt =
                new Date()
                    .toISOString();

            recordManagedMaintenanceStage(action.id, { step: stepNumber, discordName: requestedName });
            let result;

            try {
                result =
                    await executeManagedInstallPlanAction(
                        action.id,
                        requestedName
                    );
            } catch (error) {
                const failure = {
                    step:
                        stepNumber,
                    actionId:
                        action.id,
                    label:
                        action.label ??
                        action.id,
                    startedAt:
                        actionStartedAt,
                    finishedAt:
                        new Date()
                            .toISOString(),
                    ok: false,
                    error:
                        error?.message ??
                        "Unknown automatic setup error."
                };

                steps.push(
                    failure
                );

                let failurePlan = null;

                try {
                    failurePlan =
                        await getManagedInstallPlan(
                            requestedName
                        );
                } catch {
                    // Keep the original action error as the primary
                    // failure if the follow-up read-only plan cannot run.
                }

                const wrapped =
                    new Error(
                        `Automatic setup failed during "${failure.label}": ${failure.error}`
                    );

                wrapped.coordinator = {
                    ok: false,
                    state: "failed",
                    target: {
                        name:
                            requestedName,
                        path:
                            initialPlan.target.path
                    },
                    steps,
                    finalPlan:
                        failurePlan
                };

                throw wrapped;
            }

            const step = {
                step:
                    stepNumber,
                actionId:
                    action.id,
                label:
                    action.label ??
                    action.id,
                startedAt:
                    actionStartedAt,
                finishedAt:
                    new Date()
                        .toISOString(),
                ok: true,
                result:
                    summarizeCoordinatorActionResult(
                        action.id,
                        result
                    )
            };

            steps.push(
                step
            );

            const nextPlan =
                await getManagedInstallPlan(
                    requestedName
                );

            if (
                nextPlan?.target?.name !==
                requestedName ||
                typeof nextPlan?.target?.path !== "string" ||
                normalize(
                    nextPlan.target.path
                ).toLowerCase() !==
                lockedTargetPath
            ) {
                throw new Error(
                    `Automatic setup stopped after "${step.label}" because the selected Discord target changed during re-validation.`
                );
            }

            if (
                nextPlan.status !== "complete" &&
                nextPlan.nextAction?.id ===
                action.id
            ) {
                throw new Error(
                    `Automatic setup stopped after "${step.label}" because re-validation still requests the same action. Refusing to loop or repeat it automatically.`
                );
            }

            plan =
                nextPlan;
        }

        throw new Error(
            `Automatic setup exceeded its ${maxSteps}-step safety limit and was stopped.`
        );
    } finally {
        activeManagedInstallCoordinators.delete(
            requestedName
        );
    }
}



const managedMaintenanceContext = new AsyncLocalStorage();
const activeManagedMaintenance = new Set();
let managedMaintenanceSequence = 0;

function recordManagedMaintenanceStage(stage, details = {}) {
    const operation = managedMaintenanceContext.getStore();
    if (!operation) return;
    operation.stage = stage;
    operation.details = details;
    operation.updatedAt = new Date().toISOString();
    operation.stages.push({ stage, details, at: operation.updatedAt });
    try { writeFileSync(operation.logPath, JSON.stringify(operation, null, 2), "utf8"); }
    catch (error) { operation.logWarning = error?.message ?? String(error); }
}

async function runManagedMaintenance(operationName, action) {
    const inherited = managedMaintenanceContext.getStore();
    if (inherited) return action();
    const paths = getManagedPaths();
    if (!paths?.root) throw new Error("Managed workspace is unavailable.");
    const key = resolve(paths.root).toLowerCase();
    if (activeManagedMaintenance.has(key)) throw new Error("Another setup, source update, or repair is still running for this workspace.");
    assertSafePath(paths.logs);
    mkdirSync(paths.logs, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const operation = {
        operation: operationName, state: "running", stage: "starting",
        stages: [],
        startedAt: new Date().toISOString(),
        logPath: join(paths.logs, `${operationName}-${timestamp}-${process.pid}-${++managedMaintenanceSequence}.json`)
    };
    activeManagedMaintenance.add(key);
    try {
        return await managedMaintenanceContext.run(operation, async () => {
            recordManagedMaintenanceStage("starting");
            try {
                const result = await action();
                operation.state = "complete";
                recordManagedMaintenanceStage("complete");
                return { ...result, diagnosticLogPath: operation.logPath };
            } catch (error) {
                const failedStage = operation.stage;
                operation.state = "failed";
                operation.error = error?.message ?? String(error);
                operation.stack = error?.stack ?? null;
                operation.tool = error?.tool ?? null;
                recordManagedMaintenanceStage(failedStage, operation.details);
                const logSuffix = operation.logWarning
                    ? ` Diagnostic log could not be saved: ${operation.logWarning}`
                    : ` Diagnostic log: ${operation.logPath}`;
                const wrapped = new Error(`${operationName} failed during ${failedStage}: ${operation.error}${logSuffix}`);
                if (error?.coordinator) wrapped.coordinator = error.coordinator;
                throw wrapped;
            }
        });
    } finally { activeManagedMaintenance.delete(key); }
}

async function ensureManagedMaintenanceNode() {
    const paths = getManagedPaths();
    const node = await inspectManagedBuildTool("node");
    if (node.available && node.source === "managed" && node.version === `v${MANAGED_NODE_VERSION}` && readManagedNodeRuntimeManifest(join(paths.toolchain, "node")).available) return;
    recordManagedMaintenanceStage("preparing-managed-node");
    const target = join(paths.toolchain, "node");
    if (existsSync(target)) {
        // Reuse the existing verified migration for the exact old node.exe-only
        // seed. All other occupied paths retain the existing refusal policy.
        const entries = readdirSync(target, { withFileTypes: true });
        if (entries.length === 1 && entries[0].isFile() && entries[0].name.toLowerCase() === "node.exe") {
            await upgradeTemporaryManagedNodeSeedToVerifiedPortableNode();
            return;
        }
    }
    await prepareManagedNodeRuntime();
}

function getManagedCustomizationState() {
    const paths = getManagedPaths();
    if (!paths || !inspectManagedVencordSourceRoot(paths.vencord).valid) return { ready: false, reason: "Managed source needs recovery before customizations can be checked." };
    return assessSourceOverrides(paths.vencord, getInstallerResourceDirectory("sourceOverrides").path, BUNDLE_POLICY);
}

function getManagedBuildHealth() {
    const state = getManagedBuildState();
    if (!isManagedBuildReady(state)) return state;
    try {
        for (const file of state.files.filter(file => file.name.endsWith(".js"))) {
            assertSafePath(file.path);
            // Parse only; never execute a user's installed build in the installer.
            new Script(readFileSync(file.path, "utf8"), { filename: file.name });
        }
        return state;
    } catch (error) {
        return { ...state, state: "damaged", complete: false, reason: `Managed JavaScript build output failed validation: ${error?.message ?? error}` };
    }
}

async function getManagedRepairSourceIdentity() {
    const paths = getManagedPaths();
    const archive = getManagedArchiveVencordBuildMetadata({ allowDamagedSource: true });
    if (archive.available) return archive;
    if (existsSync(join(paths.vencord, ".git"))) {
        const remote = await runResolvedBuildTool("git", ["remote", "get-url", "origin"], { cwd: paths.vencord, windowsHide: true, timeout: 30000 });
        if (!/^(?:https:\/\/github\.com\/Vendicated\/Vencord(?:\.git)?\/?|git@github\.com:Vendicated\/Vencord(?:\.git)?)$/i.test(remote.stdout.trim()))
            throw new Error("Managed Git source does not identify the trusted Vencord repository. Existing source was kept.");
        const result = await runResolvedBuildTool("git", ["rev-parse", "HEAD"], { cwd: paths.vencord, windowsHide: true, timeout: 30000 });
        const commit = result.stdout.trim().toLowerCase();
        if (/^[0-9a-f]{40}$/.test(commit)) return { available: true, repository: VENCORD_GITHUB_REPOSITORY, commit, shortCommit: commit.slice(0, 8) };
    }
    throw new Error("Cannot recover source safely: no trusted installed commit metadata is available. Existing files and backups were kept; the diagnostic log identifies the failed state.");
}

function getMaintenanceSourceManifest(root) {
    if (!existsSync(root)) return [];
    assertSafePath(root);
    const ignored = new Set([".git", "node_modules", "dist", MANAGED_VENCORD_SOURCE_METADATA_FILE]);
    const files = [];
    const walk = (directory, relative = "") => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === "node_modules" || (!relative && ignored.has(entry.name))) continue;
            const rel = relative ? `${relative}/${entry.name}` : entry.name;
            const file = assertSafePath(join(root, rel));
            if (entry.isDirectory()) walk(file, rel);
            else if (entry.isFile()) files.push({ path: rel, size: statSync(file).size, sha256: getFileSha256(file) });
            else throw new Error(`Unsupported redirected or non-file source entry: ${file}`);
        }
    };
    walk(root);
    return files.sort((a, b) => a.path.localeCompare(b.path));
}

function findRecordedSourceBaseline(commit) {
    const paths = getManagedPaths();
    const root = join(paths.root, "source-acquisition");
    if (existsSync(root)) {
        for (const entry of readdirSync(root, { withFileTypes: true }).reverse()) {
            if (!entry.isDirectory()) continue;
            const candidate = inspectStagedVencordSourceCandidate(join(root, entry.name), root);
            if (candidate.valid && candidate.commit === commit) return candidate;
        }
    }
    return null;
}

async function getRecordedSourceBaseline(commit) {
    const recorded = findRecordedSourceBaseline(commit);
    if (recorded) return recorded;
    recordManagedMaintenanceStage("acquiring-installed-source-baseline", { commit });
    return acquireVencordSourceArchiveToStaging({ commit });
}

function getManagedSourceHealth() {
    const paths = getManagedPaths();
    if (!paths) return { valid: false, reason: "Managed workspace unavailable." };
    const structural = inspectManagedVencordSourceRoot(paths.vencord);
    if (!structural.valid) return structural;
    const identity = getManagedArchiveVencordBuildMetadata();
    const recorded = identity.available ? findRecordedSourceBaseline(identity.commit) : null;
    if (!recorded) return { ...structural, integrityCoverage: "required-source-structure" };
    const missingPaths = getMaintenanceSourceManifest(recorded.stagedSourceRoot).filter(file => {
        if (file.path.startsWith("src/userplugins/")) return false;
        const current = assertSafePath(join(paths.vencord, file.path));
        return !existsSync(current) || !statSync(current).isFile() || (file.size > 0 && statSync(current).size === 0);
    }).map(file => file.path);
    return missingPaths.length ? {
        ...structural, valid: false, missingPaths,
        reason: `Recorded managed source files are missing or empty: ${missingPaths.join(", ")}`
    } : { ...structural, integrityCoverage: "recorded-source-presence" };
}

function stableSourceJson(value) {
    if (Array.isArray(value)) return value.map(stableSourceJson);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableSourceJson(value[key])]));
    return value;
}

function preserveSourceDependencies(oldSource, currentSource, stagedSource) {
    const currentPath = join(currentSource, "package.json");
    if (!isRegularNonEmptyFile(currentPath)) return;
    const base = JSON.parse(readFileSync(join(oldSource, "package.json"), "utf8"));
    let current;
    try { current = JSON.parse(readFileSync(currentPath, "utf8")); }
    catch {
        recordManagedMaintenanceStage("recovering-damaged-package-metadata", { currentPath, recovery: "Restore from the recorded source; retain the damaged file in the activation backup." });
        return;
    }
    const nextPath = join(stagedSource, "package.json");
    const next = JSON.parse(readFileSync(nextPath, "utf8"));
    const fields = ["dependencies", "devDependencies", "optionalDependencies"];
    const omitDependencies = obj => Object.fromEntries(Object.entries(obj).filter(([key]) => !fields.includes(key)));
    if (JSON.stringify(stableSourceJson(omitDependencies(base))) !== JSON.stringify(stableSourceJson(omitDependencies(current))))
        throw new Error("Managed package.json has custom changes outside dependency declarations. Refusing to discard them; the original source was kept for compatibility review.");
    for (const field of fields) {
        for (const name of new Set([...Object.keys(base[field] ?? {}), ...Object.keys(current[field] ?? {})])) {
            const original = base[field]?.[name], installed = current[field]?.[name], upstream = next[field]?.[name];
            if (installed === original) continue;
            // Preserve a compatible stronger upstream requirement for the
            // installer-owned shared dependency rather than downgrading it.
            if (name === "socket.io-client" && isCompatibleSocketDeclaration(installed) && isCompatibleSocketDeclaration(upstream)) continue;
            if (upstream !== original && upstream !== installed)
                throw new Error(`Dependency preservation conflict: ${field}.${name}. Existing source was kept.`);
            next[field] ??= {};
            if (installed === undefined) delete next[field][name];
            else next[field][name] = installed;
        }
    }
    writeFileSync(nextPath, JSON.stringify(next, null, 4) + "\n", "utf8");
}

async function preserveManagedSourceChanges(currentSource, stagedSource, commit) {
    const currentFiles = getMaintenanceSourceManifest(currentSource);
    if (!currentFiles.length) return { files: [], manifest: currentFiles };
    const baseline = await getRecordedSourceBaseline(commit);
    recordManagedMaintenanceStage("preserving-user-source-changes", { currentSource, stagedSource, commit });
    const oldSource = baseline.stagedSourceRoot;
    const oldFiles = new Map(getMaintenanceSourceManifest(oldSource).map(file => [file.path, file]));
    const overrideRoot = getInstallerResourceDirectory("sourceOverrides").path;
    const recordedCustomizations = readManagedVencordSourceMetadata(currentSource).customizationBases;
    let fallbackCustomizations = null;
    const oldCustomization = new Map(Object.keys(BUNDLE_POLICY.overrides.files).map(rel => {
        const recorded = recordedCustomizations?.[rel];
        if (recorded !== undefined && typeof recorded !== "string") throw new Error(`Invalid recorded customization base: ${rel}`);
        if (recorded !== undefined) return [rel, recorded];
        fallbackCustomizations ??= new Map(planSourceOverrides(oldSource, overrideRoot, BUNDLE_POLICY).map(plan => [plan.rel, plan.output]));
        return [rel, fallbackCustomizations.get(rel)];
    }));
    const preserved = [];
    preserveSourceDependencies(oldSource, currentSource, stagedSource);
    for (const file of currentFiles) {
        if (file.path.startsWith("src/userplugins/") || file.path === "package.json" || file.path === "pnpm-lock.yaml") continue;
        const original = oldFiles.get(file.path);
        const currentPath = join(currentSource, file.path);
        const target = assertSafePath(join(stagedSource, file.path));
        if (!original) {
            if (existsSync(target) && getFileSha256(target) !== file.sha256) throw new Error(`New upstream file conflicts with a preserved user file: ${file.path}`);
            if (!existsSync(target)) { mkdirSync(dirname(target), { recursive: true }); cpSync(currentPath, target, { force: false, errorOnExist: true }); }
            preserved.push(file.path);
            continue;
        }
        const oldText = oldCustomization.get(file.path);
        if (oldText !== undefined) {
            const current = readFileSync(currentPath, "utf8");
            // Preserve extra edits beyond the installer-owned customization.
            // If the old file was never customized, apply only the required
            // installer customization to the new source.
            const base = readFileSync(join(oldSource, file.path), "utf8");
            if (current.replace(/\r\n/g, "\n") === base.replace(/\r\n/g, "\n")) continue;
            if (current.replace(/\r\n/g, "\n") === oldText.replace(/\r\n/g, "\n")) continue;
            const patched = applyCustomizationHunks(readFileSync(target, "utf8"), createCustomizationHunks(oldText, current), file.path);
            writeFileSync(target, patched, "utf8");
            preserved.push(file.path);
        } else if (file.sha256 !== original.sha256) {
            if (!isRegularNonEmptyFile(target)) throw new Error(`Modified source file no longer exists upstream: ${file.path}. Existing files were kept.`);
            const oldBytes = readFileSync(join(oldSource, file.path));
            const currentBytes = readFileSync(currentPath);
            if (oldBytes.includes(0) || currentBytes.includes(0)) throw new Error(`Modified binary source needs compatibility review: ${file.path}`);
            const patched = applyCustomizationHunks(readFileSync(target, "utf8"), createCustomizationHunks(oldBytes.toString("utf8"), currentBytes.toString("utf8")), file.path);
            writeFileSync(target, patched, "utf8");
            preserved.push(file.path);
        }
    }
    return { files: preserved, manifest: currentFiles };
}

function restoreMissingBundledFilesForRepair(stagedSourceRoot) {
    const root = join(stagedSourceRoot, "src", "userplugins");
    const assessment = getMaruPluginInstallationAssessment(root);
    if (!assessment.repairEligible) return;
    const bundle = getBundledPluginsState();
    validatePluginBundle(bundle.root, BUNDLED_PLUGIN_FILES, BUNDLE_POLICY);
    for (const rel of assessment.missingFiles) {
        const destination = assertSafePath(join(root, rel));
        if (existsSync(destination)) throw new Error(`Missing plugin file appeared during repair: ${rel}`);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(bundle.root, rel), destination, { force: false, errorOnExist: true });
    }
}

function verifyPreservedSourceFiles(sourceRoot, files) {
    for (const file of files) {
        const target = assertSafePath(join(sourceRoot, file.path));
        if (!existsSync(target) || !statSync(target).isFile() || statSync(target).size !== file.size || getFileSha256(target) !== file.sha256)
            throw new Error(`Preserved source or customization changed during preparation: ${file.path}. Activation was refused or rolled back.`);
    }
    const customizations = assessSourceOverrides(sourceRoot, getInstallerResourceDirectory("sourceOverrides").path, BUNDLE_POLICY);
    if (!customizations.ready) throw new Error(customizations.reason ?? "Required source customizations failed post-build verification.");
}

async function updateManagedVencord() {
    return runManagedMaintenance("managed-vencord-update", () => replaceManagedVencordSource());
}

async function repairManagedSource() {
    const identity = await getManagedRepairSourceIdentity();
    return replaceManagedVencordSource({ repair: true, identity });
}

async function repairManagedVencord(discordName) {
    return runManagedMaintenance("managed-vencord-repair", async () => {
        recordManagedMaintenanceStage("assessing-repair");
        const ownership = getManagedUninstallStates().find(state => state.name === discordName);
        if (ownership?.state !== "managed" || ownership.eligible !== true) throw new Error(ownership?.reason ?? "Repair requires a verified managed Discord installation.");
        await assertManagedDiscordTargetsClosedForSourceUpdate();
        const paths = getManagedPaths();
        const source = getManagedSourceHealth();
        const build = getManagedBuildHealth();
        const plugins = getManagedInstalledPluginsState();
        const dependencies = getManagedPluginDependenciesState();
        const customization = getManagedCustomizationState();
        recordManagedMaintenanceStage("assessing-repair", {
            source: source.valid ? "ready" : source.reason,
            build: build.state,
            buildReason: build.reason ?? null,
            incompleteArtifacts: build.files?.filter(file => !file.exists || !file.nonEmpty).map(file => file.name) ?? [],
            plugins: plugins.state,
            dependency: dependencies.state,
            customizations: customization.reason ?? "ready"
        });
        let recovery = null;
        if (!source.valid || !isManagedBuildReady(build) || plugins.state !== "installed" || dependencies.state !== "installed" || !customization.ready) recovery = await repairManagedSource();
        await ensureManagedMaintenanceNode();
        recordManagedMaintenanceStage("repairing-discord-patch", { discordName });
        const patch = await repairManagedDiscordPatch(discordName);
        if (!isManagedBuildReady(getManagedBuildHealth())) throw new Error("Repair verification found incomplete or damaged build output after Discord patch repair.");
        return { ...patch, recoveredSource: Boolean(recovery), recovery, reason: recovery ? "Managed source and build recovered at the installed commit; Discord patch verified." : "Existing complete build preserved; Discord patch repaired and verified." };
    });
}

async function runManagedInstallCoordinator(discordName) {
    return runManagedMaintenance("automatic-setup", () => runManagedInstallCoordinatorSteps(discordName));
}


function readManagedVencordSourceMetadata(
    sourceRoot
) {
    const metadataPath =
        join(
            sourceRoot,
            MANAGED_VENCORD_SOURCE_METADATA_FILE
        );

    if (!isRegularNonEmptyFile(metadataPath)) {
        return {
            available: false,
            metadataPath,
            reason:
                "Managed Vencord source metadata file is missing."
        };
    }

    let metadata;

    try {
        metadata =
            JSON.parse(
                readFileSync(
                    metadataPath,
                    "utf8"
                )
            );
    } catch (error) {
        return {
            available: false,
            metadataPath,
            reason:
                `Managed Vencord source metadata is invalid JSON: ${error?.message ?? "Unknown JSON error."}`
        };
    }

    const commit =
        typeof metadata?.commit === "string"
            ? metadata.commit.trim().toLowerCase()
            : "";

    if (
        metadata?.repository !==
        VENCORD_GITHUB_REPOSITORY ||
        !/^[0-9a-f]{40}$/.test(commit)
    ) {
        return {
            available: false,
            metadataPath,
            reason:
                "Managed Vencord source metadata does not contain a trusted Vendicated/Vencord commit."
        };
    }

    return {
        available: true,
        source:
            "managed-source-metadata",
        metadataPath,
        repository:
            VENCORD_GITHUB_REPOSITORY,
        commit,
        shortCommit:
            commit.slice(0, 8),
        updatedAt:
            metadata.updatedAt ?? null,
        acquisitionManifestPath:
            metadata.acquisitionManifestPath ?? null,
        updateManifestPath:
            metadata.updateManifestPath ?? null,
        customizationBases:
            metadata.customizationBases ?? null
    };
}


function writeManagedVencordSourceMetadata(
    sourceRoot,
    details
) {
    const commit =
        typeof details?.commit === "string"
            ? details.commit.trim().toLowerCase()
            : "";

    if (!/^[0-9a-f]{40}$/.test(commit)) {
        throw new Error(
            "Refusing to write managed Vencord source metadata without a valid 40-character commit SHA."
        );
    }

    const metadataPath =
        join(
            sourceRoot,
            MANAGED_VENCORD_SOURCE_METADATA_FILE
        );

    const metadata = {
        schemaVersion: 1,
        repository:
            VENCORD_GITHUB_REPOSITORY,
        commit,
        updatedAt:
            new Date().toISOString(),
        sourceType:
            "trusted-github-archive",
        acquisitionManifestPath:
            details?.acquisitionManifestPath ?? null,
        updateManifestPath:
            details?.updateManifestPath ?? null,
        customizationBases:
            details?.customizationBases ?? null
    };

    writeFileSync(
        metadataPath,
        JSON.stringify(
            metadata,
            null,
            2
        ),
        "utf8"
    );

    return {
        metadataPath,
        metadata
    };
}


function getManagedArchiveVencordBuildMetadata({ allowDamagedSource = false } = {}) {
    const paths =
        getManagedPaths();

    if (!paths?.root) {
        return {
            available: false,
            reason:
                "Managed workspace path is unavailable."
        };
    }

    const vencordState =
        getManagedVencordState();

    if (
        !allowDamagedSource && (vencordState.state !== "repository" ||
        vencordState.sourceType !== "archive")
    ) {
        return {
            available: false,
            notRequired: true,
            reason:
                "Managed Vencord source is not archive-based."
        };
    }

    const liveMetadata =
        readManagedVencordSourceMetadata(
            paths.vencord
        );

    if (liveMetadata.available) {
        return liveMetadata;
    }

    const acquisitionRoot =
        join(
            paths.root,
            "source-acquisition"
        );

    if (
        !existsSync(
            acquisitionRoot
        )
    ) {
        return {
            available: false,
            reason:
                "Archive-managed Vencord source acquisition metadata is missing."
        };
    }

    const candidates = [];

    for (
        const entry of
        readdirSync(
            acquisitionRoot,
            {
                withFileTypes: true
            }
        )
    ) {
        if (!entry.isDirectory()) {
            continue;
        }

        const stagingRoot =
            join(
                acquisitionRoot,
                entry.name
            );

        const promotionManifestPath =
            join(
                stagingRoot,
                "source-promotion-manifest.json"
            );

        if (
            !isRegularNonEmptyFile(
                promotionManifestPath
            )
        ) {
            continue;
        }

        let manifest;

        try {
            manifest =
                JSON.parse(
                    readFileSync(
                        promotionManifestPath,
                        "utf8"
                    )
                );
        } catch {
            continue;
        }

        const commit =
            typeof manifest?.commit === "string"
                ? manifest.commit.trim()
                : "";

        const managedVencordPath =
            typeof manifest?.managedVencordPath === "string"
                ? resolve(
                    manifest.managedVencordPath
                )
                : null;

        if (
            manifest?.repository !==
            VENCORD_GITHUB_REPOSITORY ||
            !/^[0-9a-f]{40}$/i.test(
                commit
            ) ||
            !managedVencordPath ||
            normalize(
                managedVencordPath
            ).toLowerCase() !==
            normalize(
                resolve(
                    paths.vencord
                )
            ).toLowerCase() ||
            manifest?.overwritePerformed !==
            false
        ) {
            continue;
        }

        const promotedAtMs =
            Date.parse(
                manifest?.promotedAt ??
                ""
            );

        candidates.push({
            promotionManifestPath,
            stagingRoot,
            manifest,
            commit:
                commit.toLowerCase(),
            promotedAtMs:
                Number.isFinite(
                    promotedAtMs
                )
                    ? promotedAtMs
                    : statSync(
                        promotionManifestPath
                    ).mtimeMs
        });
    }

    candidates.sort(
        (left, right) =>
            right.promotedAtMs -
            left.promotedAtMs
    );

    const selected =
        candidates[0];

    if (!selected) {
        return {
            available: false,
            reason:
                "No trusted promotion manifest matches the current archive-managed Vencord source."
        };
    }

    return {
        available: true,
        source:
            "promotion-manifest",
        repository:
            VENCORD_GITHUB_REPOSITORY,
        commit:
            selected.commit,
        shortCommit:
            selected.commit.slice(
                0,
                8
            ),
        promotionManifestPath:
            selected.promotionManifestPath,
        stagingRoot:
            selected.stagingRoot
    };
}


async function getManagedVencordUpdateState() {
    const paths =
        getManagedPaths();

    if (!paths?.vencord) {
        return {
            available: false,
            state: "unavailable",
            reason:
                "Managed Vencord path is unavailable."
        };
    }

    const vencordState =
        getManagedVencordState();

    if (
        vencordState.state !==
        "repository"
    ) {
        return {
            available: false,
            state: "unavailable",
            sourceType:
                vencordState.sourceType ?? null,
            reason:
                `Managed Vencord source is not ready (state: ${vencordState.state}).`
        };
    }

    let currentCommit = null;
    let currentCommitSource = null;

    if (
        vencordState.sourceType ===
        "archive"
    ) {
        const archiveMetadata =
            getManagedArchiveVencordBuildMetadata();

        if (!archiveMetadata.available) {
            return {
                available: false,
                state: "unavailable",
                sourceType: "archive",
                reason:
                    archiveMetadata.reason ??
                    "Current managed Vencord archive commit metadata is unavailable."
            };
        }

        currentCommit =
            archiveMetadata.commit;
        currentCommitSource =
            archiveMetadata.source;
    } else if (
        vencordState.sourceType ===
        "git"
    ) {
        try {
            const result =
                await runResolvedBuildTool(
                    "git",
                    [
                        "rev-parse",
                        "HEAD"
                    ],
                    {
                        cwd:
                            paths.vencord,
                        windowsHide: true,
                        timeout: 15000
                    }
                );

            const candidate =
                result.stdout.trim()
                    .toLowerCase();

            if (
                !/^[0-9a-f]{40}$/.test(
                    candidate
                )
            ) {
                return {
                    available: false,
                    state: "unavailable",
                    sourceType: "git",
                    reason:
                        "Managed Git repository did not return a valid current commit SHA."
                };
            }

            currentCommit =
                candidate;
            currentCommitSource =
                "git-head";
        } catch (error) {
            return {
                available: false,
                state: "unavailable",
                sourceType: "git",
                reason:
                    error?.message ??
                    "Unable to read the current managed Vencord Git commit."
            };
        }
    } else {
        return {
            available: false,
            state: "unavailable",
            sourceType:
                vencordState.sourceType ?? null,
            reason:
                `Unsupported managed Vencord source type: ${vencordState.sourceType ?? "unknown"}.`
        };
    }

    let latest;

    try {
        latest =
            await resolveTrustedVencordMainCommit();
    } catch (error) {
        return {
            available: false,
            state: "unavailable",
            sourceType:
                vencordState.sourceType ?? null,
            currentCommit,
            currentShortCommit:
                currentCommit?.slice(0, 8) ?? null,
            currentCommitSource,
            reason:
                error?.message ??
                "Unable to resolve the latest trusted Vencord commit."
        };
    }

    const latestCommit =
        latest.commit.toLowerCase();

    const commitUpdateAvailable =
        currentCommit !==
        latestCommit;

    const updaterPolicy =
        getVencordUpdaterBuildPolicyAtSource(
            paths.vencord
        );

    const policyRefreshRequired =
        updaterPolicy.available !== true ||
        updaterPolicy.updaterDisabled !== true;

    const updateAvailable =
        commitUpdateAvailable ||
        policyRefreshRequired;

    return {
        available: true,
        state:
            commitUpdateAvailable
                ? "update-available"
                : policyRefreshRequired
                    ? "managed-refresh-available"
                    : "current",
        updateAvailable,
        commitUpdateAvailable,
        policyRefreshRequired,
        updaterPolicy,
        sourceType:
            vencordState.sourceType ?? null,
        repository:
            latest.repository,
        currentCommit,
        currentShortCommit:
            currentCommit.slice(0, 8),
        currentCommitSource,
        latestCommit,
        latestShortCommit:
            latestCommit.slice(0, 8),
        checkedAt:
            new Date().toISOString(),
        reason:
            commitUpdateAvailable
                ? "A newer Vencord main commit is available."
                : policyRefreshRequired
                    ? "Managed Vencord is current upstream, but this build needs a one-time refresh to disable Vencord's native updater."
                    : "Managed Vencord is already on the latest Vencord main commit and uses the Maru-managed update policy."
    };
}


function getVencordPackageManagerAtSource(
    sourceRoot
) {
    const packageJsonPath =
        join(
            sourceRoot,
            "package.json"
        );

    if (!isRegularNonEmptyFile(packageJsonPath)) {
        throw new Error(
            `Vencord package.json is missing at ${packageJsonPath}.`
        );
    }

    let packageJson;

    try {
        packageJson =
            JSON.parse(
                readFileSync(
                    packageJsonPath,
                    "utf8"
                )
            );
    } catch (error) {
        throw new Error(
            `Unable to read staged Vencord package.json: ${error?.message ?? "Unknown JSON error."}`
        );
    }

    const packageManager =
        typeof packageJson?.packageManager === "string"
            ? packageJson.packageManager.trim()
            : "";

    const match =
        packageManager.match(
            /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
        );

    if (!match) {
        throw new Error(
            `Unsupported staged Vencord package manager requirement: "${packageManager || "missing"}".`
        );
    }

    return {
        packageJsonPath,
        packageManager,
        requiredVersion:
            match[1]
    };
}


async function resolveVencordPnpmRunnerAtSource(sourceRoot) {
    const requirement = getVencordPackageManagerAtSource(sourceRoot);
    await ensureManagedMaintenanceNode();
    const paths = getManagedPaths();
    const select = () => {
        const cached = resolveManagedPnpmPackageRuntime(paths, join(paths.toolchain, "pnpm-versions", requirement.requiredVersion));
        const legacy = resolveManagedPnpmPackageRuntime(paths);
        return cached?.managedPackageVersion === requirement.requiredVersion ? cached : legacy?.managedPackageVersion === requirement.requiredVersion ? legacy : null;
    };
    let runtime = select();
    if (!runtime) {
        recordManagedMaintenanceStage("preparing-staged-pnpm", { sourceRoot, requiredVersion: requirement.requiredVersion });
        await prepareManagedPnpmRuntime({ sourceRoot });
        runtime = select();
    }
    if (!runtime) throw new Error("The source-specific managed pnpm runtime was not verified after preparation.");
    const runner = { toolName: "pnpm", argsPrefix: [], source: "managed", command: runtime.command,
        executionOptions: { managedPnpmRoot: dirname(runtime.manifestPath) } };
    const probe = await runResolvedBuildTool(runner.toolName, ["--version"], { ...runner.executionOptions, cwd: sourceRoot, windowsHide: true, timeout: 30000 });
    if (probe.stdout.trim() !== requirement.requiredVersion) throw new Error(`Staged source requires pnpm ${requirement.requiredVersion}; its managed runtime returned ${probe.stdout || "no version"}.`);
    return { ...requirement, runner, resolvedVersion: probe.stdout.trim() };
}


function getVencordBuildStateAtSource(
    sourceRoot
) {
    const distPath =
        join(
            sourceRoot,
            "dist"
        );

    const requiredFiles = [
        "patcher.js",
        "preload.js",
        "renderer.js",
        "renderer.css",
        "vencordDesktopMain.js",
        "vencordDesktopPreload.js",
        "vencordDesktopRenderer.js",
        "vencordDesktopRenderer.css"
    ];

    const files =
        requiredFiles.map(name => {
            const filePath =
                join(
                    distPath,
                    name
                );

            let size = 0;

            if (existsSync(filePath)) {
                try {
                    size =
                        statSync(filePath).size;
                } catch {
                    size = 0;
                }
            }

            return {
                name,
                path:
                    filePath,
                exists:
                    existsSync(filePath),
                nonEmpty:
                    size > 0,
                size
            };
        });

    const complete =
        files.every(
            file =>
                file.exists &&
                file.nonEmpty
        );

    return {
        state:
            complete
                ? "built"
                : files.some(file => file.exists)
                    ? "partial"
                    : "missing",
        path:
            distPath,
        complete,
        files
    };
}


function getVencordUpdaterBuildPolicyAtSource(
    sourceRoot
) {
    const candidates = [
        join(sourceRoot, "dist", "renderer.js"),
        join(sourceRoot, "dist", "vencordDesktopRenderer.js"),
        join(sourceRoot, "dist", "patcher.js")
    ];

    const inspected = [];

    for (const filePath of candidates) {
        if (!isRegularNonEmptyFile(filePath)) {
            continue;
        }

        let header;

        try {
            header = readFileSync(filePath, "utf8").slice(0, 4096);
        } catch (error) {
            return {
                available: false,
                updaterDisabled: null,
                reason: `Unable to inspect managed Vencord build policy at ${filePath}: ${error?.message ?? "Unknown read error."}`
            };
        }

        const match = header.match(/\/\/ Updater Disabled:\s*(true|false)/i);

        inspected.push({
            path: filePath,
            updaterDisabled: match
                ? match[1].toLowerCase() === "true"
                : null
        });
    }

    const resolved = inspected.filter(
        item => typeof item.updaterDisabled === "boolean"
    );

    if (resolved.length === 0) {
        return {
            available: false,
            updaterDisabled: null,
            inspected,
            reason: "Managed Vencord build does not expose the expected updater policy banner."
        };
    }

    const values = new Set(resolved.map(item => item.updaterDisabled));

    if (values.size !== 1) {
        return {
            available: false,
            updaterDisabled: null,
            inspected,
            reason: "Managed Vencord build artifacts disagree about whether the native updater is disabled."
        };
    }

    const updaterDisabled = resolved[0].updaterDisabled;

    return {
        available: true,
        updaterDisabled,
        inspected,
        reason: updaterDisabled
            ? "Vencord native updater is disabled in this managed build."
            : "Vencord native updater is still enabled in this managed build."
    };
}


function copyDirectoryContentsVerified(
    sourceDirectory,
    destinationDirectory,
    label
) {
    if (!existsSync(sourceDirectory)) {
        return {
            copied: false,
            fileCount: 0,
            totalBytes: 0,
            reason:
                `${label} source directory does not exist.`
        };
    }

    mkdirSync(
        destinationDirectory,
        {
            recursive: true
        }
    );

    const sourceManifest =
        getBackupFileManifest(
            sourceDirectory
        );

    for (
        const entry of
        readdirSync(
            sourceDirectory,
            {
                withFileTypes: true
            }
        )
    ) {
        const destination =
            join(
                destinationDirectory,
                entry.name
            );

        if (existsSync(destination)) {
            throw new Error(
                `Refusing ${label} preservation because the staged destination already exists: ${destination}`
            );
        }

        cpSync(
            join(
                sourceDirectory,
                entry.name
            ),
            destination,
            {
                recursive: true,
                force: false,
                errorOnExist: true
            }
        );
    }

    const destinationManifest =
        getBackupFileManifest(
            destinationDirectory
        );

    const destinationByPath =
        new Map(
            destinationManifest.map(
                file => [file.path, file]
            )
        );

    for (const sourceFile of sourceManifest) {
        const destinationFile =
            destinationByPath.get(
                sourceFile.path
            );

        if (
            !destinationFile ||
            destinationFile.size !== sourceFile.size ||
            destinationFile.sha256 !== sourceFile.sha256
        ) {
            throw new Error(
                `${label} preservation verification failed for ${sourceFile.path}.`
            );
        }
    }

    return {
        copied: true,
        fileCount:
            sourceManifest.length,
        totalBytes:
            sourceManifest.reduce(
                (total, file) =>
                    total + file.size,
                0
            ),
        sourceManifest
    };
}

function applySourceOverridesToStagedSource(stagedSourceRoot, revision) {
    const resource = getInstallerResourceDirectory("sourceOverrides");
    return applyApprovedOverrides(stagedSourceRoot, resource.path, BUNDLE_POLICY, revision);
}

function ensureBundledPluginsInStagedSource(
    stagedSourceRoot
) {
    const bundleState =
        getBundledPluginsState();

    if (!bundleState.complete) {
        throw new Error(
            "Bundled Maru plugin payload is incomplete; managed Vencord update will not continue."
        );
    }

    const userPluginsPath =
        join(
            stagedSourceRoot,
            "src",
            "userplugins"
        );

    mkdirSync(
        userPluginsPath,
        {
            recursive: true
        }
    );

    const anyManagedPlugin = bundleState.plugins.some(plugin => existsSync(join(userPluginsPath, plugin.name)));
    const needsBundledAddition = bundleState.plugins.some(plugin => !existsSync(join(userPluginsPath, plugin.name)));
    if (anyManagedPlugin && needsBundledAddition) {
        const assessment = getMaruPluginInstallationAssessment(userPluginsPath);
        if (!assessment.updateSafe) throw new Error(assessment.reason);
    }

    const results = [];

    for (const plugin of bundleState.plugins) {
        const destination =
            join(
                userPluginsPath,
                plugin.name
            );

        assertSafePath(destination);
        for (const file of BUNDLED_PLUGIN_FILES[plugin.name]) assertSafePath(join(destination, file));

        if (existsSync(destination)) {
            const missingFiles =
                BUNDLED_PLUGIN_FILES[plugin.name]
                    .filter(file =>
                        !isRegularNonEmptyFile(
                            join(
                                destination,
                                file
                            )
                        )
                    );

            if (missingFiles.length > 0) {
                throw new Error(
                    `Preserved plugin folder "${plugin.name}" is incomplete after staging. Missing: ${missingFiles.join(", ")}. Update will not overwrite it.`
                );
            }

            results.push({
                name:
                    plugin.name,
                action:
                    "preserved",
                path:
                    destination
            });

            continue;
        }

        copyApprovedPlugin(bundleState.root, destination, plugin.name, BUNDLED_PLUGIN_FILES, BUNDLE_POLICY);

        results.push({
            name:
                plugin.name,
            action:
                "restored-from-bundle",
            path:
                destination
        });
    }

    return results;
}


function isCompatibleSocketDeclaration(declaration) {
    const match = /^(?:\^)?(\d+)\.(\d+)\.(\d+)$/.exec(declaration ?? "");
    return Boolean(match && Number(match[1]) === 4 && (Number(match[2]) > 8 || (Number(match[2]) === 8 && Number(match[3]) >= 3)));
}

async function installRequiredDependencyAtSource(sourceRoot) {
    const verification = await resolveVencordPnpmRunnerAtSource(sourceRoot);
    const dependency = "socket.io-client@^4.8.3";
    const packagePath = join(sourceRoot, "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    const declared = packageJson.dependencies?.["socket.io-client"] ?? packageJson.devDependencies?.["socket.io-client"] ?? null;
    const keepDeclaration = isCompatibleSocketDeclaration(declared);
    if (declared && !keepDeclaration && !/^\^?4\.\d+\.\d+$/.test(declared))
        throw new Error(`Bundled plugins require socket.io-client ^4.8.3, but the staged source declares ${declared}. Refusing to replace an incompatible upstream or user dependency.`);
    recordManagedMaintenanceStage("preparing-plugin-dependency-lockfile", { sourceRoot, dependency, declared, keepDeclaration });
    const packageHash = getFileSha256(packagePath);
    const args = keepDeclaration
        ? ["--config.confirmModulesPurge=false", "install", "--lockfile-only", "--no-frozen-lockfile", "--ignore-scripts"]
        : ["--config.confirmModulesPurge=false", "add", "-w", dependency];
    const result = await runResolvedBuildTool(verification.runner.toolName, [...verification.runner.argsPrefix, ...args], {
        ...verification.runner.executionOptions,
        cwd: sourceRoot, windowsHide: true, timeout: 300000,
        env: { CI: "true", pnpm_config_verify_deps_before_run: "false" }
    });
    if (keepDeclaration && getFileSha256(packagePath) !== packageHash)
        throw new Error("Staged lockfile preparation unexpectedly changed package.json. Existing managed source was kept.");
    return { dependency, packageManager: verification.packageManager, packageManagerSource: verification.runner.source,
        output: result.stdout, warnings: result.stderr };
}


async function buildVencordAtSource(
    sourceRoot,
    commit
) {
    const verification =
        await resolveVencordPnpmRunnerAtSource(
            sourceRoot
        );

    recordManagedMaintenanceStage("installing-workspace-dependencies", { sourceRoot });
    await runResolvedBuildTool(verification.runner.toolName, [
        ...verification.runner.argsPrefix, "--config.confirmModulesPurge=false", "install", "--frozen-lockfile"
    ], { ...verification.runner.executionOptions, cwd: sourceRoot, windowsHide: true, timeout: 600000, env: {
        CI: "true", pnpm_config_verify_deps_before_run: "false",
        VENCORD_HASH: commit.slice(0, 8), VENCORD_REMOTE: VENCORD_GITHUB_REPOSITORY
    } });
    recordManagedMaintenanceStage("building-staged-source", { sourceRoot, commit });
    const result =
        await runResolvedBuildTool(
            verification.runner.toolName,
            [
                ...verification.runner.argsPrefix,
                "--config.confirmModulesPurge=false",
                "run",
                "build",
                "--",
                "--disable-updater"
            ],
            {
                ...verification.runner.executionOptions,
                cwd:
                    sourceRoot,
                windowsHide: true,
                timeout: 600000,
                env: {
                    CI: "true", pnpm_config_verify_deps_before_run: "false",
                    VENCORD_HASH:
                        commit.slice(0, 8),
                    VENCORD_REMOTE:
                        VENCORD_GITHUB_REPOSITORY
                }
            }
        );

    const buildState =
        getVencordBuildStateAtSource(
            sourceRoot
        );

    if (
        buildState.state !== "built" ||
        buildState.complete !== true
    ) {
        throw new Error(
            "Staged Vencord build command completed, but required build artifacts are missing or empty."
        );
    }

    const updaterPolicy =
        getVencordUpdaterBuildPolicyAtSource(
            sourceRoot
        );

    if (
        updaterPolicy.available !== true ||
        updaterPolicy.updaterDisabled !== true
    ) {
        throw new Error(
            updaterPolicy.reason ??
            "Staged managed Vencord build did not disable the native Vencord updater."
        );
    }

    return {
        packageManager:
            verification.packageManager,
        updaterPolicy,
        packageManagerSource:
            verification.runner.source,
        buildState,
        output:
            result.stdout,
        warnings:
            result.stderr
    };
}


async function assertManagedDiscordTargetsClosedForSourceUpdate() {
    const ownershipStates =
        getManagedUninstallStates();

    const managedStates =
        ownershipStates.filter(
            state =>
                state.state === "managed" &&
                state.eligible === true
        );

    if (managedStates.length === 0) {
        return {
            managedTargets: [],
            closedTargets: []
        };
    }

    const installs =
        detectDiscordInstalls();

    const closedTargets = [];

    for (const state of managedStates) {
        const discord =
            installs.find(
                install =>
                    install.name === state.name
            );

        if (!discord) {
            throw new Error(
                `Managed Discord ${state.name} is no longer detected. Refusing source update until its target state can be verified.`
            );
        }

        const runningState =
            await getDiscordRunningState(
                discord
            );

        if (runningState.running) {
            throw new Error(
                `Fully quit Discord ${discord.name} before updating managed Vencord. Closing the Discord window is not enough. Right-click the Discord icon in the system tray and choose Quit Discord, then try again.`
            );
        }

        closedTargets.push(
            discord.name
        );
    }

    return {
        managedTargets:
            managedStates.map(
                state => state.name
            ),
        closedTargets
    };
}


async function replaceManagedVencordSource({ repair = false, identity = null } = {}) {
    const paths =
        getManagedPaths();

    if (!paths?.root) {
        throw new Error(
            "Managed workspace path is unavailable."
        );
    }

    recordManagedMaintenanceStage("checking-source-state");
    const before = repair ? {
        available: true, currentCommit: identity.commit, currentShortCommit: identity.commit.slice(0, 8),
        updateAvailable: true, sourceType: getManagedVencordState().sourceType
    } : await getManagedVencordUpdateState();

    if (
        before.available !== true ||
        !before.currentCommit
    ) {
        throw new Error(
            before.reason ??
            "Managed Vencord update state is unavailable."
        );
    }

    if (before.updateAvailable !== true) {
        return {
            ok: true,
            updated: false,
            alreadyCurrent: true,
            currentCommit:
                before.currentCommit,
            currentShortCommit:
                before.currentShortCommit,
            reason:
                "Managed Vencord is already current."
        };
    }

    const targetSafety =
        await assertManagedDiscordTargetsClosedForSourceUpdate();

    const timestamp =
        new Date()
            .toISOString()
            .replace(
                /[:.]/g,
                "-"
            );

    const updateRoot =
        join(
            paths.root,
            "source-updates",
            timestamp
        );

    const stagedManagedPath =
        join(
            updateRoot,
            "Vencord"
        );

    const updateManifestPath =
        join(
            updateRoot,
            "managed-vencord-update-manifest.json"
        );

    if (existsSync(updateRoot)) {
        throw new Error(
            `Refusing managed Vencord update because staging path already exists: ${updateRoot}`
        );
    }

    mkdirSync(
        updateRoot,
        {
            recursive: true
        }
    );

    recordManagedMaintenanceStage("acquiring-source", { updateRoot, repair, commit: repair ? before.currentCommit : "upstream-main" });
    const acquisition = await acquireVencordSourceArchiveToStaging({ commit: repair ? before.currentCommit : null });

    if (
        acquisition?.ok !== true ||
        acquisition?.state !== "staged" ||
        !/^[0-9a-f]{40}$/.test(
            acquisition.commit ?? ""
        )
    ) {
        throw new Error(
            acquisition?.reason ??
            "Trusted Vencord update source acquisition did not complete."
        );
    }

    if (
        !repair && acquisition.commit ===
        before.currentCommit &&
        before.policyRefreshRequired !== true
    ) {
        return {
            ok: true,
            updated: false,
            alreadyCurrent: true,
            currentCommit:
                before.currentCommit,
            currentShortCommit:
                before.currentShortCommit,
            reason:
                "The trusted source resolved to the commit already installed and the managed update policy is already applied."
        };
    }

    recordManagedMaintenanceStage("copying-official-source", { stagedManagedPath });
    cpSync(
        acquisition.stagedSourceRoot,
        stagedManagedPath,
        {
            recursive: true,
            force: false,
            errorOnExist: true
        }
    );

    const officialSourceManifest =
        getBackupFileManifest(
            acquisition.stagedSourceRoot
        );

    const stagedOfficialManifest =
        getBackupFileManifest(
            stagedManagedPath
        );

    const sourceCopyVerification =
        verifyBackupFileManifests(
            officialSourceManifest,
            stagedOfficialManifest
        );

    if (!sourceCopyVerification.verified) {
        throw new Error(
            `Staged Vencord update source copy verification failed: ${sourceCopyVerification.reason}`
        );
    }

    recordManagedMaintenanceStage("applying-customizations", { stagedManagedPath, commit: acquisition.commit });
    applySourceOverridesToStagedSource(
        stagedManagedPath,
        acquisition.commit
    );

    recordManagedMaintenanceStage("preserving-user-source-changes", { stagedManagedPath });
    const sourcePreservation = await preserveManagedSourceChanges(paths.vencord, stagedManagedPath, before.currentCommit);
    const preservedSourceFiles = [...new Set([...sourcePreservation.files, ...Object.keys(BUNDLE_POLICY.overrides.files)])].map(path => {
        const file = join(stagedManagedPath, path);
        return { path, size: statSync(file).size, sha256: getFileSha256(file) };
    });
    const currentUserPluginsPath =
        join(
            paths.vencord,
            "src",
            "userplugins"
        );

    const stagedUserPluginsPath =
        join(
            stagedManagedPath,
            "src",
            "userplugins"
        );

    const userPluginPreservation =
        copyDirectoryContentsVerified(
            currentUserPluginsPath,
            stagedUserPluginsPath,
            "managed userplugins"
        );

    if (repair) restoreMissingBundledFilesForRepair(stagedManagedPath);
    recordManagedMaintenanceStage("verifying-staged-plugins", { stagedManagedPath });
    const bundledPlugins =
        ensureBundledPluginsInStagedSource(
            stagedManagedPath
        );

    recordManagedMaintenanceStage("preparing-plugin-dependency", { stagedManagedPath });
    const dependency =
        await installRequiredDependencyAtSource(
            stagedManagedPath
        );

    const build =
        await buildVencordAtSource(
            stagedManagedPath,
            acquisition.commit
        );

    recordManagedMaintenanceStage("verifying-staged-customizations", { stagedManagedPath });
    verifyPreservedSourceFiles(stagedManagedPath, preservedSourceFiles);

    const stagedUserPluginManifest =
        existsSync(stagedUserPluginsPath)
            ? getBackupFileManifest(
                stagedUserPluginsPath
            )
            : [];

    if (
        userPluginPreservation.copied &&
        userPluginPreservation.sourceManifest
    ) {
        const preservedPaths =
            new Map(
                stagedUserPluginManifest.map(
                    file => [
                        file.path,
                        file
                    ]
                )
            );

        for (
            const originalFile of
            userPluginPreservation.sourceManifest
        ) {
            const stagedFile =
                preservedPaths.get(
                    originalFile.path
                );

            if (
                !stagedFile ||
                stagedFile.size !== originalFile.size ||
                stagedFile.sha256 !== originalFile.sha256
            ) {
                throw new Error(
                    `Managed userplugin preservation changed during staged update build: ${originalFile.path}`
                );
            }
        }
    }

    const updateManifest = {
        schemaVersion: 1,
        preparedAt:
            new Date().toISOString(),
        repository:
            VENCORD_GITHUB_REPOSITORY,
        fromCommit:
            before.currentCommit,
        toCommit:
            acquisition.commit,
        fromSourceType:
            before.sourceType ?? null,
        acquisitionManifestPath:
            acquisition.manifestPath,
        stagedManagedPath,
        liveManagedPath:
            paths.vencord,
        userPlugins: {
            copied:
                userPluginPreservation.copied,
            fileCount:
                userPluginPreservation.fileCount,
            totalBytes:
                userPluginPreservation.totalBytes
        },
        bundledPlugins,
        preservedSourceFiles: sourcePreservation.files,
        preservedSourceManifest: preservedSourceFiles,
        operation: repair ? "repair" : "update",
        dependency: {
            name:
                dependency.dependency,
            packageManager:
                dependency.packageManager
        },
        build: {
            packageManager:
                build.packageManager,
            artifactCount:
                build.buildState.files.length,
            nativeUpdaterDisabled:
                build.updaterPolicy
                    ?.updaterDisabled === true
        },
        managedDiscordTargets:
            targetSafety.managedTargets,
        activated:
            false,
        rollbackBackupPath:
            null
    };

    writeFileSync(
        updateManifestPath,
        JSON.stringify(
            updateManifest,
            null,
            2
        ),
        "utf8"
    );

    writeManagedVencordSourceMetadata(
        stagedManagedPath,
        {
            commit:
                acquisition.commit,
            acquisitionManifestPath:
                acquisition.manifestPath,
            updateManifestPath,
            customizationBases: Object.fromEntries(planSourceOverrides(acquisition.stagedSourceRoot, getInstallerResourceDirectory("sourceOverrides").path, BUNDLE_POLICY).map(plan => [plan.rel, plan.output]))
        }
    );

    recordManagedMaintenanceStage("verifying-before-activation", { stagedManagedPath });
    const beforeSwap = repair ? { available: true, currentCommit: (await getManagedRepairSourceIdentity()).commit } : await getManagedVencordUpdateState();
    if (!verifyBackupFileManifests(sourcePreservation.manifest, getMaintenanceSourceManifest(paths.vencord)).verified)
        throw new Error("Managed source or user plugins changed during staging. Activation was refused; the existing installation and staged build were kept.");

    if (
        beforeSwap.available !== true ||
        beforeSwap.currentCommit !==
        before.currentCommit
    ) {
        throw new Error(
            "Managed Vencord changed while the update was being prepared. The staged build was kept, but activation was refused."
        );
    }

    await assertManagedDiscordTargetsClosedForSourceUpdate();

    const backupPath =
        join(
            paths.root,
            `Vencord-update-backup-${timestamp}`
        );

    if (existsSync(backupPath)) {
        throw new Error(
            `Refusing update activation because rollback path already exists: ${backupPath}`
        );
    }

    let oldMoved = false;
    let newActivated = false;
    let failedActivationPath = null;

    const rollback = originalError => {
        const rollbackErrors = [];

        if (
            newActivated &&
            existsSync(paths.vencord)
        ) {
            failedActivationPath =
                join(
                    paths.root,
                    `Vencord-failed-update-${timestamp}`
                );

            try {
                if (existsSync(failedActivationPath)) {
                    throw new Error(
                        `Failed-update quarantine path already exists: ${failedActivationPath}`
                    );
                }

                renameSync(
                    paths.vencord,
                    failedActivationPath
                );
            } catch (error) {
                rollbackErrors.push(
                    `Could not quarantine failed update: ${error?.message ?? error}`
                );
            }
        }

        if (
            oldMoved &&
            existsSync(backupPath) &&
            !existsSync(paths.vencord)
        ) {
            try {
                renameSync(
                    backupPath,
                    paths.vencord
                );
            } catch (error) {
                rollbackErrors.push(
                    `Could not restore rollback backup: ${error?.message ?? error}`
                );
            }
        }

        const rollbackSuffix =
            rollbackErrors.length > 0
                ? ` Rollback also reported: ${rollbackErrors.join(" ")}`
                : oldMoved
                    ? " Previous managed Vencord was restored from the rollback backup."
                    : " Existing managed Vencord was not replaced.";

        throw new Error(
            `${originalError?.message ?? originalError}${rollbackSuffix}`
        );
    };

    try {
        recordManagedMaintenanceStage("activating-verified-source", { stagedManagedPath, backupPath });
        if (existsSync(paths.vencord)) {
            renameSync(paths.vencord, backupPath);
            oldMoved = true;
        }

        renameSync(
            stagedManagedPath,
            paths.vencord
        );
        newActivated = true;

        const activatedState =
            getManagedVencordState();

        if (
            activatedState.state !== "repository" ||
            activatedState.sourceType !== "archive"
        ) {
            throw new Error(
                `Activated Vencord source failed verification (state: ${activatedState.state}, sourceType: ${activatedState.sourceType ?? "unknown"}).`
            );
        }

        const activatedMetadata =
            readManagedVencordSourceMetadata(
                paths.vencord
            );

        if (
            !activatedMetadata.available ||
            activatedMetadata.commit !==
            acquisition.commit
        ) {
            throw new Error(
                "Activated Vencord source commit metadata does not match the staged update commit."
            );
        }

        const activatedBuildState =
            getManagedBuildState();

        verifyPreservedSourceFiles(paths.vencord, preservedSourceFiles);

        if (
            activatedBuildState.state !== "built" ||
            activatedBuildState.complete !== true
        ) {
            throw new Error(
                "Activated Vencord source is missing required build artifacts."
            );
        }

        const activatedUpdaterPolicy =
            getVencordUpdaterBuildPolicyAtSource(
                paths.vencord
            );

        if (
            activatedUpdaterPolicy.available !== true ||
            activatedUpdaterPolicy.updaterDisabled !== true
        ) {
            throw new Error(
                activatedUpdaterPolicy.reason ??
                "Activated managed Vencord build did not disable the native Vencord updater."
            );
        }

        if (
            userPluginPreservation.copied &&
            userPluginPreservation.sourceManifest
        ) {
            const activatedUserPlugins =
                getBackupFileManifest(
                    join(
                        paths.vencord,
                        "src",
                        "userplugins"
                    )
                );

            const activatedMap =
                new Map(
                    activatedUserPlugins.map(
                        file => [file.path, file]
                    )
                );

            for (
                const originalFile of
                userPluginPreservation.sourceManifest
            ) {
                const activatedFile =
                    activatedMap.get(
                        originalFile.path
                    );

                if (
                    !activatedFile ||
                    activatedFile.size !== originalFile.size ||
                    activatedFile.sha256 !== originalFile.sha256
                ) {
                    throw new Error(
                        `Activated managed Vencord did not preserve userplugin file: ${originalFile.path}`
                    );
                }
            }
        }

        if (targetSafety.managedTargets.length > 0) {
            const postOwnership =
                getManagedUninstallStates();

            for (
                const targetName of
                targetSafety.managedTargets
            ) {
                const state =
                    postOwnership.find(
                        candidate =>
                            candidate.name === targetName
                    );

                if (
                    state?.state !== "managed" ||
                    state?.eligible !== true
                ) {
                    throw new Error(
                        `Discord ${targetName} no longer verifies as managed after Vencord source activation.`
                    );
                }
            }
        }

        updateManifest.activated = true;
        updateManifest.activatedAt =
            new Date().toISOString();
        updateManifest.rollbackBackupPath =
            oldMoved ? backupPath : null;

        writeFileSync(
            updateManifestPath,
            JSON.stringify(
                updateManifest,
                null,
                2
            ),
            "utf8"
        );

        const finalState = repair ? { currentCommit: acquisition.commit, sourceType: "archive" } : await getManagedVencordUpdateState();

        return {
            ok: true,
            updated: true,
            fromCommit:
                before.currentCommit,
            fromShortCommit:
                before.currentShortCommit,
            toCommit:
                acquisition.commit,
            toShortCommit:
                acquisition.commit.slice(0, 8),
            sourceType:
                "archive",
            backupPath: oldMoved ? backupPath : null,
            updateManifestPath,
            acquisitionManifestPath:
                acquisition.manifestPath,
            managedDiscordTargets:
                targetSafety.managedTargets,
            policyRefreshApplied:
                before.policyRefreshRequired === true,
            nativeUpdaterDisabled: true,
            finalState,
            reason:
                before.currentCommit === acquisition.commit
                    ? "Managed Vencord was rebuilt from the trusted current commit with Vencord's native updater disabled, then activated with a rollback backup kept on disk."
                    : "Managed Vencord was downloaded from a trusted immutable commit archive, prepared and built in isolation with Vencord's native updater disabled, then activated with a rollback backup kept on disk."
        };
    } catch (error) {
        rollback(error);
    }
}


function getManagedVencordBuildEnvironment() {
    const state =
        getManagedVencordState();

    if (
        state.state !== "repository"
    ) {
        throw new Error(
            `Managed Vencord build environment is unavailable because source state is "${state.state}".`
        );
    }

    if (
        state.sourceType !== "archive"
    ) {
        return {
            env: {},
            sourceType:
                state.sourceType ??
                "git",
            archiveMetadata:
                null
        };
    }

    const metadata =
        getManagedArchiveVencordBuildMetadata();

    if (!metadata.available) {
        throw new Error(
            metadata.reason ??
            "Archive Vencord build metadata is unavailable."
        );
    }

    return {
        env: {
            VENCORD_HASH:
                metadata.shortCommit,
            VENCORD_REMOTE:
                metadata.repository
        },
        sourceType:
            "archive",
        archiveMetadata:
            metadata
    };
}


async function buildManagedVencord() {
    const paths =
        getManagedPaths();

    if (!paths) {
        throw new Error(
            "Unable to determine managed workspace."
        );
    }

    const vencordState =
        getManagedVencordState();

    if (vencordState.state !== "repository") {
        throw new Error(
            `Refusing build: managed Vencord state is "${vencordState.state}".`
        );
    }

    const verification =
        await verifyManagedPackageManager();

    if (!verification?.ok) {
        throw new Error(
            "Required pnpm verification did not complete."
        );
    }

    const runner =
        verification.runner;

    if (
        !runner ||
        typeof runner.toolName !== "string"
    ) {
        throw new Error(
            "Verified pnpm runner is unavailable."
        );
    }

    const buildEnvironment =
        getManagedVencordBuildEnvironment();

    // Hydrate the complete Vencord workspace explicitly before building.
    // pnpm 11 can otherwise perform its own hidden pre-run install, which
    // is unsafe in Electron because there is no interactive TTY. Using a
    // dedicated install step with CI=true lets pnpm purge/relink an
    // incompatible node_modules directory without prompting, while
    // --frozen-lockfile guarantees this preparation cannot rewrite the
    // managed lockfile. This also restores missing build-time packages
    // such as esbuild before the Vencord build script starts.
    const dependencyInstall =
        await runResolvedBuildTool(
            runner.toolName,
            [
                ...runner.argsPrefix,
                "install",
                "--frozen-lockfile"
            ],
            {
                cwd: paths.vencord,
                windowsHide: true,
                timeout: 600000,
                env: {
                    ...buildEnvironment.env,
                    CI: "true",
                    pnpm_config_verify_deps_before_run:
                        "false"
                }
            }
        );

    const result =
        await runResolvedBuildTool(
            runner.toolName,
            [
                ...runner.argsPrefix,
                // Keep the direct build command non-interactive too. The
                // explicit install above is authoritative; this flag is a
                // secondary guard if pnpm needs to reconcile modules.
                "--config.confirmModulesPurge=false",
                "run",
                "build",
                "--",
                "--disable-updater"
            ],
            {
                cwd: paths.vencord,
                windowsHide: true,
                timeout: 600000,
                env: {
                    ...buildEnvironment.env,

                    // Do not let pnpm 11 launch a second implicit install
                    // before the build; dependencies were just prepared
                    // explicitly above.
                    pnpm_config_verify_deps_before_run:
                        "false"
                }
            }
        );

    const updaterPolicy =
        getVencordUpdaterBuildPolicyAtSource(
            paths.vencord
        );

    if (
        updaterPolicy.available !== true ||
        updaterPolicy.updaterDisabled !== true
    ) {
        throw new Error(
            updaterPolicy.reason ??
            "Managed Vencord build did not disable the native Vencord updater."
        );
    }

    return {
        ok: true,
        packageManager:
            verification.packageManager,
        packageManagerSource:
            runner.source,
        updaterPolicy,
        sourceType:
            buildEnvironment.sourceType,
        buildGitMetadata:
            buildEnvironment.archiveMetadata
                ? {
                    hash:
                        buildEnvironment.archiveMetadata
                            .shortCommit,
                    remote:
                        buildEnvironment.archiveMetadata
                            .repository,
                    promotionManifestPath:
                        buildEnvironment.archiveMetadata
                            .promotionManifestPath
                }
                : null,
        dependencyInstallOutput:
            dependencyInstall.stdout,
        dependencyInstallWarnings:
            dependencyInstall.stderr,
        output:
            result.stdout,
        warnings:
            result.stderr
    };
}

function assertVencordInstallerTargetUsable(
    discordPath,
    action
) {
    const discord =
        detectDiscordInstalls()
            .find(install =>
                normalize(
                    install.path
                ).toLowerCase() ===
                normalize(
                    discordPath
                ).toLowerCase()
            );

    if (!discord) {
        throw new Error(
            `Refusing Vencord ${action}: the selected Discord installation is no longer detected.`
        );
    }

    const detail =
        inspectDiscordInstallPatch(
            discord
        );

    if (
        detail.mutationSafe !==
        true
    ) {
        throw new Error(
            `Refusing Vencord ${action}: ${detail.mutationBlockReason ?? detail.reason ?? "the Discord app folder selected by the Vencord installer is not safe to modify."}`
        );
    }

    return detail;
}


function runManagedVencordInstallerAction(
    paths,
    installerScript,
    action,
    discordPath
) {
    const allowedActions =
        new Set([
            "install",
            "uninstall",
            "repair"
        ]);

    if (!allowedActions.has(action)) {
        return Promise.reject(
            new Error(
                `Unsupported Vencord installer action: ${action}`
            )
        );
    }

    try {
        assertVencordInstallerTargetUsable(
            discordPath,
            action
        );
    } catch (error) {
        return Promise.reject(
            error
        );
    }

    return new Promise((resolve, reject) => {
        execResolvedBuildTool(
            "node",
            [
                installerScript,
                "--",
                `--${action}`,
                "-location",
                discordPath
            ],
            {
                cwd: paths.vencord,
                windowsHide: true,
                timeout: 300000
            },
            (error, stdout, stderr) => {
                const result = {
                    action,
                    stdout:
                        stdout?.trim?.() ?? "",
                    stderr:
                        stderr?.trim?.() ?? ""
                };

                if (error) {
                    const message = [
                        result.stderr,
                        result.stdout,
                        error.message
                    ]
                        .filter(Boolean)
                        .join("\n\n");

                    const wrapped =
                        new Error(
                            message ||
                            `Vencord ${action} command failed.`
                        );

                    wrapped.installerResult =
                        result;

                    reject(wrapped);

                    return;
                }

                resolve(result);
            }
        );
    });
}


function getSelectedDiscordPatchDetail(
    discordName
) {
    return getDiscordPatchDetails()
        .find(
            detail =>
                detail.name === discordName
        ) ?? null;
}


async function ensureDiscordFullyClosedForMigration(
    discord
) {
    const runningState =
        await getDiscordRunningState(
            discord
        );

    if (runningState.running) {
        throw new Error(
            "Fully quit Discord before continuing. Closing the Discord window is not enough. Right-click the Discord icon in the system tray and choose Quit Discord, then try again."
        );
    }

    return runningState;
}


async function ensureMigrationFailureEndsUnpatched({
    paths,
    installerScript,
    discord,
    managedPatcherPath
}) {
    const currentDetail =
        getSelectedDiscordPatchDetail(
            discord.name
        );

    if (
        currentDetail?.state === "unpatched" ||
        currentDetail?.detailState === "unpatched"
    ) {
        return {
            state: "unpatched",
            cleanupAttempted: false,
            cleanupSucceeded: true
        };
    }

    if (
        currentDetail?.detailState === "vencord" &&
        currentDetail?.pointsToManaged === true
    ) {
        await ensureDiscordFullyClosedForMigration(
            discord
        );

        let cleanupResult;

        try {
            cleanupResult =
                await runManagedVencordInstallerAction(
                    paths,
                    installerScript,
                    "uninstall",
                    discord.path
                );
        } catch (error) {
            return {
                state: "cleanup-failed",
                cleanupAttempted: true,
                cleanupSucceeded: false,
                managedPatcherPath,
                reason:
                    error?.message ??
                    "Managed Vencord cleanup failed."
            };
        }

        const postCleanupDetail =
            getSelectedDiscordPatchDetail(
                discord.name
            );

        if (
            postCleanupDetail?.state === "unpatched" ||
            postCleanupDetail?.detailState === "unpatched"
        ) {
            return {
                state: "unpatched",
                cleanupAttempted: true,
                cleanupSucceeded: true,
                cleanupResult
            };
        }

        return {
            state: "cleanup-verification-failed",
            cleanupAttempted: true,
            cleanupSucceeded: false,
            cleanupResult,
            reason:
                postCleanupDetail?.patcherPath
                    ? `Cleanup left Discord pointing to "${postCleanupDetail.patcherPath}".`
                    : postCleanupDetail?.reason ??
                    "Cleanup did not return Discord to a verified unpatched state."
        };
    }

    return {
        state: "unexpected-patch-state",
        cleanupAttempted: false,
        cleanupSucceeded: false,
        reason:
            currentDetail?.patcherPath
                ? `Discord now points to an unexpected Vencord patcher: "${currentDetail.patcherPath}". Refusing to remove it automatically.`
                : currentDetail?.reason ??
                "Discord entered an unexpected patch state. Refusing additional automatic changes."
    };
}


async function migrateExternalVencord(
    discordName
) {
    if (
        typeof discordName !== "string" ||
        discordName.trim().length === 0
    ) {
        throw new Error(
            "Migration requires a detected Discord installation."
        );
    }

    const requestedName =
        discordName.trim();

    // The read-only planner is the first gate. The migration executor is
    // only allowed to run when every prerequisite has already been met
    // and migration is literally the next planned action.
    const plan =
        await getManagedInstallPlan(
            requestedName
        );

    if (
        plan?.status !== "migration-required" ||
        plan?.nextAction?.id !== "migrate-external-vencord" ||
        !Array.isArray(plan?.blockers) ||
        plan.blockers.length !== 0
    ) {
        const blockerText =
            Array.isArray(plan?.blockers) &&
                plan.blockers.length > 0
                ? plan.blockers
                    .map(blocker =>
                        blocker.message ??
                        blocker.id
                    )
                    .filter(Boolean)
                    .join("; ")
                : null;

        throw new Error(
            blockerText
                ? `Refusing migration: ${blockerText}`
                : `Refusing migration: the current installation plan is "${plan?.status ?? "unavailable"}" and migration is not the next allowed action.`
        );
    }

    const paths =
        getManagedPaths();

    if (!paths) {
        throw new Error(
            "Refusing migration: managed workspace path is unavailable."
        );
    }

    const vencordState =
        getManagedVencordState();

    if (vencordState.state !== "repository") {
        throw new Error(
            `Refusing migration: managed Vencord state is "${vencordState.state}".`
        );
    }

    const buildState =
        getManagedBuildState();

    if (buildState.state !== "built") {
        throw new Error(
            `Refusing migration: managed Vencord build state is "${buildState.state}".`
        );
    }

    const installs =
        detectDiscordInstalls();

    const discord =
        installs.find(
            install =>
                install.name === requestedName
        );

    if (!discord) {
        throw new Error(
            `Refusing migration: Discord ${requestedName} installation was not found.`
        );
    }

    // Re-detect the external patch directly instead of trusting the
    // earlier planner snapshot.
    const initialDetail =
        getSelectedDiscordPatchDetail(
            discord.name
        );

    if (
        initialDetail?.detailState !== "vencord" ||
        initialDetail?.pointsToManaged === true ||
        typeof initialDetail?.patcherPath !== "string"
    ) {
        throw new Error(
            `Refusing migration: Discord ${discord.name} is no longer a verified external Vencord installation.`
        );
    }

    const originalExternalPatcherPath =
        initialDetail.patcherPath;

    // Re-hash the persistent backup and compare it with the live Vencord
    // user data immediately before any Discord mutation.
    const backupState =
        getExternalVencordBackupState(
            discord.name
        );

    if (
        backupState?.canUseForMigration !== true ||
        backupState?.verified !== true
    ) {
        throw new Error(
            backupState?.reason
                ? `Refusing migration: ${backupState.reason}`
                : "Refusing migration: a current verified Vencord user-data backup is required."
        );
    }

    const migrationState =
        getExternalVencordMigrationState(
            discord.name
        );

    if (
        migrationState?.migrationRequired !== true ||
        migrationState?.canMigrate !== true
    ) {
        throw new Error(
            migrationState?.reason
                ? `Refusing migration: ${migrationState.reason}`
                : "Refusing migration: the existing Vencord installation is no longer eligible."
        );
    }

    await ensureDiscordFullyClosedForMigration(
        discord
    );

    // Re-check both the external patch target and backup one final time
    // after the process guard. If either changed, nothing is touched.
    const finalPreflightDetail =
        getSelectedDiscordPatchDetail(
            discord.name
        );

    if (
        finalPreflightDetail?.detailState !== "vencord" ||
        finalPreflightDetail?.pointsToManaged === true ||
        typeof finalPreflightDetail?.patcherPath !== "string" ||
        normalize(
            finalPreflightDetail.patcherPath
        ).toLowerCase() !==
        normalize(
            originalExternalPatcherPath
        ).toLowerCase()
    ) {
        throw new Error(
            "Refusing migration: the existing Vencord patch changed after preflight. No Discord changes were made."
        );
    }

    const finalBackupState =
        getExternalVencordBackupState(
            discord.name
        );

    if (
        finalBackupState?.canUseForMigration !== true ||
        finalBackupState?.verified !== true
    ) {
        throw new Error(
            finalBackupState?.reason
                ? `Refusing migration: ${finalBackupState.reason}`
                : "Refusing migration: the verified Vencord backup is no longer current. No Discord changes were made."
        );
    }

    const installerScript =
        join(
            paths.vencord,
            "scripts",
            "runInstaller.mjs"
        );

    const expectedInstallerScript =
        join(
            paths.vencord,
            "scripts",
            "runInstaller.mjs"
        );

    if (
        normalize(
            installerScript
        ).toLowerCase() !==
        normalize(
            expectedInstallerScript
        ).toLowerCase()
    ) {
        throw new Error(
            "Refusing migration: installer script failed safety validation."
        );
    }

    if (!existsSync(installerScript)) {
        throw new Error(
            "Refusing migration: managed Vencord installer script was not found."
        );
    }

    const managedPatcherPath =
        join(
            paths.vencord,
            "dist",
            "patcher.js"
        );

    if (
        !existsSync(managedPatcherPath) ||
        statSync(managedPatcherPath).size <= 0
    ) {
        throw new Error(
            "Refusing migration: managed patcher.js is missing or empty."
        );
    }

    let uninstallResult;

    try {
        uninstallResult =
            await runManagedVencordInstallerAction(
                paths,
                installerScript,
                "uninstall",
                discord.path
            );
    } catch (error) {
        throw new Error(
            `Existing Vencord removal failed before managed installation began. Discord was not intentionally repatched. ${error?.message ?? ""}`.trim()
        );
    }

    const postUninstallDetail =
        getSelectedDiscordPatchDetail(
            discord.name
        );

    if (
        postUninstallDetail?.state !== "unpatched" &&
        postUninstallDetail?.detailState !== "unpatched"
    ) {
        throw new Error(
            postUninstallDetail?.patcherPath
                ? `Migration stopped after removal verification failed: Discord ${discord.name} points to "${postUninstallDetail.patcherPath}". Managed installation was not attempted.`
                : `Migration stopped after removal verification failed: ${postUninstallDetail?.reason ?? `Discord ${discord.name} did not become unpatched.`} Managed installation was not attempted.`
        );
    }

    // The user could launch Discord in the tiny gap between removal and
    // installation. Guard again rather than assuming it stayed closed.
    await ensureDiscordFullyClosedForMigration(
        discord
    );

    // The user-data backup is intentionally left untouched throughout
    // migration. The live %APPDATA%\Vencord data is also never deleted,
    // moved, or rewritten by this executor.
    let installResult;

    try {
        installResult =
            await runManagedVencordInstallerAction(
                paths,
                installerScript,
                "install",
                discord.path
            );
    } catch (error) {
        const cleanup =
            await ensureMigrationFailureEndsUnpatched({
                paths,
                installerScript,
                discord,
                managedPatcherPath
            });

        const cleanupText =
            cleanup.cleanupSucceeded
                ? " Discord was verified unpatched after the failed managed installation."
                : ` Automatic cleanup could not safely guarantee an unpatched state: ${cleanup.reason ?? cleanup.state}.`;

        throw new Error(
            `Existing Vencord was removed, but managed Vencord installation failed.${cleanupText} The verified migration backup remains at ${finalBackupState.backupDirectory ?? "the managed migration backup folder"}. ${error?.message ?? ""}`.trim()
        );
    }

    const postInstallDetail =
        getSelectedDiscordPatchDetail(
            discord.name
        );

    if (
        postInstallDetail?.detailState !== "vencord" ||
        postInstallDetail?.pointsToManaged !== true ||
        typeof postInstallDetail?.patcherPath !== "string" ||
        normalize(
            postInstallDetail.patcherPath
        ).toLowerCase() !==
        normalize(
            managedPatcherPath
        ).toLowerCase()
    ) {
        const cleanup =
            await ensureMigrationFailureEndsUnpatched({
                paths,
                installerScript,
                discord,
                managedPatcherPath
            });

        const cleanupText =
            cleanup.cleanupSucceeded
                ? " Discord was returned to a verified unpatched state."
                : ` Automatic cleanup could not safely guarantee an unpatched state: ${cleanup.reason ?? cleanup.state}.`;

        throw new Error(
            `Managed Vencord installation completed but verification failed.${cleanupText} The verified migration backup remains at ${finalBackupState.backupDirectory ?? "the managed migration backup folder"}.`
        );
    }

    return {
        ok: true,
        state: "managed",
        name:
            discord.name,
        location:
            discord.path,
        previousExternalPatcherPath:
            originalExternalPatcherPath,
        managedPatcherPath,
        verifiedPatcherPath:
            postInstallDetail.patcherPath,
        backup: {
            state:
                finalBackupState.state,
            verified:
                finalBackupState.verified === true,
            backupRequired:
                finalBackupState.backupRequired !== false,
            backupDirectory:
                finalBackupState.backupDirectory ?? null,
            manifestPath:
                finalBackupState.manifestPath ?? null,
            sourceDataDir:
                finalBackupState.sourceDataDir ??
                migrationState.selectedDataDir ??
                null,
            fileCount:
                finalBackupState.fileCount ?? 0,
            totalBytes:
                finalBackupState.totalBytes ?? 0
        },
        uninstall: {
            output:
                uninstallResult.stdout,
            warnings:
                uninstallResult.stderr
        },
        install: {
            output:
                installResult.stdout,
            warnings:
                installResult.stderr
        },
        userDataPreserved: true,
        reason:
            "Existing Vencord was replaced with the managed Vencord build. The live Vencord user-data directory and verified migration backup were preserved."
    };
}


async function uninstallManagedVencord(discordName) {
    if (
        typeof discordName !== "string" ||
        discordName.length === 0
    ) {
        throw new Error(
            "Uninstall requires a detected Discord installation."
        );
    }

    const paths =
        getManagedPaths();

    if (!paths) {
        throw new Error(
            "Unable to determine managed workspace."
        );
    }

    const vencordState =
        getManagedVencordState();

    if (vencordState.state !== "repository") {
        throw new Error(
            `Refusing uninstall: managed Vencord state is "${vencordState.state}".`
        );
    }

    const installs =
        detectDiscordInstalls();

    const discord =
        installs.find(
            install =>
                install.name === discordName
        );

    if (!discord) {
        throw new Error(
            `Discord ${discordName} installation was not found.`
        );
    }

    const uninstallStates =
        getManagedUninstallStates();

    const uninstallState =
        uninstallStates.find(
            state =>
                state.name === discord.name
        );

    if (
        !uninstallState ||
        uninstallState.state !== "managed" ||
        uninstallState.eligible !== true
    ) {
        const stateLabel =
            uninstallState?.state ??
            "unknown";

        const reason =
            uninstallState?.reason
                ? ` ${uninstallState.reason}`
                : "";

        throw new Error(
            `Refusing uninstall: Discord ${discord.name} is not owned by Maru Vencord Installer (state: ${stateLabel}).${reason}`
        );
    }

    const runningState =
        await getDiscordRunningState(
            discord
        );

    if (runningState.running) {
        throw new Error(
            "Fully quit Discord before continuing. Closing the Discord window is not enough. Right-click the Discord icon in the system tray and choose Quit Discord, then try again."
        );
    }

    const installerScript =
        join(
            paths.vencord,
            "scripts",
            "runInstaller.mjs"
        );

    const expectedInstallerScript =
        join(
            paths.vencord,
            "scripts",
            "runInstaller.mjs"
        );

    if (
        normalize(
            installerScript
        ).toLowerCase() !==
        normalize(
            expectedInstallerScript
        ).toLowerCase()
    ) {
        throw new Error(
            "Refusing uninstall: installer script failed safety validation."
        );
    }

    if (!existsSync(installerScript)) {
        throw new Error(
            "Managed Vencord installer script was not found."
        );
    }

    return new Promise((resolve, reject) => {
        execResolvedBuildTool(
            "node",
            [
                installerScript,
                "--",
                "--uninstall",
                "-location",
                discord.path
            ],
            {
                cwd: paths.vencord,
                windowsHide: true,
                timeout: 300000
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject(
                        new Error(
                            stderr.trim() ||
                            stdout.trim() ||
                            error.message
                        )
                    );

                    return;
                }

                const postStates =
                    getManagedUninstallStates();

                const postState =
                    postStates.find(
                        state =>
                            state.name === discord.name
                    );

                if (
                    postState?.state !== "unpatched" ||
                    postState?.eligible !== false
                ) {
                    const verificationFailure =
                        postState?.state === "managed"
                            ? `Uninstall verification failed: Discord ${discord.name} still points to the managed Vencord patcher.`
                            : postState?.state === "external"
                                ? `Uninstall verification failed: Discord ${discord.name} now points to a different Vencord source.`
                                : postState?.reason
                                    ? `Uninstall verification failed: ${postState.reason}`
                                    : `Uninstall verification failed: Discord ${discord.name} did not become unpatched.`;

                    const capturedOutput = [
                        stdout.trim()
                            ? `Installer stdout:\n${stdout.trim()}`
                            : null,
                        stderr.trim()
                            ? `Installer stderr:\n${stderr.trim()}`
                            : null
                    ]
                        .filter(Boolean)
                        .join("\n\n");

                    reject(
                        new Error(
                            capturedOutput
                                ? `${verificationFailure}\n\n${capturedOutput}`
                                : `${verificationFailure}\n\nInstaller produced no captured stdout/stderr.`
                        )
                    );

                    return;
                }

                resolve({
                    ok: true,
                    name:
                        discord.name,
                    location:
                        discord.path,
                    previousPatcherPath:
                        uninstallState.patcherPath ??
                        null,
                    postState:
                        postState.state,
                    output:
                        stdout.trim(),
                    warnings:
                        stderr.trim()
                });
            }
        );
    });
}


async function repairManagedDiscordPatch(discordName) {
    if (
        typeof discordName !== "string" ||
        discordName.length === 0
    ) {
        throw new Error(
            "Repair requires a detected Discord installation."
        );
    }

    const paths =
        getManagedPaths();

    if (!paths) {
        throw new Error(
            "Unable to determine managed workspace."
        );
    }

    const vencordState =
        getManagedVencordState();

    if (vencordState.state !== "repository") {
        throw new Error(
            `Refusing repair: managed Vencord state is "${vencordState.state}".`
        );
    }

    const buildState =
        getManagedBuildState();

    if (buildState.state !== "built") {
        throw new Error(
            `Refusing repair: managed Vencord build state is "${buildState.state}".`
        );
    }

    const installs =
        detectDiscordInstalls();

    const discord =
        installs.find(
            install =>
                install.name === discordName
        );

    if (!discord) {
        throw new Error(
            `Discord ${discordName} installation was not found.`
        );
    }

    const uninstallStates =
        getManagedUninstallStates();

    const ownershipState =
        uninstallStates.find(
            state =>
                state.name === discord.name
        );

    if (
        !ownershipState ||
        ownershipState.state !== "managed" ||
        ownershipState.eligible !== true
    ) {
        const stateLabel =
            ownershipState?.state ??
            "unknown";

        const reason =
            ownershipState?.reason
                ? ` ${ownershipState.reason}`
                : "";

        throw new Error(
            `Refusing repair: Discord ${discord.name} is not owned by Maru Vencord Installer (state: ${stateLabel}).${reason}`
        );
    }

    const runningState =
        await getDiscordRunningState(
            discord
        );

    if (runningState.running) {
        throw new Error(
            "Fully quit Discord before continuing. Closing the Discord window is not enough. Right-click the Discord icon in the system tray and choose Quit Discord, then try again."
        );
    }

    const installerScript =
        join(
            paths.vencord,
            "scripts",
            "runInstaller.mjs"
        );

    const expectedInstallerScript =
        join(
            paths.vencord,
            "scripts",
            "runInstaller.mjs"
        );

    if (
        normalize(
            installerScript
        ).toLowerCase() !==
        normalize(
            expectedInstallerScript
        ).toLowerCase()
    ) {
        throw new Error(
            "Refusing repair: installer script failed safety validation."
        );
    }

    if (!existsSync(installerScript)) {
        throw new Error(
            "Managed Vencord installer script was not found."
        );
    }

    const managedPatcherPath =
        join(
            paths.vencord,
            "dist",
            "patcher.js"
        );

    if (
        !existsSync(managedPatcherPath) ||
        statSync(managedPatcherPath).size <= 0
    ) {
        throw new Error(
            "Refusing repair: managed patcher.js is missing or empty."
        );
    }

    return new Promise((resolve, reject) => {
        execResolvedBuildTool(
            "node",
            [
                installerScript,
                "--",
                "--repair",
                "-location",
                discord.path
            ],
            {
                cwd: paths.vencord,
                windowsHide: true,
                timeout: 300000
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject(
                        new Error(
                            stderr.trim() ||
                            stdout.trim() ||
                            error.message
                        )
                    );

                    return;
                }

                const postDetails =
                    getDiscordPatchDetails();

                const postDetail =
                    postDetails.find(
                        detail =>
                            detail.name === discord.name
                    );

                if (
                    postDetail?.detailState !== "vencord" ||
                    postDetail?.pointsToManaged !== true
                ) {
                    const verificationFailure =
                        postDetail?.patcherPath
                            ? `Repair verification failed: Discord ${discord.name} points to "${postDetail.patcherPath}".`
                            : postDetail?.reason
                                ? `Repair verification failed: ${postDetail.reason}`
                                : `Repair verification failed: managed patcher target was not detected for Discord ${discord.name}.`;

                    const capturedOutput = [
                        stdout.trim()
                            ? `Installer stdout:\n${stdout.trim()}`
                            : null,
                        stderr.trim()
                            ? `Installer stderr:\n${stderr.trim()}`
                            : null
                    ]
                        .filter(Boolean)
                        .join("\n\n");

                    reject(
                        new Error(
                            capturedOutput
                                ? `${verificationFailure}\n\n${capturedOutput}`
                                : `${verificationFailure}\n\nInstaller produced no captured stdout/stderr.`
                        )
                    );

                    return;
                }

                resolve({
                    ok: true,
                    name:
                        discord.name,
                    location:
                        discord.path,
                    managedPatcherPath,
                    verifiedPatcherPath:
                        postDetail.patcherPath,
                    output:
                        stdout.trim(),
                    warnings:
                        stderr.trim()
                });
            }
        );
    });
}


async function installManagedVencord(discordName) {
    if (
        typeof discordName !== "string" ||
        discordName.length === 0
    ) {
        throw new Error(
            "Install requires a detected Discord installation."
        );
    }

    const paths =
        getManagedPaths();

    if (!paths) {
        throw new Error(
            "Unable to determine managed workspace."
        );
    }

    const vencordState =
        getManagedVencordState();

    if (vencordState.state !== "repository") {
        throw new Error(
            `Refusing install: managed Vencord state is "${vencordState.state}".`
        );
    }

    const buildState =
        getManagedBuildState();

    if (buildState.state !== "built") {
        throw new Error(
            `Refusing install: managed Vencord build state is "${buildState.state}".`
        );
    }

    const installs =
        detectDiscordInstalls();

    const discord =
        installs.find(
            install =>
                install.name === discordName
        );

    if (!discord) {
        throw new Error(
            `Discord ${discordName} installation was not found.`
        );
    }

    const patchDetails =
        getDiscordPatchDetails();

    const patchDetail =
        patchDetails.find(
            detail =>
                detail.name === discord.name
        );

    if (!patchDetail) {
        throw new Error(
            `Refusing install: patch state for Discord ${discord.name} is unavailable.`
        );
    }

    if (
        patchDetail.detailState === "vencord" &&
        patchDetail.pointsToManaged === true
    ) {
        throw new Error(
            `Refusing install: Discord ${discord.name} already points to the managed Vencord patcher.`
        );
    }

    if (
        patchDetail.detailState === "vencord" &&
        patchDetail.pointsToManaged !== true
    ) {
        throw new Error(
            `Refusing install: Discord ${discord.name} is already patched with a different Vencord source.`
        );
    }

    if (
        patchDetail.state !== "unpatched" &&
        patchDetail.detailState !== "unpatched"
    ) {
        throw new Error(
            `Refusing install: Discord ${discord.name} is not in a verified unpatched state.`
        );
    }

    const runningState =
        await getDiscordRunningState(
            discord
        );

    if (runningState.running) {
        throw new Error(
            "Fully quit Discord before continuing. Closing the Discord window is not enough. Right-click the Discord icon in the system tray and choose Quit Discord, then try again."
        );
    }

    const installerScript =
        join(
            paths.vencord,
            "scripts",
            "runInstaller.mjs"
        );

    const expectedInstallerScript =
        join(
            paths.vencord,
            "scripts",
            "runInstaller.mjs"
        );

    if (
        normalize(
            installerScript
        ).toLowerCase() !==
        normalize(
            expectedInstallerScript
        ).toLowerCase()
    ) {
        throw new Error(
            "Refusing install: installer script failed safety validation."
        );
    }

    if (!existsSync(installerScript)) {
        throw new Error(
            "Managed Vencord installer script was not found."
        );
    }

    const managedPatcherPath =
        join(
            paths.vencord,
            "dist",
            "patcher.js"
        );

    if (
        !existsSync(managedPatcherPath) ||
        statSync(managedPatcherPath).size <= 0
    ) {
        throw new Error(
            "Refusing install: managed patcher.js is missing or empty."
        );
    }

    return new Promise((resolve, reject) => {
        execResolvedBuildTool(
            "node",
            [
                installerScript,
                "--",
                "--install",
                "-location",
                discord.path
            ],
            {
                cwd: paths.vencord,
                windowsHide: true,
                timeout: 300000
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject(
                        new Error(
                            stderr.trim() ||
                            stdout.trim() ||
                            error.message
                        )
                    );

                    return;
                }

                const postDetails =
                    getDiscordPatchDetails();

                const postDetail =
                    postDetails.find(
                        detail =>
                            detail.name === discord.name
                    );

                if (
                    postDetail?.detailState !== "vencord" ||
                    postDetail?.pointsToManaged !== true
                ) {
                    const verificationFailure =
                        postDetail?.patcherPath
                            ? `Install verification failed: Discord ${discord.name} points to "${postDetail.patcherPath}".`
                            : postDetail?.reason
                                ? `Install verification failed: ${postDetail.reason}`
                                : `Install verification failed: managed patcher target was not detected for Discord ${discord.name}.`;

                    const capturedOutput = [
                        stdout.trim()
                            ? `Installer stdout:\n${stdout.trim()}`
                            : null,
                        stderr.trim()
                            ? `Installer stderr:\n${stderr.trim()}`
                            : null
                    ]
                        .filter(Boolean)
                        .join("\n\n");

                    reject(
                        new Error(
                            capturedOutput
                                ? `${verificationFailure}\n\n${capturedOutput}`
                                : `${verificationFailure}\n\nInstaller produced no captured stdout/stderr.`
                        )
                    );

                    return;
                }

                resolve({
                    ok: true,
                    name:
                        discord.name,
                    location:
                        discord.path,
                    managedPatcherPath,
                    verifiedPatcherPath:
                        postDetail.patcherPath,
                    output:
                        stdout.trim(),
                    warnings:
                        stderr.trim()
                });
            }
        );
    });
}


function getChromeExecutablePath() {
    const candidates = [
        process.env.LOCALAPPDATA
            ? join(
                process.env.LOCALAPPDATA,
                "Google",
                "Chrome",
                "Application",
                "chrome.exe"
            )
            : null,
        process.env.PROGRAMFILES
            ? join(
                process.env.PROGRAMFILES,
                "Google",
                "Chrome",
                "Application",
                "chrome.exe"
            )
            : null,
        process.env["PROGRAMFILES(X86)"]
            ? join(
                process.env["PROGRAMFILES(X86)"],
                "Google",
                "Chrome",
                "Application",
                "chrome.exe"
            )
            : null
    ]
        .filter(Boolean);

    return (
        candidates.find(candidate =>
            existsSync(candidate)
        ) ?? null
    );
}


function validateBundledTwitchExtension() {
    const resource =
        getInstallerResourceDirectory(
            "twitchExtension"
        );

    if (
        !existsSync(
            resource.path
        ) ||
        !statSync(
            resource.path
        ).isDirectory()
    ) {
        throw new Error(
            `Bundled Twitch Presence extension folder was not found at ${resource.path}.`
        );
    }

    const requiredFiles =
        [...TWITCH_EXTENSION_FILES];

    const missingFiles =
        requiredFiles.filter(fileName => {
            const candidate =
                join(
                    resource.path,
                    fileName
                );

            return (
                !existsSync(candidate) ||
                !statSync(candidate).isFile()
            );
        });

    if (missingFiles.length > 0) {
        throw new Error(
            `Bundled Twitch Presence extension is incomplete. Missing: ${missingFiles.join(", ")}.`
        );
    }

    return {
        ...resource,
        requiredFiles
    };
}


function provisionManagedTwitchExtension() {
    const bundled =
        validateBundledTwitchExtension();

    const paths =
        getManagedPaths();

    if (
        !paths?.root ||
        !paths?.browserExtension
    ) {
        throw new Error(
            "Managed Twitch Presence extension path is unavailable."
        );
    }

    const managedExtensionPath =
        resolve(
            paths.browserExtension
        );

    if (
        !isPathInsideOrSame(
            paths.root,
            managedExtensionPath
        ) ||
        managedExtensionPath.toLowerCase() ===
        resolve(
            paths.root
        ).toLowerCase()
    ) {
        throw new Error(
            "Refusing Twitch Presence extension setup because the managed extension path failed containment validation."
        );
    }

    mkdirSync(
        dirname(
            managedExtensionPath
        ),
        {
            recursive: true
        }
    );

    if (
        existsSync(
            managedExtensionPath
        )
    ) {
        rmSync(
            managedExtensionPath,
            {
                recursive: true,
                force: true
            }
        );
    }

    cpSync(
        bundled.path,
        managedExtensionPath,
        {
            recursive: true,
            force: false,
            errorOnExist: true
        }
    );

    const bundledFiles =
        getBackupFileManifest(
            bundled.path
        );

    const managedFiles =
        getBackupFileManifest(
            managedExtensionPath
        );

    const verification =
        verifyBackupFileManifests(
            bundledFiles,
            managedFiles
        );

    if (!verification.verified) {
        throw new Error(
            `Managed Twitch Presence extension copy failed verification: ${verification.reason}`
        );
    }

    for (
        const fileName of
        bundled.requiredFiles
    ) {
        const candidate =
            join(
                managedExtensionPath,
                fileName
            );

        if (
            !existsSync(candidate) ||
            !statSync(candidate).isFile()
        ) {
            throw new Error(
                `Managed Twitch Presence extension is missing required file after copy: ${fileName}`
            );
        }
    }

    return {
        ok: true,
        bundledPath:
            bundled.path,
        extensionPath:
            managedExtensionPath,
        requiredFiles:
            bundled.requiredFiles,
        fileCount:
            managedFiles.length,
        totalBytes:
            managedFiles.reduce(
                (total, file) =>
                    total + file.size,
                0
            )
    };
}


async function openTwitchExtensionSetup() {
    const extension =
        provisionManagedTwitchExtension();

    const extensionParentPath =
        dirname(
            extension.extensionPath
        );

    const folderError =
        await shell.openPath(
            extensionParentPath
        );

    if (folderError) {
        throw new Error(
            `Unable to open the managed browser-extension folder: ${folderError}`
        );
    }

    const chromeExecutable =
        getChromeExecutablePath();

    if (!chromeExecutable) {
        throw new Error(
            "The managed extension folder was prepared and opened, but Google Chrome was not found automatically. Open Chrome, go to chrome://extensions, enable Developer mode, choose Load unpacked, and select the MaruTwitchPresence folder."
        );
    }

    return new Promise(
        (resolvePromise, rejectPromise) => {
            execFile(
                chromeExecutable,
                [],
                {
                    windowsHide: false
                },
                error => {
                    if (error) {
                        rejectPromise(
                            new Error(
                                `The managed extension folder was prepared and opened, but Chrome could not be opened automatically: ${error.message}`
                            )
                        );

                        return;
                    }

                    resolvePromise({
                        ok: true,
                        extensionPath:
                            extension.extensionPath,
                        extensionParentPath,
                        bundledPath:
                            extension.bundledPath,
                        chromeExecutable,
                        requiredFiles:
                            extension.requiredFiles,
                        fileCount:
                            extension.fileCount,
                        totalBytes:
                            extension.totalBytes,
                        persistent:
                            true,
                        reason:
                            "Copied and verified Twitch Presence into the persistent managed workspace, then opened Chrome and the parent browser-extension folder for drag-and-drop setup."
                    });
                }
            );
        }
    );
}


function validateBundledKickExtension() {
    const resource =
        getInstallerResourceDirectory(
            "kickExtension"
        );

    if (
        !existsSync(
            resource.path
        ) ||
        !statSync(
            resource.path
        ).isDirectory()
    ) {
        throw new Error(
            `Bundled Kick Presence extension folder was not found at ${resource.path}.`
        );
    }

    const requiredFiles = [
        ...KICK_EXTENSION_FILES
    ];

    const missingFiles =
        requiredFiles.filter(fileName => {
            const candidate =
                join(
                    resource.path,
                    fileName
                );

            return (
                !existsSync(candidate) ||
                !statSync(candidate).isFile()
            );
        });

    if (missingFiles.length > 0) {
        throw new Error(
            `Bundled Kick Presence extension is incomplete. Missing: ${missingFiles.join(", ")}.`
        );
    }

    return {
        ...resource,
        requiredFiles
    };
}


function provisionManagedKickExtension() {
    const bundled =
        validateBundledKickExtension();

    const paths =
        getManagedPaths();

    if (
        !paths?.root ||
        !paths?.kickBrowserExtension
    ) {
        throw new Error(
            "Managed Kick Presence extension path is unavailable."
        );
    }

    const managedExtensionPath =
        resolve(
            paths.kickBrowserExtension
        );

    if (
        !isPathInsideOrSame(
            paths.root,
            managedExtensionPath
        ) ||
        managedExtensionPath.toLowerCase() ===
        resolve(
            paths.root
        ).toLowerCase()
    ) {
        throw new Error(
            "Refusing Kick Presence extension setup because the managed extension path failed containment validation."
        );
    }

    mkdirSync(
        dirname(
            managedExtensionPath
        ),
        {
            recursive: true
        }
    );

    if (
        existsSync(
            managedExtensionPath
        )
    ) {
        rmSync(
            managedExtensionPath,
            {
                recursive: true,
                force: true
            }
        );
    }

    cpSync(
        bundled.path,
        managedExtensionPath,
        {
            recursive: true,
            force: false,
            errorOnExist: true
        }
    );

    const bundledFiles =
        getBackupFileManifest(
            bundled.path
        );

    const managedFiles =
        getBackupFileManifest(
            managedExtensionPath
        );

    const verification =
        verifyBackupFileManifests(
            bundledFiles,
            managedFiles
        );

    if (!verification.verified) {
        throw new Error(
            `Managed Kick Presence extension copy failed verification: ${verification.reason}`
        );
    }

    for (
        const fileName of
        bundled.requiredFiles
    ) {
        const candidate =
            join(
                managedExtensionPath,
                fileName
            );

        if (
            !existsSync(candidate) ||
            !statSync(candidate).isFile()
        ) {
            throw new Error(
                `Managed Kick Presence extension is missing required file after copy: ${fileName}`
            );
        }
    }

    return {
        ok: true,
        bundledPath:
            bundled.path,
        extensionPath:
            managedExtensionPath,
        requiredFiles:
            bundled.requiredFiles,
        fileCount:
            managedFiles.length,
        totalBytes:
            managedFiles.reduce(
                (total, file) =>
                    total + file.size,
                0
            )
    };
}


async function openKickExtensionSetup() {
    const extension =
        provisionManagedKickExtension();

    const extensionParentPath =
        dirname(
            extension.extensionPath
        );

    const folderError =
        await shell.openPath(
            extensionParentPath
        );

    if (folderError) {
        throw new Error(
            `Unable to open the managed browser-extension folder: ${folderError}`
        );
    }

    const chromeExecutable =
        getChromeExecutablePath();

    if (!chromeExecutable) {
        throw new Error(
            "The managed Kick extension folder was prepared and opened, but Google Chrome was not found automatically. Open Chrome, go to chrome://extensions, enable Developer mode, choose Load unpacked, and select the MaruKickPresence folder."
        );
    }

    return new Promise(
        (resolvePromise, rejectPromise) => {
            execFile(
                chromeExecutable,
                [],
                {
                    windowsHide: false
                },
                error => {
                    if (error) {
                        rejectPromise(
                            new Error(
                                `The managed Kick extension folder was prepared and opened, but Chrome could not be opened automatically: ${error.message}`
                            )
                        );

                        return;
                    }

                    resolvePromise({
                        ok: true,
                        extensionPath:
                            extension.extensionPath,
                        extensionParentPath,
                        bundledPath:
                            extension.bundledPath,
                        chromeExecutable,
                        requiredFiles:
                            extension.requiredFiles,
                        fileCount:
                            extension.fileCount,
                        totalBytes:
                            extension.totalBytes,
                        persistent:
                            true,
                        reason:
                            "Copied and verified Kick Presence into the persistent managed workspace, then opened Chrome and the parent browser-extension folder for drag-and-drop setup."
                    });
                }
            );
        }
    );
}


function createWindow() {
    const win = new BrowserWindow({
        width: 700,
        height: 500,

        // Development keeps Electron's normal menu for reload/DevTools.
        // Packaged builds remove the application menu entirely below.
        autoHideMenuBar:
            app.isPackaged === true,

        webPreferences: {
            preload: join(
                __dirname,
                "preload.cjs"
            ),

            contextIsolation: true,
            nodeIntegration: false
        }
    });

    if (
        app.isPackaged
    ) {
        // removeMenu(), rather than merely hiding the menu bar, prevents
        // Alt from revealing Electron's default File/Edit/View/Window menu.
        win.removeMenu();
    }

    win.loadFile("index.html");
}

app.whenReady().then(() => {
    ipcMain.handle(
        "open-twitch-extension-setup",
        async () => {
            return openTwitchExtensionSetup();
        }
    );

    ipcMain.handle(
        "open-kick-extension-setup",
        async () => {
            return openKickExtensionSetup();
        }
    );

    ipcMain.handle(
        "detect-discord",
        () => {
            return detectDiscordInstalls();
        }
    );

    ipcMain.handle(
        "get-discord-patch-states",
        () => {
            return getDiscordPatchStates();
        }
    );

    ipcMain.handle(
        "get-discord-patch-details",
        async () => {
            return getDiscordPatchDetailsWithRuntime();
        }
    );

    ipcMain.handle(
        "get-managed-uninstall-states",
        async () => {
            const patchDetails =
                await getDiscordPatchDetailsWithRuntime();

            return getManagedUninstallStates(
                patchDetails
            );
        }
    );

    ipcMain.handle(
        "detect-build-environment",
        async () => {
            return detectBuildEnvironment();
        }
    );

    ipcMain.handle(
        "dev-acquire-vencord-source-archive-staging",
        async () => {
            return acquireVencordSourceArchiveToStaging();
        }
    );

    ipcMain.handle(
        "promote-staged-vencord-source",
        () => {
            return promoteStagedVencordSource();
        }
    );

    ipcMain.handle(
        "get-app-runtime-state",
        () => {
            return {
                readOnly: true,
                isPackaged:
                    app.isPackaged === true,
                mode:
                    app.isPackaged
                        ? "packaged"
                        : "development"
            };
        }
    );

    ipcMain.handle(
        "get-installer-resources-state",
        () => {
            return {
                readOnly: true,
                ...getInstallerResourcesState(),
                bundledPlugins:
                    getBundledPluginsState(),
                bundledMaruHybridTheme:
                    getBundledMaruHybridThemeState()
            };
        }
    );

    ipcMain.handle(
        "get-managed-toolchain-state",
        async () => {
            const environment =
                await detectBuildEnvironment();

            const paths =
                getManagedPaths();

            const managedNodePath =
                paths?.toolchain
                    ? join(
                        paths.toolchain,
                        "node"
                    )
                    : null;

            const managedNodeProvenance =
                managedNodePath &&
                    existsSync(
                        managedNodePath
                    )
                    ? readManagedNodeRuntimeManifest(
                        managedNodePath
                    )
                    : {
                        available:
                            false,
                        reason:
                            "Managed Node runtime is not present."
                    };

            return {
                readOnly: true,
                toolchainRoot:
                    environment.toolchainRoot,
                usesManagedToolchain:
                    environment.usesManagedToolchain,
                packageManagerAvailable:
                    environment.packageManagerAvailable,
                tools:
                    environment.resolvedTools,
                managedNodeProvenance: {
                    verified:
                        managedNodeProvenance?.available === true,
                    manifestPath:
                        managedNodeProvenance?.available === true
                            ? managedNodeProvenance.manifestPath
                            : null,
                    nodePath:
                        managedNodeProvenance?.available === true
                            ? managedNodeProvenance.nodePath
                            : null,
                    sha256:
                        managedNodeProvenance?.available === true
                            ? managedNodeProvenance.nodeExeSha256
                            : null,
                    reason:
                        managedNodeProvenance?.available === true
                            ? "Official portable Node provenance verified."
                            : (
                                managedNodeProvenance?.reason ??
                                "Managed Node provenance is unavailable."
                            )
                }
            };
        }
    );

    ipcMain.handle(
        "prepare-managed-pnpm-runtime",
        async () => {
            return prepareManagedPnpmRuntime();
        }
    );

    ipcMain.handle(
        "prepare-managed-node-runtime",
        async () => {
            return prepareManagedNodeRuntime();
        }
    );

    ipcMain.handle(
        "dev-upgrade-managed-node-seed-to-verified",
        async () => {
            return upgradeTemporaryManagedNodeSeedToVerifiedPortableNode();
        }
    );

    ipcMain.handle(
        "dev-prepare-isolated-portable-node-runtime",
        async () => {
            return prepareIsolatedPortableNodeRuntimeTest();
        }
    );

    ipcMain.handle(
        "dev-run-isolated-fresh-install-build-test",
        async () => {
            return runIsolatedFreshInstallBuildTest();
        }
    );

    ipcMain.handle(
        "dev-run-isolated-setup-coordinator-test",
        async () => {
            return runIsolatedSetupCoordinatorTest();
        }
    );

    ipcMain.handle(
        "dev-seed-managed-node-from-global",
        async () => {
            return seedManagedNodeFromGlobal();
        }
    );

    ipcMain.handle(
        "get-managed-paths",
        () => {
            return getManagedPaths();
        }
    );

    ipcMain.handle(
        "get-managed-workspace-state",
        () => {
            return getManagedWorkspaceState();
        }
    );

    ipcMain.handle(
        "get-managed-vencord-state",
        () => {
            return getManagedVencordState();
        }
    );

    ipcMain.handle(
        "get-maru-plugin-preset-state",
        async () => {
            return getMaruPluginPresetState();
        }
    );


    ipcMain.handle(
        "apply-maru-plugin-preset",
        async () => {
            return applyMaruPluginPreset();
        }
    );

    ipcMain.handle(
        "get-maru-hybrid-theme-state",
        () => {
            return getMaruHybridThemeState();
        }
    );

    ipcMain.handle(
        "install-maru-hybrid-theme",
        () => {
            return installMaruHybridTheme();
        }
    );

    ipcMain.handle(
        "get-managed-vencord-update-state",
        async () => {
            return getManagedVencordUpdateState();
        }
    );

    ipcMain.handle(
        "update-managed-vencord",
        async () => {
            return updateManagedVencord();
        }
    );

    ipcMain.handle(
        "clone-managed-vencord",
        async () => {
            return cloneManagedVencord();
        }
    );

    ipcMain.handle(
        "prepare-managed-vencord-source",
        async () => {
            return prepareManagedVencordSourceFromArchive();
        }
    );

    ipcMain.handle(
        "get-managed-userplugins-state",
        () => {
            return getManagedUserPluginsState();
        }
    );

    ipcMain.handle(
        "ensure-managed-userplugins",
        () => {
            return ensureManagedUserPluginsDirectory();
        }
    );

    ipcMain.handle(
        "get-bundled-plugins-state",
        () => {
            return getBundledPluginsState();
        }
    );

    ipcMain.handle(
        "get-managed-installed-plugins-state",
        () => {
            return getManagedInstalledPluginsState();
        }
    );

    ipcMain.handle(
        "get-maru-plugin-update-state",
        () => {
            return getMaruPluginUpdateState();
        }
    );

    ipcMain.handle(
        "update-maru-plugins",
        async () => {
            return updateMaruPlugins();
        }
    );

    ipcMain.handle(
        "install-bundled-plugins",
        () => {
            return installBundledPlugins();
        }
    );

    ipcMain.handle(
        "get-managed-package-manager-requirement",
        () => {
            return getManagedPackageManagerRequirement();
        }
    );

    ipcMain.handle(
        "verify-managed-package-manager",
        async () => {
            return verifyManagedPackageManager();
        }
    );

    ipcMain.handle(
        "get-managed-plugin-dependencies-state",
        () => {
            return getManagedPluginDependenciesState();
        }
    );

    ipcMain.handle(
        "install-managed-plugin-dependencies",
        async () => {
            return installManagedPluginDependencies();
        }
    );

    ipcMain.handle(
        "get-managed-build-state",
        () => {
            return getManagedBuildState();
        }
    );

    ipcMain.handle(
        "get-external-vencord-migration-state",
        async (_event, discordName) => {
            const patchDetails =
                await getDiscordPatchDetailsWithRuntime();

            const ownershipStates =
                getManagedUninstallStates(
                    patchDetails
                );

            return getExternalVencordMigrationState(
                discordName,
                patchDetails,
                ownershipStates
            );
        }
    );

    ipcMain.handle(
        "backup-external-vencord-user-data",
        (_event, discordName) => {
            return backupExternalVencordUserData(
                discordName
            );
        }
    );

    ipcMain.handle(
        "get-external-vencord-backup-state",
        (_event, discordName) => {
            return getExternalVencordBackupState(
                discordName
            );
        }
    );

    ipcMain.handle(
        "run-managed-install-coordinator",
        async (_event, discordName) => {
            return runManagedInstallCoordinator(
                discordName
            );
        }
    );

    ipcMain.handle(
        "get-managed-install-plan",
        async (_event, discordName) => {
            return getManagedInstallPlan(
                discordName
            );
        }
    );

    ipcMain.handle(
        "build-managed-vencord",
        async () => {
            return buildManagedVencord();
        }
    );

    ipcMain.handle(
        "repair-managed-vencord",
        async (_event, discordName) => {
            return repairManagedVencord(
                discordName
            );
        }
    );

    ipcMain.handle(
        "install-managed-vencord",
        async (_event, discordName) => {
            return installManagedVencord(
                discordName
            );
        }
    );

    ipcMain.handle(
        "migrate-external-vencord",
        async (_event, discordName) => {
            return migrateExternalVencord(
                discordName
            );
        }
    );

    ipcMain.handle(
        "uninstall-managed-vencord",
        async (_event, discordName) => {
            return uninstallManagedVencord(
                discordName
            );
        }
    );

    ipcMain.handle(
        "create-managed-workspace",
        () => {
            return createManagedWorkspace();
        }
    );

    createWindow();

    app.on("activate", () => {
        if (
            BrowserWindow
                .getAllWindows()
                .length === 0
        ) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});
