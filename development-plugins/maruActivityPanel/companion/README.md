# Maru Activity Companion

A desktop VS Code extension that sends selected editor metadata only to the paired MaruActivityPanel plugin at `127.0.0.1`. It does not read file contents, run Git commands, change VSCord, or publish Discord presence. It has no runtime package dependencies.

## Install and pair

1. Install `maru-activity-companion-0.1.0.vsix` using VS Code's **Extensions: Install from VSIX...** command. Reload VS Code if prompted.
2. Install and enable the MaruActivityPanel custom Vencord plugin using the project installation instructions.
3. Run **Maru Activity: Pair with Discord** in the VS Code command palette. A random 256-bit token is stored in VS Code SecretStorage and copied to the clipboard. It is never written to logs or extension settings.
4. Paste the token into the plugin's **Bridge token** setting in Discord. Both sides use port `32145` by default. Clear the clipboard after pairing.
5. Open a text editor. The panel should display the actual basename, workspace label, language, cursor position and workspace session duration, subject to privacy settings. Change Discord to Invisible and repeat the same editor actions. The companion does not inspect Discord status.

**Maru Activity: Pair with Discord** copies the existing token when already paired. **Maru Activity: Replace Pairing Token** generates a replacement; paste the new token into Discord. The secret is shared between VS Code windows in the same profile, allowing multiple editor windows to use the same local bridge. Other VS Code profiles or installations require separate pairing. Treat the token as a secret: it authorizes publishing activity to this bridge. A process already running as your OS user may be able to inspect either application; this bridge does not provide isolation from a compromised local account.

## Settings and privacy

All settings are under **Maru Activity Companion** in VS Code and use application scope, so a workspace cannot redirect the bridge or change the selected privacy fields.

| Setting | Default | Behavior |
| --- | --- | --- |
| `maruActivity.enabled` | `true` | Start/stop local metadata delivery; disabling withdraws this window's session. |
| `maruActivity.port` | `32145` | Integer loopback port, 1024–65535; must match Discord. |
| `maruActivity.idleSeconds` | `120` | Mark activity idle after 15–3600 seconds without editor interaction. |
| `maruActivity.shareWorkspace` | `true` | Send the current folder/workspace label, never a full path. |
| `maruActivity.shareFile` | `true` | Send only active file basename and language ID. |
| `maruActivity.shareCursor` | `true` | Send 1-based cursor line/column independently of file visibility. |
| `maruActivity.shareDuration` | `true` | Send the workspace editor session start time. |
| `maruActivity.shareRepository` | `true` | Send a sanitized HTTPS remote link if the built-in Git API supplies one. |

Privacy fields are removed in VS Code before any request is made. No source text, selected text, raw file path, Git credential, URL query or fragment is transmitted. The editor session starts when an editor first becomes active, survives file switches and resets when the active workspace folder changes. Its duration measures elapsed time in that workspace session, including idle/unfocused time; it is not an audited measure of typing time. Unfocused windows become idle immediately; text changes, active-editor changes and cursor selections in the focused window count as interaction. VS Code does not expose every keyboard/mouse interaction through these APIs.

Metadata changes are debounced by 200 ms. A 15-second heartbeat recovers automatically when Discord starts or reloads later. There is at most one outgoing request and one queued latest snapshot per window. Each request has a 1.5-second deadline. There is no editor polling. The extension sends only to literal IPv4 loopback using authenticated HTTP with no browser Origin header and no persistent connections. Closing the last text editor sends `unavailable` with no editor metadata. Deactivation makes a best-effort session withdrawal and disposes all listeners, timers and in-flight requests. If VS Code crashes or is force-killed, the Discord bridge expires the session after 45 seconds.

Repository discovery uses the existing `vscode.git` extension's version-1 API and subscribes to repository changes. It prefers `origin`, converts ordinary `git@host:owner/repo.git` and `ssh://git@host/owner/repo.git` remotes to HTTPS, strips credentials and hides local paths, local IPs and unsupported remotes. No network request is made to the repository. Private repository links are still metadata; disable sharing if their names are sensitive.

## VSCord display mirroring

When LeonardSSH VSCord is installed and active, the companion adds its effective application ID and this extension host's process ID to the authenticated metadata. MaruActivityPanel uses them to match VSCord's final local RPC activity, including its customized text, images, timestamps and buttons, before Discord's public-presence visibility filtering. It does not change VSCord or publish presence. The existing editor metadata remains the fallback whenever no matching local activity is available, including when VSCord runs in a different extension host.

No VSCord formatter or customization settings are duplicated. VSCord configuration and installed-extension changes refresh the identity without resetting editor interaction or session timing. VSCord still decides when its formatted payload is republished: a template edit becomes visible on its next RPC update, such as the next editor interaction. The companion does not force public presence updates. Formatted text is shown only when all companion sharing options and all corresponding panel field-visibility settings permit it, because arbitrary templates can combine private fields; images, timestamps and buttons also respect their corresponding sharing options. No formatted VSCord text is sent across the bridge. Discord's status does not affect the companion's editor tracking.

Customized image URLs, image tooltips and button labels can also contain template variables, so the panel conservatively falls back to its original language badge and repository link when those free-form fields could reveal hidden metadata. Only Discord CDN/proxy images and HTTPS activity buttons are used. Missing images retain the existing badge.

Rebuild/install the companion VSIX and update the plugin to enable mirroring. Existing pairing tokens are preserved. When an older plugin rejects the optional identity with HTTP 400, the companion retries that snapshot once with only the original editor metadata, preserving raw tracking during staggered updates. This compatibility retry never applies to authentication failures or other errors and does not persist a legacy mode. Live Online/DND/Invisible transitions still require testing in the user's installed Discord version.

## Remote and virtual workspaces

The extension declares `extensionKind: ["ui"]`, so its Node process runs on the same desktop as Discord when VS Code uses SSH, WSL or a container. Supported editor/window APIs supply active-editor metadata across that boundary. Repository information is optional: VS Code cannot necessarily expose a remote Git extension's exports to a local UI extension, so the link is hidden when unavailable. No SSH forwarding, remote localhost listener or filesystem scan is used. Browser-only VS Code is unsupported and the extension does not activate there. These remote scenarios require manual verification on the user's specific setup.

## Build and package from source

With Node.js/npm installed:

```powershell
npm install
npm run compile
node --test ../tests/companion.test.cjs
npm run package
```

`scripts/package.mjs` builds a local VSIX using Node's built-in filesystem APIs; no Marketplace account, publishing token or external packaging service is used. It includes only the compiled extension, package manifest, README and license. No token is present in the package. Developer tests use controlled editor events/transport responses and verify privacy, session timing, debouncing, pairing, disabled/re-enabled lifecycle, bounded serialization, retry and cleanup. They do not certify the live VS Code extension host or Discord UI.
