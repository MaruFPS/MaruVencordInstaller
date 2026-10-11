import {
    BrowserWindow,
    desktopCapturer,
    screen,
    type IpcMainInvokeEvent
} from "electron";

import { execFile, spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";


const execFileAsync =
    promisify(execFile);


const DEFAULT_MONITOR_KEY =
    "Monitor1";

const DEFAULT_PRESET_NAME =
    "MaruDiscordPreset";

const CAPTURE_NAME =
    "MaruDiscordCapture";
let wallpaperEnginePathsPromise:
    Promise<{
        exeFile: string;
        configFile: string;
    }> |
    null = null;


async function fileExists(
    file: string
) {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}


async function resolveWallpaperEnginePaths() {
    const { stdout } =
        await execFileAsync(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                String.raw`(Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath`
            ],
            {
                windowsHide: true
            }
        );

    const steamPath =
        stdout.trim();

    if (!steamPath) {
        throw new Error(
            "Could not locate Steam from the Windows registry."
        );
    }

    const libraryFile =
        join(
            steamPath,
            "steamapps",
            "libraryfolders.vdf"
        );

    const libraries =
        new Set<string>();

    libraries.add(
        steamPath
    );

    if (
        await fileExists(
            libraryFile
        )
    ) {
        const raw =
            await readFile(
                libraryFile,
                "utf8"
            );

        const regex =
            /"path"\s+"([^"]+)"/g;

        for (
            const match of
            raw.matchAll(regex)
        ) {
            libraries.add(
                match[1].replace(
                    /\\\\/g,
                    "\\"
                )
            );
        }
    }

    for (
        const library of
        libraries
    ) {
        const directory =
            join(
                library,
                "steamapps",
                "common",
                "wallpaper_engine"
            );

        const exeFile =
            join(
                directory,
                "wallpaper64.exe"
            );

        const configFile =
            join(
                directory,
                "config.json"
            );

        if (
            await fileExists(exeFile) &&
            await fileExists(configFile)
        ) {

            return {
                exeFile,
                configFile
            };
        }
    }

    throw new Error(
        "Wallpaper Engine could not be found in any Steam library."
    );
}


async function getWallpaperEnginePaths() {
    wallpaperEnginePathsPromise ??=
        resolveWallpaperEnginePaths();

    try {
        return await wallpaperEnginePathsPromise;
    } catch (error) {
        wallpaperEnginePathsPromise =
            null;

        throw error;
    }
}



export async function getDiscordDisplayInfo(
    event: IpcMainInvokeEvent
) {
    const discordWindow =
        BrowserWindow.fromWebContents(
            event.sender
        );

    if (!discordWindow) {
        throw new Error(
            "Could not resolve Discord BrowserWindow"
        );
    }

    const windowBounds =
        discordWindow.getBounds();

    /*
     * Electron chooses the display which most closely
     * intersects the Discord window bounds.
     *
     * This gives us the display Discord is effectively
     * sitting on even when the window overlaps monitors.
     */
    const display =
        screen.getDisplayMatching(
            windowBounds
        );

    const primaryDisplay =
        screen.getPrimaryDisplay();

    return {
        id:
            String(display.id),

        primary:
            display.id ===
            primaryDisplay.id,

        bounds: {
            x:
                display.bounds.x,

            y:
                display.bounds.y,

            width:
                display.bounds.width,

            height:
                display.bounds.height
        },

        workArea: {
            x:
                display.workArea.x,

            y:
                display.workArea.y,

            width:
                display.workArea.width,

            height:
                display.workArea.height
        },

        scaleFactor:
            display.scaleFactor,

        discordBounds: {
            x:
                windowBounds.x,

            y:
                windowBounds.y,

            width:
                windowBounds.width,

            height:
                windowBounds.height
        }
    };
}


export async function listWindowSources(
    _event: IpcMainInvokeEvent
) {
    const sources =
        await desktopCapturer.getSources({
            types: ["window"],

            thumbnailSize: {
                width: 0,
                height: 0
            },

            fetchWindowIcons: false
        });

    return sources.map(
        source => ({
            id:
                source.id,

            name:
                source.name
        })
    );
}


async function readActiveWallpaperFile(
    monitorKey = DEFAULT_MONITOR_KEY
) {
    const {
        configFile
    } =
        await getWallpaperEnginePaths();

    const raw =
        await readFile(
            configFile,
            "utf8"
        );

    const config =
        JSON.parse(raw);

    const file =
        Object.values(config ?? {})
            .map((value: any) =>
                value
                    ?.general
                    ?.wallpaperconfig
                    ?.selectedwallpapers
                    ?.[monitorKey]
                    ?.file
            )
            .find(value =>
                typeof value === "string" &&
                !!value
            );

    if (
        typeof file !== "string" ||
        !file
    ) {
        return null;
    }

    return file;
}


export async function getActiveWallpaperFile(
    _event: IpcMainInvokeEvent,
    monitorKey = DEFAULT_MONITOR_KEY
) {
    return await readActiveWallpaperFile(
        monitorKey
    );
}


export async function launchCaptureWindow(
    _event: IpcMainInvokeEvent,
    monitorKey = DEFAULT_MONITOR_KEY,
    presetName = DEFAULT_PRESET_NAME,
    width = 1920,
    height = 1080
) {
    const sources =
        await desktopCapturer.getSources({
            types: ["window"],

            thumbnailSize: {
                width: 0,
                height: 0
            },

            fetchWindowIcons: false
        });

    const alreadyOpen =
        sources.some(
            source =>
                source.name ===
                CAPTURE_NAME
        );

    if (alreadyOpen)
        return;

    const {
        exeFile
    } =
        await getWallpaperEnginePaths();

    const projectFile =
        await readActiveWallpaperFile(
            monitorKey
        );

    
    if (!projectFile)
        return;

    const effectivePresetName =
        typeof presetName === "string" &&
        presetName.trim()
            ? presetName.trim()
            : DEFAULT_PRESET_NAME;

    width =
        Math.max(
            320,
            Math.round(width)
        );

    height =
        Math.max(
            180,
            Math.round(height)
        );

    const child =
        spawn(
            exeFile,
            [
                "-control",
                "openWallpaper",

                "-file",
                projectFile,

                "-preset",
                effectivePresetName,

                "-playInWindow",
                CAPTURE_NAME,

                "-width",
                String(width),

                "-height",
                String(height),

                "-x",
                "10000",

                "-y",
                "10000",

                "-borderless"
            ],
            {
                detached:
                    true,

                stdio:
                    "ignore"
            }
        );

    child.unref();
}


export async function hideCaptureWindow(
    _event: IpcMainInvokeEvent
) {
    const script = `
$proc = $null

for ($i = 0; $i -lt 100; $i++) {
    $proc = Get-Process wallpaper64 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.MainWindowTitle -eq "MaruDiscordCapture" -and
            $_.MainWindowHandle -ne 0
        } |
        Select-Object -First 1

    if ($proc) {
        break
    }

    Start-Sleep -Milliseconds 10
}

if (-not $proc) {
    exit 2
}

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class MaruWindowStyle
{
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static extern IntPtr GetWindowLongPtr(
        IntPtr hWnd,
        int nIndex
    );

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    public static extern IntPtr SetWindowLongPtr(
        IntPtr hWnd,
        int nIndex,
        IntPtr dwNewLong
    );

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int X,
        int Y,
        int cx,
        int cy,
        uint uFlags
    );
}
"@

$hwnd = [IntPtr]$proc.MainWindowHandle

$GWL_EXSTYLE      = -20
$WS_EX_TOOLWINDOW = 0x00000080
$WS_EX_APPWINDOW  = 0x00040000

$style =
    [MaruWindowStyle]::GetWindowLongPtr(
        $hwnd,
        $GWL_EXSTYLE
    ).ToInt64()

$newStyle =
    ($style -bor $WS_EX_TOOLWINDOW) -band
    (-bnot $WS_EX_APPWINDOW)

[MaruWindowStyle]::SetWindowLongPtr(
    $hwnd,
    $GWL_EXSTYLE,
    [IntPtr]$newStyle
) | Out-Null

$ok =
    [MaruWindowStyle]::SetWindowPos(
        $hwnd,
        [IntPtr]::Zero,
        10000,
        10000,
        0,
        0,
        0x0035
    )

if (-not $ok) {
    exit 3
}
`;

    const encoded =
        Buffer.from(
            script,
            "utf16le"
        ).toString(
            "base64"
        );

    await execFileAsync(
        "powershell.exe",
        [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            encoded
        ],
        {
            windowsHide:
                true
        }
    );
}


export async function resizeCaptureWindow(
    _event: IpcMainInvokeEvent,
    width: number,
    height: number
) {
    width =
        Math.max(
            320,
            Math.round(width)
        );

    height =
        Math.max(
            180,
            Math.round(height)
        );

    const script = `
$proc = Get-Process wallpaper64 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.MainWindowTitle -eq "MaruDiscordCapture" -and
        $_.MainWindowHandle -ne 0
    } |
    Select-Object -First 1

if (-not $proc) {
    exit 2
}

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class MaruResizeWindow
{
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int X,
        int Y,
        int cx,
        int cy,
        uint uFlags
    );
}
"@

$ok =
    [MaruResizeWindow]::SetWindowPos(
        [IntPtr]$proc.MainWindowHandle,
        [IntPtr]::Zero,
        10000,
        10000,
        ${width},
        ${height},
        0x0014
    )

if (-not $ok) {
    exit 3
}
`;

    const encoded =
        Buffer.from(
            script,
            "utf16le"
        ).toString(
            "base64"
        );

    await execFileAsync(
        "powershell.exe",
        [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            encoded
        ],
        {
            windowsHide:
                true
        }
    );
}


export async function closeCaptureWindow(
    _event: IpcMainInvokeEvent
) {
    const {
        exeFile
    } =
        await getWallpaperEnginePaths();

    const child =
        spawn(
            exeFile,
            [
                "-control",
                "closeWallpaper",

                "-location",
                CAPTURE_NAME
            ],
            {
                detached:
                    true,

                stdio:
                    "ignore"
            }
        );

    child.unref();
}


