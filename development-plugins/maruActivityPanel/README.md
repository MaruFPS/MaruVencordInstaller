# MaruActivityPanel — development only

Personal Vencord userplugin source for regular Discord. These eight source files are synchronized from the working `src/userplugins/maruActivityPanel/` folder in the local Vencord checkout. The plugin identity is `MaruActivityPanel`.

This directory is excluded from the public installer's application files, Electron resources, bundled-plugin registry, approved hashes, and managed install/repair workflows. No public bundle metadata is required. Keep this plugin under `development-plugins/`; do not promote it into `bundled-plugins/` as part of routine synchronization.

## Companion dependency

The plugin requires the separately installed **Maru Activity Companion** VS Code extension. It sends selected editor metadata to an authenticated localhost bridge, using `127.0.0.1:32145` by default. It operates independently of Discord's public presence status, including Invisible, and does not require changes to VSCord.

Run **Maru Activity: Pair with Discord** in VS Code and paste the generated secret into the plugin's **Bridge token** setting locally. Both sides must use the same bridge port. The companion VSIX, pairing secrets, VS Code SecretStorage, Discord settings, and runtime state are not included here and must not enter installer resources or Git commits.

Copy all eight source files into `src/userplugins/maruActivityPanel/` when synchronizing a personal Vencord checkout; `native.ts` and `shared.ts` are required alongside the React component and stylesheet. The companion remains a separate local installation.

## Theme separation

The plugin retains neutral stock styling without NAAT. Glass overrides belong to the `NotAnotherAnimeTheme` repository's `maru-glass` branch, under `css/v3/naat.v3.css` and its generated `build/v3/naat.v3.css`. This source copy preserves the approved compact interface, metadata, timer, repository navigation, and existing settings.
