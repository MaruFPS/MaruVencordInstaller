# Stream Dock Destinations - Stable Favorites Patch

This folder contains our patched Stream Dock Discord
Destinations module.

The parent directory contains the companion Vencord plugin.

## Purpose

Prevent Discord Canary from hijacking Stream Dock's
Favorites navigation.

## Fix

- Dynamically resolves Discord Stable's executable.
- Opens Favorites directly through Discord Stable.
- Bypasses Windows' discord:// protocol association.
- Never falls back to Discord Canary.
- Preserves other Stream Dock destination actions.

## Installed plugin location

%APPDATA%\HotSpot\StreamDock\plugins\
com.hotspot.streamdock.discord.sdPlugin\plugin\destinations.mjs

## Important

This is a Stream Dock patch, NOT a Vencord plugin.

Keep this folder separate from the parent Vencord
plugin source. Do not bundle these files into Vencord.
