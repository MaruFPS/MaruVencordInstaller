import { definePluginSettings, SettingsStore } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { currentUserCategories } from "@plugins/pinDms/data";
import definePlugin, { OptionType } from "@utils/types";
import { extractAndLoadChunksLazy, filters, find, findModuleId, findStore, findStoreLazy, wreq } from "@webpack";
import { ApplicationAssetUtils, Avatar, ChannelStore, ContextMenuApi, createRoot, Menu, React, ReactDOM, RelationshipStore, VoiceStateStore } from "@webpack/common";

const UserStore: any = findStoreLazy("UserStore");
const PresenceStore: any = findStoreLazy("PresenceStore");

const loadUserContextMenu = extractAndLoadChunksLazy([
    "isContextMenuActive",
    "targetUserId"
]);

async function openNativeUserContextMenu(event: MouseEvent, user: any) {
    await loadUserContextMenu();
    if (!dualSidebarRunning) return;

    const moduleId = findModuleId(
        '"data-menu-migrated"',
        'navId:"user-context"',
        "USER_GENERIC_MENU"
    );

    if (moduleId == null) {
        console.error("[MaruFriendsSidebar] Native user context menu module not found");
        return;
    }

    const UserContextMenu = wreq(moduleId as any).default;

    ContextMenuApi.openContextMenu(
        event as any,
        (menuProps: any) => React.createElement(UserContextMenu, {
            ...menuProps,
            user
        })
    );
}

let observer: MutationObserver | null = null;
let lastShell: HTMLElement | null = null;
let styleElement: HTMLStyleElement | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let selectedCategoryId: string | null = null;
let modeButton: HTMLElement | null = null;
let nativeOrganizer: { Popout: any; Button: any; Icon: any; renderMenu: () => React.ReactElement<any>; layer: { Context: any; value: any; }; } | null = null;
let sortControl: { shell: HTMLElement; host: HTMLElement; root: ReturnType<typeof createRoot>; visible: boolean; } | null = null;
const avatarRoots = new Map<HTMLElement, ReturnType<typeof createRoot>>();
const nativeIconRoots = new Map<HTMLElement, { root: ReturnType<typeof createRoot>; key: string; }>();
type NativeIcon = "active_now" | "online" | "status" | "chevron_down" | "chevron_right" | "game" | "music" | "watching" | "custom";
let nativeIcons: Partial<Record<NativeIcon, any>> = {};
let nativeChannelIcon: ((channel: any) => any) | null = null;
let nativeCosmetics: { Name: any; useStyles: any; Nameplate: any; useNameplate: any; plain: number; animated: number; placement: string; } | null = null;
let friendCosmeticsComponent: any = null;
let nativeAvatarHook: any = null;
let friendAvatarComponent: any = null;
const friendRowUpdates = new WeakMap<HTMLElement, (data: FriendRowData) => void>();
const friendRowData = new WeakMap<HTMLElement, FriendRowData>();
let widthObserver: ResizeObserver | null = null;
let observedShell: HTMLElement | null = null;
let lastNativeList: HTMLElement | null = null;
let durationTimer: ReturnType<typeof setTimeout> | null = null;
let nativeFriendRows: any = null;
let nativeLocale: any = null;
let nativeActivityText: ((activity: any) => { text?: string; }) | null = null;
let nativeActivityAsset: any = null;
let nativeDuration: ((seconds: number) => string) | null = null;
let presentationLoaded = false;
const categoryScrollPositions = new Map<string, number>();
type SectionKey = "active_now" | "online" | "offline";
type ActivityIcon = "game" | "music" | "watching" | "voice" | "custom" | null;
const sections: { key: SectionKey; label: string; }[] = [
    { key: "active_now", label: "Active Now" },
    { key: "online", label: "Online" },
    { key: "offline", label: "Offline" }
];

interface FriendRowData {
    user: any;
    status: string;
    avatarSrc: string;
    displayName: string;
    subtitle: string | null;
    hasRichActivity: boolean;
    section: SectionKey;
    icon: ActivityIcon;
    emoji: { id?: string; name?: string; animated?: boolean; } | null;
    activityStart: number | null;
    activityBaseText: string | null;
    gameAssetUrl: string | null;
    gameAppId: string | null;
    voiceIcon: any;
}

function loadNativePresentation() {
    captureNativeActivityAsset();
    if (presentationLoaded) return;
    presentationLoaded = true;
    loadNativeIcons();
    loadNativeCosmetics();
    loadNativeAvatar();
    // Capture while native rows are still visible; virtualization may discard
    // them after the native list is hidden for a custom category.
    if (!nativeUserPopoutComponent) getNativeUserPopoutComponent();
    // These are read-only native data/formatting helpers. Never override the
    // native store's users, grouping mode, or React rendering context.
    try {
        const store = findStore("FriendRowStore");
        if (typeof store?.getRow === "function") {
            nativeFriendRows = store;
            nativeFriendRows.addChangeListener(handlePresenceChange);
        }
        nativeLocale = findStore("LocaleStore");
    } catch {
        // Older experiment builds can lack these stores; presence still works.
    }
    try {
        nativeActivityText = find(filters.byCode("status_display_type", ".COMPETING", "tooltip:"), { isIndirect: true });
    } catch {
        nativeActivityText = null;
    }
    try {
        const durationModuleId = findModuleId("getFormatter", "2592e3", "31104e3");
        if (durationModuleId == null) return;
        const exports = Object.values(wreq(durationModuleId as any)).filter(value => typeof value === "function") as Function[];
        const format = exports.find(fn => String(fn).includes("2592e3") && String(fn).includes("getFormatter"));
        const formatters = exports.filter(fn => fn.length === 0 && /minutes:/.test(String(fn)) && /years:/.test(String(fn)));
        if (!format || !formatters.length) return;
        // Native exports are minified. Select the short locale formatter by its
        // output rather than pinning a module ID or a minified export name.
        const getFormatter = formatters.sort((a, b) =>
            format({ seconds: 3600, getFormatter: a }).length - format({ seconds: 3600, getFormatter: b }).length
        )[0];
        nativeDuration = seconds => format({ seconds, getFormatter });
    } catch {
        nativeDuration = null;
    }
}

// Asset signatures identify Discord's own exports; no SVG paths are rendered here.
function findNativeExport(...signature: string[]): any {
    try {
        const filter = filters.componentByCode(...signature);
        const loaded = find(filter, { isIndirect: true });
        if (loaded) return loaded;
        const id = findModuleId(...signature);
        if (id == null) return null;
        return Object.values(wreq(id as any)).find(filter) ?? null;
    } catch {
        return null;
    }
}

let nativeSectionIcon: any = null;
let nativeFriendsContext: any = null;
let nativeSectionTypes: any = null;
let nativeSeparatedClass: string | null = null;

function captureNativeSectionPresentation() {
    // The section icon is private to the sidebar module. Capture its identity
    // semantically from the native tree, without module IDs or ancestor offsets.
    const shell = findFriendsSidebarShell();
    const filter = filters.componentByCode("section:", ".ACTIVE_NOW", ".ONLINE", ".OFFLINE");
    for (const svg of shell?.querySelectorAll("svg") ?? []) {
        const fiberKey = Object.keys(svg).find(key => key.startsWith("__reactFiber$"));
        let fiber = fiberKey ? (svg as any)[fiberKey] : null;
        for (; fiber; fiber = fiber.return) {
            if (filter(fiber.type)) nativeSectionIcon = fiber.type;
            const value = fiber.memoizedProps?.value;
            const context = fiber.type?._context ?? fiber.type;
            if (context?.Provider && typeof value?.hovered === "boolean" && typeof value?.collapsed === "boolean")
                nativeFriendsContext = context;
        }
        if (nativeSectionIcon && nativeFriendsContext) break;
    }
    nativeSectionTypes = find(filters.byProps("ACTIVE_NOW", "ONLINE", "OFFLINE", "GAME", "LETTER"), { isIndirect: true });
    const classes = find(value => value != null && typeof value === "object" &&
        Object.values(value).some(v => typeof v === "string" && v.startsWith("separated_")) &&
        Object.values(value).some(v => typeof v === "string" && v.startsWith("gameName_")), { isIndirect: true });
    nativeSeparatedClass = classes ? Object.values(classes).find((v): v is string => typeof v === "string" && v.startsWith("separated_")) ?? null : null;
}

function NativeActiveSectionIcon({ shell, collapsed }: { shell: HTMLElement; collapsed: boolean; }) {
    const [hovered, setHovered] = React.useState(() => shell.matches(":hover"));
    React.useEffect(() => {
        const enter = () => setHovered(true);
        const leave = () => setHovered(false);
        shell.addEventListener("mouseenter", enter);
        shell.addEventListener("mouseleave", leave);
        setHovered(shell.matches(":hover"));
        return () => {
            shell.removeEventListener("mouseenter", enter);
            shell.removeEventListener("mouseleave", leave);
        };
    }, [shell]);
    // Discord owns the artwork, animation timer, idle reset and motion policy.
    return React.createElement(nativeFriendsContext.Provider, { value: { hovered, collapsed } },
        React.createElement(nativeSectionIcon, { section: { type: nativeSectionTypes.ACTIVE_NOW } }));
}

function renderSectionMarker(section: HTMLElement, shell: HTMLElement) {
    const key = section.dataset.maruSection as SectionKey;
    const marker = section.querySelector<HTMLElement>(".maruFriendsSectionMarker")!;
    if (section.hidden) {
        unmountNativeIcons(marker);
        return;
    }
    if (key === "active_now" && nativeSectionIcon && nativeFriendsContext && nativeSectionTypes)
        renderNativeIcon(marker, "active_now", { shell, collapsed: shell.querySelector<HTMLElement>(".maruFriendsList")?.dataset.maruCompact === "true" }, NativeActiveSectionIcon);
    else if (key === "online" && nativeIcons.online)
        renderNativeIcon(marker, "online", { hasOnlineFriends: true, color: "var(--icon-muted)" });
    else
        renderNativeIcon(marker, key === "active_now" ? "active_now" : "status", key === "active_now"
            ? { size: "xs", color: "var(--icon-muted)" } : { status: key, size: 12 });
}

function loadNativeIcons() {
    captureNativeSectionPresentation();
    nativeIcons = {
        active_now: findNativeExport("M7.65 21.75"),
        online: findNativeExport("hasOnlineFriends:", "aria-hidden"),
        status: findNativeExport("isMobile:", "isVR:", "backgroundColor:", "mask:"),
        chevron_down: findNativeExport("M5.3 9.3"),
        chevron_right: findNativeExport("M9.3 5.3"),
        game: findNativeExport("M20.97 4.06"),
        music: findNativeExport("M8.65 1.51"),
        watching: findNativeExport("M5 2a3 3 0 0 0-3 3v8"),
        custom: findNativeExport("hideTooltip:", "translateSurrogatesToInlineEmoji")
    };
    nativeChannelIcon = findNativeExport("isModeratorReportChannel()", "hasActiveThreads:", "textFocused:");
}

function renderNativeIcon(host: HTMLElement, icon: NativeIcon, props: Record<string, any> = {}, component = nativeIcons[icon]) {
    if (!component) return;
    const key = icon + JSON.stringify(props, (_key, value) => value instanceof HTMLElement ? null : value);
    let entry = nativeIconRoots.get(host);
    if (entry?.key === key) return;
    if (!entry) {
        entry = { root: createRoot(host), key };
        nativeIconRoots.set(host, entry);
    }
    entry.key = key;
    entry.root.render(React.createElement(component, { "aria-hidden": true, ...props }));
}

function unmountNativeIcons(container?: HTMLElement) {
    for (const [element, { root }] of nativeIconRoots) {
        if (!container || container.contains(element)) {
            nativeIconRoots.delete(element);
            root.unmount();
        }
    }
}

interface FriendAvatarProps {
    userId: string;
    avatarSrc: string;
    status: string;
    row: HTMLElement;
}

function plainFriendAvatar({ avatarSrc, status }: FriendAvatarProps) {
    return React.createElement(Avatar, { src: avatarSrc, size: "SIZE_32", status, "aria-hidden": true });
}

function loadNativeAvatar() {
    // The same subscribed hook used by native Friends: equipped assets, sizing,
    // hover playback and Discord's animation/reduced-motion policy stay native.
    nativeAvatarHook = findNativeExport("avatarDecorationOverride:", "isAvatarAnimating:", "onlyAnimateOnHoverOrFocus:");
    if (!nativeAvatarHook) return;
    friendAvatarComponent = React.memo(ErrorBoundary.wrap(FriendAvatar, {
        fallback: ({ wrappedProps }) => plainFriendAvatar(wrappedProps)
    }));
}

function FriendAvatar({ userId, avatarSrc, status, row }: FriendAvatarProps) {
    const { avatarDecorationSrc, eventHandlers } = nativeAvatarHook({ userId, size: "SIZE_32", animateOnHover: true });
    const handlers = React.useRef(eventHandlers);
    handlers.current = eventHandlers;
    React.useEffect(() => {
        const enter = () => handlers.current.onMouseEnter();
        const leave = () => handlers.current.onMouseLeave();
        const reconcile = () => row.matches(":hover") && row.getClientRects().length ? enter() : leave();
        const list = row.closest(".maruFriendsList");
        row.addEventListener("mouseenter", enter);
        row.addEventListener("mouseleave", leave);
        list?.addEventListener("maruFriendsLayoutChange", reconcile);
        reconcile();
        return () => {
            row.removeEventListener("mouseenter", enter);
            row.removeEventListener("mouseleave", leave);
            list?.removeEventListener("maruFriendsLayoutChange", reconcile);
        };
    }, [row]);
    // Preserve the user's static-PFP preference and native presence masks.
    // Only the equipped decoration uses the native hover-controlled asset.
    return React.createElement(Avatar as any, {
        src: avatarSrc, avatarDecoration: avatarDecorationSrc,
        size: "SIZE_32", status, "aria-hidden": true
    });
}

interface FriendCosmeticsProps {
    user: any;
    displayName: string;
    row: HTMLElement;
    nameHost: HTMLElement;
    plateHost: HTMLElement;
    content: { current: HTMLElement; };
}

function loadNativeCosmetics() {
    const Name = findNativeExport("UserNameWithEffects", "effectDisplayType:");
    const useStyles = findNativeExport("pendingDisplayNameStyles:", "useDisplayNameStyles");
    const Nameplate = findNativeExport("nameplate:", "hovered:", "content:", "maskImage:");
    const useNameplate = findNativeExport("collectibles?.nameplate", "useMemo");
    const effects = find(filters.byProps("PLAIN", "STATIC", "ANIMATED"), { isIndirect: true });
    const placements = find(filters.byProps("FRIENDS_LIST", "MEMBER_LIST", "MINI_PREVIEW"), { isIndirect: true });
    const hasName = Name && useStyles && typeof effects?.PLAIN === "number" && typeof effects?.ANIMATED === "number";
    const hasPlate = Nameplate && useNameplate && typeof placements?.FRIENDS_LIST === "string";
    if (!hasName && !hasPlate) return;
    nativeCosmetics = {
        Name: hasName ? Name : null,
        useStyles: hasName ? useStyles : null,
        Nameplate: hasPlate ? Nameplate : null,
        useNameplate: hasPlate ? useNameplate : null,
        plain: effects?.PLAIN,
        animated: effects?.ANIMATED,
        placement: placements?.FRIENDS_LIST
    };
    // Only cosmetics are inside this boundary; an upstream cosmetic failure
    // must not remove the avatar, row, or its profile/context-menu handlers.
    friendCosmeticsComponent = React.memo(ErrorBoundary.wrap(FriendCosmetics, {
        fallback: ({ wrappedProps }) => ReactDOM.createPortal(wrappedProps.displayName, wrappedProps.nameHost)
    }));
}

function noCosmeticData(_options: any) { return null; }

function FriendCosmetics({ user, displayName, row, nameHost, plateHost, content }: FriendCosmeticsProps) {
    const [hovered, setHovered] = React.useState(() => row.matches(":hover"));
    const [focused, setFocused] = React.useState(() => row.matches(":focus-visible"));
    // These hook identities are fixed for the lifetime of the row. Native hooks
    // subscribe to cosmetic/settings changes and keep their own motion policy.
    const useStyles = nativeCosmetics?.useStyles ?? noCosmeticData;
    const useNameplate = nativeCosmetics?.useNameplate ?? noCosmeticData;
    const styles = useStyles({ userId: user.id });
    const equipped = useNameplate({ user });
    React.useEffect(() => {
        const enter = () => setHovered(true);
        const leave = () => setHovered(false);
        const focus = () => setFocused(row.matches(":focus-visible"));
        const reconcile = () => {
            setHovered(row.matches(":hover"));
            focus();
        };
        const pointer = () => setFocused(false);
        const list = row.closest(".maruFriendsList");
        list?.addEventListener("maruFriendsLayoutChange", reconcile);
        row.addEventListener("keydown", focus);
        row.addEventListener("pointerdown", pointer);
        const blur = () => setFocused(false);
        row.addEventListener("mouseenter", enter);
        row.addEventListener("mouseleave", leave);
        row.addEventListener("focus", focus);
        row.addEventListener("blur", blur);
        return () => {
            list?.removeEventListener("maruFriendsLayoutChange", reconcile);
            row.removeEventListener("keydown", focus);
            row.removeEventListener("pointerdown", pointer);
            row.removeEventListener("mouseenter", enter);
            row.removeEventListener("mouseleave", leave);
            row.removeEventListener("focus", focus);
            row.removeEventListener("blur", blur);
        };
    }, [row]);
    const active = hovered || focused;
    const name = nativeCosmetics?.Name
        ? React.createElement(nativeCosmetics.Name, {
            userName: displayName,
            displayNameStyles: styles,
            effectDisplayType: active ? nativeCosmetics.animated : nativeCosmetics.plain,
            loop: true
        }) : displayName;
    const plate = nativeCosmetics?.Nameplate
        ? React.createElement(nativeCosmetics.Nameplate, {
            nameplate: active ? equipped : null,
            hovered,
            content,
            placement: nativeCosmetics.placement
        }) : null;
    return React.createElement(React.Fragment, null,
        ReactDOM.createPortal(name, nameHost),
        ReactDOM.createPortal(plate, plateHost)
    );
}

function captureNativeActivityAsset() {
    if (nativeActivityAsset) return;
    const filter = filters.componentByCode("gameAppId:", "gameAssetUrl:", "size:32");
    nativeActivityAsset = findNativeExport("gameAppId:", "gameAssetUrl:", "size:32");
    if (nativeActivityAsset) return;
    // The current experiment keeps this component private. Locate it by its
    // native props/render signature, retaining Discord's application-loading hook.
    for (const image of lastShell?.querySelectorAll('img[alt="App icon"]') ?? []) {
        const key = Object.keys(image).find(name => name.startsWith("__reactFiber$"));
        for (let fiber = key ? (image as any)[key] : null; fiber; fiber = fiber.return) {
            if (!filter(fiber.type)) continue;
            nativeActivityAsset = fiber.type;
            return;
        }
    }
}

function normalizeActivityStart(start: unknown): number | null {
    // Live gateway activities can carry millisecond timestamps as numeric strings.
    // Use the same numeric coercion as native elapsed subtraction, rejecting
    // absent/invalid data rather than substituting created_at or the current time.
    if (typeof start !== "number" && typeof start !== "string" && !(start instanceof Date)) return null;
    if (typeof start === "string" && !start.trim()) return null;
    const timestamp = Number(start);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function formatActivityDuration(start: number, now = Date.now()) {
    const seconds = Math.max(0, Math.round((now - start) / 1000));
    if (nativeDuration) {
        try {
            return nativeDuration(seconds);
        } catch {
            nativeDuration = null;
        }
    }
    // Mirror the native formatter's boundaries, including its minimum 1m.
    if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d`;
    if (seconds < 31104000) return `${Math.floor(seconds / 2592000)}mo`;
    return `${Math.floor(seconds / 31104000)}y`;
}

function activitySubtitle(data: Pick<FriendRowData, "activityBaseText" | "activityStart" | "icon">) {
    if (data.activityBaseText == null) return null;
    if (data.activityStart == null) return data.activityBaseText;
    const duration = formatActivityDuration(data.activityStart);
    return data.icon === "voice" ? `Playing for ${duration}` : `${data.activityBaseText} • ${duration}`;
}

function refreshTimedActivities() {
    const list = lastShell?.querySelector<HTMLElement>(":scope > .maruFriendsList");
    list?.querySelectorAll<HTMLElement>(".maruFriendRow").forEach(row => {
        const data = friendRowData.get(row);
        if (!data || data.activityStart == null || data.activityBaseText == null) return;
        const subtitle = activitySubtitle(data);
        if (subtitle !== data.subtitle)
            friendRowUpdates.get(row)?.({ ...data, subtitle });
    });
    scheduleDurationUpdate();
}

function scheduleDurationUpdate() {
    if (durationTimer) clearTimeout(durationTimer);
    durationTimer = null;
    if (!selectedCategoryId || document.visibilityState === "hidden") return;
    const list = lastShell?.querySelector<HTMLElement>(":scope > .maruFriendsList");
    if (!list?.isConnected) return;
    const now = Date.now();
    let delay = Infinity;
    list.querySelectorAll<HTMLElement>(".maruFriendRow").forEach(row => {
        const data = friendRowData.get(row);
        if (!data || data.activityStart == null || data.activityBaseText == null) return;
        const seconds = Math.max(0, Math.round((now - data.activityStart) / 1000));
        const unit = seconds < 3600 ? 60 : seconds < 86400 ? 3600 : seconds < 2592000 ? 86400 : seconds < 31104000 ? 2592000 : 31104000;
        const next = Math.max(120, (Math.floor(seconds / unit) + 1) * unit);
        delay = Math.min(delay, data.activityStart + next * 1000 - 500 - now);
    });
    if (Number.isFinite(delay)) {
        durationTimer = setTimeout(() => {
            durationTimer = null;
            refreshTimedActivities();
        }, Math.max(100, Math.min(delay, 86400000)));
    }
}

function handleVisibilityChange() {
    if (document.visibilityState === "hidden") scheduleDurationUpdate();
    else refreshTimedActivities();
}

function classifyFriend(status: string, gameName: string | null, voiceChannelId: string | null): SectionKey {
    if (["offline", "invisible", "unknown"].includes(status)) return "offline";
    return gameName != null || voiceChannelId != null ? "active_now" : "online";
}

function isSectionCollapsed(key: SectionKey) {
    return dualSidebarSettings.store.collapsedSections?.[key] === true;
}

function updateSectionVisibility(section: HTMLElement, compact: boolean) {
    const key = section.dataset.maruSection as SectionKey;
    const header = section.querySelector<HTMLButtonElement>(".maruFriendsSectionHeader")!;
    const rows = section.querySelector<HTMLElement>(".maruFriendsSectionRows")!;
    // Compact is an overview; the saved preference belongs only to expanded mode.
    const collapsed = !compact && isSectionCollapsed(key);
    rows.hidden = collapsed;
    header.disabled = compact;
    header.tabIndex = compact ? -1 : 0;
    header.style.cursor = compact ? "default" : "";
    if (compact) {
        header.removeAttribute("aria-expanded");
        header.setAttribute("role", "presentation");
    } else {
        header.setAttribute("aria-expanded", String(!collapsed));
        header.removeAttribute("role");
    }
    header.setAttribute("aria-label", compact ? header.title : (collapsed ? "Expand " : "Collapse ") + header.title);
    renderNativeIcon(section.querySelector<HTMLElement>(".maruFriendsSectionChevron")!, collapsed ? "chevron_right" : "chevron_down", { size: "xs", color: "var(--icon-muted)" });
}

function setCompactLayout(shell: HTMLElement) {
    const list = shell.querySelector<HTMLElement>(":scope > .maruFriendsList");
    if (!list) return;
    const compact = shell.getBoundingClientRect().width <= 80;
    if (list.dataset.maruCompact !== String(compact)) {
        list.dataset.maruCompact = String(compact);
        hideMaruFriendTooltip(true);
        for (const section of list.querySelectorAll<HTMLElement>(".maruFriendsSection")) {
            updateSectionVisibility(section, compact);
            renderSectionMarker(section, shell);
        }
        list.dispatchEvent(new Event("maruFriendsLayoutChange"));
    }
}

function observeSidebarWidth(shell: HTMLElement) {
    if (observedShell !== shell) {
        widthObserver?.disconnect();
        observedShell = shell;
        widthObserver = new ResizeObserver(() => setCompactLayout(shell));
        widthObserver.observe(shell);
    }
    setCompactLayout(shell);
}

function unmountAvatars(container?: HTMLElement) {
    if (!container || (activeProfileBridge && container.contains(activeProfileBridge.row))) closeActiveProfile?.();
    unmountNativeIcons(container);
    for (const [element, root] of avatarRoots) {
        if (!container || container.contains(element)) {
            avatarRoots.delete(element);
            root.unmount();
        }
    }
}

function getSelectedCategory() {
    if (!selectedCategoryId)
        return null;

    const category = currentUserCategories.find(category => category.id === selectedCategoryId);

    if (!category)
        selectedCategoryId = null;

    return category ?? null;
}

function getCategoryUserIds(category: { channels: string[]; }) {
    const userIds = category.channels
        .map(channelId => ChannelStore.getChannel(channelId)?.recipients?.[0])
        .filter((id): id is string => Boolean(id));

    return [...new Set(userIds)];
}

function findModeButton(shell: HTMLElement): HTMLElement | null {
    const buttons = [...shell.querySelectorAll<HTMLElement>(
        '[role="button"][class*="modeSelectButton_"]'
    )];

    return buttons.find(button => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();

        return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0;
    }) ?? null;
}

function updateModeButtonLabel(shell: HTMLElement) {
    const button = findModeButton(shell);

    if (!button)
        return;

    const label = getSelectedCategory()?.name ?? "Friends";
    const text = button.querySelector("span");

    button.setAttribute("aria-label", label);

    if (text)
        text.textContent = label;
}

function selectSidebarMode(categoryId: string | null) {
    const list = lastShell?.querySelector<HTMLElement>(":scope > .maruFriendsList");
    if (list && selectedCategoryId)
        categoryScrollPositions.set(selectedCategoryId, list.scrollTop);
    hideMaruFriendTooltip(true);
    if (selectedCategoryId !== categoryId) closeActiveProfile?.();
    selectedCategoryId = categoryId;

    if (lastShell && document.contains(lastShell))
        populateFriendsSidebar(lastShell);
}

function openSidebarModeMenu(event: MouseEvent) {
    ContextMenuApi.openContextMenu(
        event as any,
        () => React.createElement(
            Menu.Menu,
            {
                navId: "maru-friends-sidebar-mode-menu",
                onClose: ContextMenuApi.closeContextMenu,
                "aria-label": "Friends Sidebar View"
            },
            React.createElement(Menu.MenuItem, {
                id: "maru-friends-sidebar-mode-friends",
                label: "Friends",
                action: () => selectSidebarMode(null)
            }),
            ...currentUserCategories.map(category =>
                React.createElement(Menu.MenuItem, {
                    key: category.id,
                    id: `maru-friends-sidebar-mode-${category.id}`,
                    label: category.name,
                    action: () => selectSidebarMode(category.id)
                })
            )
        )
    );
}

function handleModeButtonClick(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    openSidebarModeMenu(event);
}

function setupModeButton(shell: HTMLElement) {
    const button = findModeButton(shell);

    if (!button)
        return;

    if (modeButton !== button) {
        modeButton?.removeEventListener("click", handleModeButtonClick);

        modeButton = button;

        button.style.setProperty("-webkit-app-region", "no-drag", "important");
        button.querySelectorAll<HTMLElement>("*").forEach(element =>
            element.style.setProperty("-webkit-app-region", "no-drag", "important")
        );

        if (!button.hasAttribute("data-maru-previous-label"))
            button.setAttribute(
                "data-maru-previous-label",
                button.getAttribute("aria-label") ?? "Friends"
            );

        const text = button.querySelector("span");

        if (text && !text.hasAttribute("data-maru-previous-text"))
            text.setAttribute(
                "data-maru-previous-text",
                text.textContent ?? "Friends"
            );

        button.addEventListener("click", handleModeButtonClick);
    }

    updateModeButtonLabel(shell);
}

function restoreModeButton() {
    if (!modeButton)
        return;

    modeButton.removeEventListener("click", handleModeButtonClick);

    const previousLabel = modeButton.getAttribute("data-maru-previous-label");
    const text = modeButton.querySelector("span");
    const previousText = text?.getAttribute("data-maru-previous-text");

    if (previousLabel !== null) {
        modeButton.setAttribute("aria-label", previousLabel);
        modeButton.removeAttribute("data-maru-previous-label");
    }

    if (text && previousText != null) {
        text.textContent = previousText;
        text.removeAttribute("data-maru-previous-text");
    }

    modeButton = null;
    selectedCategoryId = null;
}

function findNativeFriendsHeader(shell: HTMLElement, button: HTMLElement | null) {
    // The closed native organizer wraps its button in a tooltip span.
    const header = button?.closest<HTMLElement>('[class*="header_"]');
    return header && header !== shell && shell.contains(header) ? header : null;
}

function captureNativeOrganizerLayer(button: HTMLElement) {
    const layers = find(exports => exports && typeof exports === "object" &&
        Object.values(exports).some((value: any) => value?.displayName === "AppLayerProvider"));
    const Context = Object.values(layers ?? {}).find((value: any) => value?.$$typeof === Symbol.for("react.context")) as any;
    if (!Context) return null;
    const key = Object.keys(button).find(name => name.startsWith("__reactFiber$"));
    for (let fiber = key ? (button as any)[key] : null; fiber; fiber = fiber.return) {
        if (fiber.type !== Context && fiber.type?._context !== Context) continue;
        const value = fiber.memoizedProps?.value;
        const target = Array.isArray(value) ? value[0] : null;
        if (target?.nodeType === 1 && target.isConnected && target.ownerDocument === button.ownerDocument)
            return { Context, value };
        return null;
    }
    return null;
}

function captureNativeOrganizer(shell: HTMLElement) {
    if (nativeOrganizer) return nativeOrganizer;
    const button = findModeButton(shell);
    if (!button) return null;

    const factoryFilter = filters.byCode("width:", "closePopout:");
    const menuFilter = filters.componentByCode("friends-list-group-config", "getGroupingMode", "isVoiceGroupingEnabled");
    const popoutFilter = filters.componentByCode("targetElementRef", "renderPopout", "onRequestClose");
    const buttonFilter = filters.componentByCode("tooltipPosition:", "buttonRef:", "innerRef:");
    let Popout: any;
    let Button: any;
    let renderMenu: (() => React.ReactElement<any>) | undefined;
    const fiberKey = Object.keys(button).find(key => key.startsWith("__reactFiber$"));
    for (let fiber = fiberKey ? (button as any)[fiberKey] : null; fiber; fiber = fiber.return) {
        const factory = fiber.memoizedProps?.renderPopout;
        if (!factoryFilter(factory) || !popoutFilter(fiber.type)) continue;
        // This factory only creates the native menu element; it does not run
        // its hooks or actions. Keep its live native width ref and menu props.
        const element = factory();
        if (menuFilter(element?.type)) {
            Popout = fiber.type;
            renderMenu = factory;
            break;
        }
    }
    for (const control of findNativeFriendsHeader(shell, button)?.querySelectorAll('[role="button"]') ?? []) {
        const key = Object.keys(control).find(key => key.startsWith("__reactFiber$"));
        for (let fiber = key ? (control as any)[key] : null; fiber; fiber = fiber.return) {
            if (buttonFilter(fiber.type)) {
                Button = fiber.type;
                break;
            }
        }
        if (Button) break;
    }
    const Icon = findNativeExport("M16.3 21.7a1 1 0 0 0 1.4 0"); // Native ArrowsUpDownIcon export.
    const layer = captureNativeOrganizerLayer(button);
    // Private experiment components must match. Never substitute a custom menu.
    if (!Popout || !Button || !Icon || !renderMenu || !layer) return null;
    return nativeOrganizer = { Popout, Button, Icon, renderMenu, layer };
}

function NativeOrganizerButton({ visible, organizer }: { visible: boolean; organizer: NonNullable<typeof nativeOrganizer>; }) {
    // Only transient popout visibility is local. Organization settings, options
    // and persistence remain entirely inside Discord's native menu component.
    const [open, setOpen] = React.useState(false);
    const buttonRef = React.useRef<HTMLElement>(null);
    const close = React.useCallback(() => setOpen(false), []);
    React.useEffect(() => { if (!visible) close(); }, [visible, close]);
    React.useLayoutEffect(() => {
        buttonRef.current?.setAttribute("aria-haspopup", "menu");
        buttonRef.current?.setAttribute("aria-expanded", String(open));
    }, [visible, open]);
    if (!visible) return null;
    return React.createElement(organizer.Popout, {
        targetElementRef: buttonRef,
        shouldShow: open,
        onRequestClose: close,
        position: "bottom",
        align: "right",
        renderPopout: () => React.cloneElement(organizer.renderMenu(), { closePopout: close })
    }, (() => React.createElement(organizer.Button, {
            icon: organizer.Icon,
            label: "Sort Friends",
            buttonRef,
            onClick: () => setOpen(value => !value)
    })) as any);
}

function removeSortControl() {
    sortControl?.root.unmount();
    sortControl?.host.remove();
    sortControl = null;
    nativeOrganizer = null;
}

function setupSortControl(shell: HTMLElement) {
    if (sortControl && (sortControl.shell !== shell || !sortControl.host.isConnected)) removeSortControl();
    const expanded = shell.getBoundingClientRect().width > 80;
    const visible = expanded && getSelectedCategory() === null;
    if (!sortControl && visible) {
        const button = findModeButton(shell);
        const buttons = [...findNativeFriendsHeader(shell, button)?.querySelectorAll<HTMLElement>('[role="button"][class*="button_"]') ?? []];
        const toggle = buttons.at(-1);
        const parent = toggle?.parentElement;
        if (buttons.length !== 3 || !parent || !buttons.every(control => control.parentElement === parent)) return;
        const organizer = captureNativeOrganizer(shell);
        if (!organizer) return;
        const host = document.createElement("div");
        host.className = "maruFriendsSortControl";
        // No extra header box, padding or styling; the native Button owns these.
        host.style.display = "contents";
        parent.insertBefore(host, toggle!);
        sortControl = { shell, host, root: createRoot(host), visible: false };
    }
    if (!sortControl || !nativeOrganizer || sortControl.visible === visible) return;
    sortControl.visible = visible;
    sortControl.host.style.display = visible ? "contents" : "none";
    // This separate root must inherit the header's native popup destination.
    // Without it, Discord's AppLayer portal silently returns null.
    sortControl.root.render(inheritNativeSidebarContexts(React.createElement(ErrorBoundary, { noop: true },
        React.createElement(nativeOrganizer.layer.Context.Provider, { value: nativeOrganizer.layer.value },
            React.createElement(NativeOrganizerButton, { visible, organizer: nativeOrganizer })))).node);
}

const STYLE_ID = "maru-friends-sidebar-style";

function installStyles() {
    document.getElementById(STYLE_ID)?.remove();

    styleElement = document.createElement("style");
    styleElement.id = STYLE_ID;

    styleElement.textContent = `
        .maruFriendsList::-webkit-scrollbar {
            width: 8px;
            background: transparent;
        }

        .maruFriendsList::-webkit-scrollbar-track {
            background: transparent;
        }

        .maruFriendsList::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.28);
            border: 2px solid transparent;
            background-clip: padding-box;
            border-radius: 10px;
        }

        .maruFriendsList::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.42);
            border: 2px solid transparent;
            background-clip: padding-box;
        }

        .maruFriendRow {
            width: 100%;
            transition: background-color 120ms ease;
        }

        .maruFriendRow:hover {
            background: var(--background-mod-subtle, rgba(255, 255, 255, 0.06));
        }

        .maruFriendsList {
            scrollbar-gutter: stable both-edges;
            font-family: var(--font-primary);
        }

        .maruFriendsSectionHeader {
            width: 100%;
            height: 40px;
            padding: 12px 8px 4px;
            box-sizing: border-box;
            background: transparent;
            border: 0;
            color: var(--text-muted, var(--text-subtle));
            font: inherit;
            cursor: pointer;
            text-align: start;
        }

        .maruFriendsSectionHeading {
            display: flex;
            align-items: center;
            gap: 8px;
            height: 24px;
            min-width: 0;
        }

        .maruFriendsSectionMarker {
            display: grid;
            place-items: center;
            flex: none;
            width: 18px;
            height: 18px;
            color: var(--icon-muted, var(--text-muted));
        }

        .maruFriendsSectionHeader.maruFriendsSectionSeparated {
            height: 52px;
            padding-inline: 0;
        }

        .maruFriendsSectionSeparated .maruFriendsSectionHeading {
            padding-inline: var(--space-8);
        }

        .maruFriendsSectionLabel {
            font-size: 14px;
            line-height: 18px;
            font-weight: 500;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
        }

        .maruFriendsSectionChevron {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 18px;
            height: 18px;
            margin-inline-start: auto;
            color: var(--icon-muted, var(--text-muted));
            flex: none;
        }

        .maruFriendsSectionHeader:focus-visible,
        .maruFriendRow:focus-visible {
            outline: 2px solid var(--focus-primary, var(--brand-500));
            outline-offset: -2px;
        }

        .maruFriendsList [hidden] { display: none !important; }

        .maruFriendsList[data-maru-compact="true"] .maruFriendsSectionLabel,
        .maruFriendsList[data-maru-compact="true"] .maruFriendsSectionChevron,
        .maruFriendsList[data-maru-compact="true"] .maruFriendBody,
        .maruFriendsList[data-maru-compact="true"] .maruFriendGameAsset {
            display: none !important;
        }

        .maruFriendsList[data-maru-compact="true"] .maruFriendsSectionHeading,
        .maruFriendsList[data-maru-compact="true"] .maruFriendRow,
        .maruFriendsList[data-maru-compact="true"] .maruFriendContent {
            justify-content: center;
        }
    `;

    document.head.appendChild(styleElement);
}

function createSection(key: SectionKey, label: string) {
    const section = document.createElement("section");
    section.className = "maruFriendsSection";
    section.dataset.maruSection = key;
    const header = document.createElement("button");
    header.className = "maruFriendsSectionHeader";
    header.type = "button";
    header.title = label;
    const heading = document.createElement("div");
    heading.className = "maruFriendsSectionHeading";
    const marker = document.createElement("span");
    marker.className = "maruFriendsSectionMarker";
    const text = document.createElement("span");
    text.className = "maruFriendsSectionLabel";
    text.textContent = label;
    const chevron = document.createElement("span");
    chevron.className = "maruFriendsSectionChevron";
    heading.append(marker, text, chevron);
    header.appendChild(heading);
    const rows = document.createElement("div");
    rows.className = "maruFriendsSectionRows";
    rows.id = `maru-friends-section-${key}`;
    header.setAttribute("aria-controls", rows.id);
    header.addEventListener("click", () => {
        if (section.closest<HTMLElement>(".maruFriendsList")?.dataset.maruCompact === "true") return;
        dualSidebarSettings.store.collapsedSections = {
            ...dualSidebarSettings.store.collapsedSections,
            [key]: !isSectionCollapsed(key)
        };
        hideMaruFriendTooltip(true);
        if (lastShell) populateFriendsSidebar(lastShell);
    });
    section.append(header, rows);
    return section;
}

function findFriendsSidebarShell(): HTMLElement | null {
    const handle = document.querySelector<HTMLElement>(
        '[role="separator"][aria-label="Resize Friends List"]'
    );

    return handle?.parentElement ?? null;
}

let nativeUserPopoutComponent: any = null;
let closeActiveProfile: (() => void) | null = null;
interface ProfileBridge {
    userId: string;
    row: HTMLElement;
    pending: MouseEvent[];
    trigger: ((event: MouseEvent) => void) | null;
}
let activeProfileBridge: ProfileBridge | null = null;

function getNativeUserPopoutComponent(): any | null {
    if (nativeUserPopoutComponent) return nativeUserPopoutComponent;
    // This is the exported user/current-user resolver used by native Friends.
    // Discover the export directly: row roles and intermediate fibers can change,
    // and the native list may be hidden or virtualized in a custom category.
    try {
        nativeUserPopoutComponent = find(filters.componentByCode(
            /children:\w+,userId:\w+,user:\w+,\.\.\.\w+/,
            "getCurrentUser()", ".getUser(", "currentUser:"
        ), { isIndirect: true });
    } catch {
        nativeUserPopoutComponent = null;
    }
    if (!nativeUserPopoutComponent)
        console.warn("[MaruFriendsSidebar] Native user popout export unavailable");
    return nativeUserPopoutComponent;
}

function inheritNativeSidebarContexts(node: React.ReactNode) {
    let nativeElement: HTMLElement | null = lastShell;
    let fiber: any;
    while (nativeElement && !fiber) {
        const key = Object.keys(nativeElement).find(key => key.startsWith("__reactFiber$"));
        if (key) fiber = (nativeElement as any)[key];
        nativeElement = nativeElement.parentElement;
    }
    const seen = new Set<any>();
    // Read provider identities and values, never assume a number of ancestors
    // or identify user-popout components from a private fiber hierarchy.
    while (fiber) {
        const context = fiber.type?._context ?? fiber.type;
        const props = fiber.memoizedProps;
        if (context?.Provider && props && Object.prototype.hasOwnProperty.call(props, "value") && !seen.has(context)) {
            seen.add(context);
            node = React.createElement(context.Provider, { value: props.value }, node);
        }
        fiber = fiber.return;
    }
    return { node, hasContexts: seen.size > 0 };
}

function AutoOpenNativeUserPopout({ NativeUserPopout, user, bridge }: {
    NativeUserPopout: any;
    user: any;
    bridge: ProfileBridge;
}) {
    const targetElementRef = React.useRef(bridge.row);
    React.useEffect(() => {
        const frame = requestAnimationFrame(() => {
            for (const event of bridge.pending.splice(0)) bridge.trigger?.(event);
        });
        return () => {
            cancelAnimationFrame(frame);
            bridge.trigger = null;
            bridge.pending.length = 0;
        };
    }, [bridge]);
    return React.createElement(NativeUserPopout, {
        targetElementRef,
        user,
        position: "left",
        spacing: 16,
        // Keep native uncontrolled state and its close/outside/escape lifecycle.
        // The real row is also the target, so its second click is not dismissed
        // as an outside click before the native toggle handler receives it.
        children: (triggerProps: any) => {
            bridge.trigger = event => {
                triggerProps.onMouseDown?.(event);
                triggerProps.onClick?.({ nativeEvent: event, shiftKey: event.shiftKey });
            };
            return null;
        }
    });
}

function openNativeUserProfileCard(event: MouseEvent, user: any) {
    const NativeUserPopout = getNativeUserPopoutComponent();

    if (!NativeUserPopout)
        return;

    const target = event.currentTarget as HTMLElement;
    const activeBridge = activeProfileBridge;
    if (activeBridge && activeBridge.userId === user.id && activeBridge.row === target) {
        if (activeBridge.pending.length || !activeBridge.trigger)
            activeBridge.pending.push(event);
        else activeBridge.trigger(event);
        return;
    }
    closeActiveProfile?.();
    const bridge: ProfileBridge = { userId: user.id, row: target, pending: [event], trigger: null };
    activeProfileBridge = bridge;

    // A context-menu host installs a click trap and consumes the next row click.
    // Give this native popout its own root, inheriting the native sidebar's
    // provider values so Discord can render into its existing window layers.
    const host = document.createElement("div");
    host.dataset.maruProfileHost = user.id;
    document.body.appendChild(host);
    const root = createRoot(host);
    let closed = false;
    const closeBridge = () => {
        if (closed) return;
        closed = true;
        if (closeActiveProfile === closeBridge) closeActiveProfile = null;
        if (activeProfileBridge === bridge) activeProfileBridge = null;
        root.unmount();
        host.remove();
    };
    closeActiveProfile = closeBridge;

    const node: React.ReactNode = React.createElement(AutoOpenNativeUserPopout, {
        NativeUserPopout,
        user,
        bridge
    });
    const inherited = inheritNativeSidebarContexts(node);
    if (!inherited.hasContexts) {
        console.warn("[MaruFriendsSidebar] Native sidebar context unavailable");
        closeBridge();
        return;
    }
    root.render(inherited.node);
}

let activeMaruFriendTooltip: HTMLElement | null = null;
let activeMaruFriendTooltipAnimation: Animation | null = null;
let activeMaruFriendTooltipRemoveTimer: ReturnType<typeof setTimeout> | null = null;
let activeMaruFriendTooltipUserId: string | null = null;
let activeMaruFriendTooltipHideTimer: ReturnType<typeof setTimeout> | null = null;

function hideMaruFriendTooltip(immediate = false) {
    if (activeMaruFriendTooltipHideTimer) {
        clearTimeout(activeMaruFriendTooltipHideTimer);
        activeMaruFriendTooltipHideTimer = null;
    }

    const wrapper = activeMaruFriendTooltip;

    if (!wrapper)
        return;

    activeMaruFriendTooltipAnimation?.cancel();
    activeMaruFriendTooltipAnimation = null;

    if (activeMaruFriendTooltipRemoveTimer) {
        clearTimeout(activeMaruFriendTooltipRemoveTimer);
        activeMaruFriendTooltipRemoveTimer = null;
    }

    if (immediate) {
        wrapper.remove();

        if (activeMaruFriendTooltip === wrapper) {
            activeMaruFriendTooltip = null;
            activeMaruFriendTooltipUserId = null;
        }

        return;
    }

    const style = getComputedStyle(wrapper);
    const startingOpacity = Number.parseFloat(style.opacity) || 1;
    const startingTransform =
        style.transform === "none"
            ? "scale(1)"
            : style.transform;

    activeMaruFriendTooltipAnimation = wrapper.animate(
        [
            {
                opacity: startingOpacity,
                transform: startingTransform,
                offset: 0
            },
            {
                opacity: 0,
                transform: "scale(0.948)",
                offset: 0.265
            },
            {
                opacity: 0.018,
                transform: "scale(0.9509)",
                offset: 0.73
            },
            {
                opacity: 0,
                transform: "scale(0.95)",
                offset: 1
            }
        ],
        {
            duration: 180,
            easing: "linear",
            fill: "forwards"
        }
    );

    activeMaruFriendTooltipAnimation.onfinish = () => {
        activeMaruFriendTooltipAnimation = null;

        // Native trial lost render eligibility around 180ms but remained
        // mounted until roughly 229ms after pointer exit.
        activeMaruFriendTooltipRemoveTimer = setTimeout(() => {
            wrapper.remove();

            if (activeMaruFriendTooltip === wrapper) {
                activeMaruFriendTooltip = null;
                activeMaruFriendTooltipUserId = null;
            }

            activeMaruFriendTooltipRemoveTimer = null;
        }, 49);
    };
}

function showMaruFriendTooltip(
    row: HTMLElement,
    user: any,
    activityText: string | null,
    displayName = user.globalName || user.username
) {
    const shell = findFriendsSidebarShell();

    // Native compact rail is ~64px. Never show these tooltips while the
    // sidebar is expanded.
    if (!shell || shell.getBoundingClientRect().width > 80)
        return;

    if (activeMaruFriendTooltipHideTimer) {
        clearTimeout(activeMaruFriendTooltipHideTimer);
        activeMaruFriendTooltipHideTimer = null;
    }

    // A presence refresh may replace the row underneath a stationary cursor.
    // If the newly hovered row belongs to the same user, keep the existing
    // tooltip alive instead of restarting its entrance animation.
    if (
        activeMaruFriendTooltip &&
        activeMaruFriendTooltipUserId === user.id
    ) {
        return;
    }

    hideMaruFriendTooltip(true);

    const wrapper = document.createElement("div");

    wrapper.className = "maruFriendTooltipLayer";

    wrapper.style.cssText = `
        position: fixed;
        left: 0;
        top: 0;
        z-index: 1;
        pointer-events: none;
        transform-origin: right center;
        opacity: 0;
        transform: scale(0.95);
    `;

    const tooltip = document.createElement("div");

    tooltip.className = "maruFriendTooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.setAttribute("data-position", "left");

    tooltip.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        padding: 8px 12px;
        margin: 0;
        border: 0;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.75);
        box-shadow:
            oklab(0.678923 0.00325415 -0.0111644 / 0.2) 0 0 0 1px inset,
            rgba(0, 0, 0, 0.24) 0 12px 24px 0;
        overflow: visible;
        pointer-events: none;
        text-align: center;
        white-space: nowrap;
        font-family:
            "gg sans",
            "Noto Sans",
            "Helvetica Neue",
            Helvetica,
            Arial,
            sans-serif;
        max-width: ${activityText ? "none" : "200px"};
    `;

    const username = document.createElement("div");
    username.className = "maruFriendTooltipUsername";

    username.textContent = displayName;

    username.style.cssText = `
        color: var(--text-normal, #dedede);
        font-size: 14px;
        font-weight: 500;
        line-height: 18px;
        text-align: center;
    `;

    tooltip.appendChild(username);

    if (activityText) {
        const activity = document.createElement("div");
        activity.className = "maruFriendTooltipActivity";

        activity.textContent = activityText;

        activity.style.cssText = `
            color: var(--text-subtle, #aaa);
            font-size: 14px;
            font-weight: 400;
            line-height: 18px;
            text-align: center;
        `;

        tooltip.appendChild(activity);
    }

    wrapper.appendChild(tooltip);
    // Share Discord's app stacking context: its native window layers stay
    // above this tooltip even when NAAT changes their internal priorities.
    (shell.closest("#app-mount") ?? document.body).appendChild(wrapper);

    const rowRect = row.getBoundingClientRect();

    // offsetWidth/offsetHeight are unaffected by the wrapper's scale transform.
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;

    const horizontalGap = 11.2;

    let left =
        rowRect.left -
        tooltipWidth -
        horizontalGap;

    let top =
        rowRect.top +
        ((rowRect.height - tooltipHeight) / 2);

    left = Math.max(8, left);
    top = Math.max(
        8,
        Math.min(
            window.innerHeight - tooltipHeight - 8,
            top
        )
    );

    wrapper.style.left = `${left}px`;
    wrapper.style.top = `${top}px`;

    activeMaruFriendTooltip = wrapper;
    activeMaruFriendTooltipUserId = user.id;

    activeMaruFriendTooltipAnimation = wrapper.animate(
        [
            {
                opacity: 0,
                transform: "scale(0.95)",
                offset: 0
            },
            {
                opacity: 1,
                transform: "scale(1.0067)",
                offset: 0.285
            },
            {
                opacity: 0.982,
                transform: "scale(0.9991)",
                offset: 0.59
            },
            {
                opacity: 1,
                transform: "scale(1)",
                offset: 1
            }
        ],
        {
            duration: 233,
            easing: "linear",
            fill: "forwards"
        }
    );

    activeMaruFriendTooltipAnimation.onfinish = () => {
        if (activeMaruFriendTooltip !== wrapper)
            return;

        wrapper.style.opacity = "1";
        wrapper.style.transform = "none";

        activeMaruFriendTooltipAnimation?.cancel();
        activeMaruFriendTooltipAnimation = null;
    };
}

function updateMaruFriendTooltip(row: HTMLElement, data: FriendRowData) {
    if (activeMaruFriendTooltipUserId !== data.user.id || !activeMaruFriendTooltip) return;
    const tooltip = activeMaruFriendTooltip.querySelector<HTMLElement>(".maruFriendTooltip");
    if (!tooltip) return;
    const username = tooltip.querySelector<HTMLElement>(".maruFriendTooltipUsername");
    if (username) username.textContent = data.displayName;
    let activity = tooltip.querySelector<HTMLElement>(".maruFriendTooltipActivity");
    if (!data.subtitle) {
        activity?.remove();
    } else {
        if (!activity) {
            activity = document.createElement("div");
            activity.className = "maruFriendTooltipActivity";
            activity.style.cssText = "color: var(--text-subtle, #aaa); font-size: 14px; font-weight: 400; line-height: 18px; text-align: center;";
            tooltip.appendChild(activity);
        }
        activity.textContent = data.subtitle;
    }
    tooltip.style.maxWidth = data.subtitle ? "none" : "200px";
    const rect = row.getBoundingClientRect();
    activeMaruFriendTooltip.style.left = `${Math.max(8, rect.left - tooltip.offsetWidth - 11.2)}px`;
    activeMaruFriendTooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - tooltip.offsetHeight - 8, rect.top + (rect.height - tooltip.offsetHeight) / 2))}px`;
}

function getFriendRowData(id: string): FriendRowData | null {
    const user = UserStore.getUser(id);

    if (!user)
        return null;

    const rawStatus = PresenceStore.getStatus?.(id) || "offline";
    const status = ["invisible", "unknown"].includes(rawStatus) ? "offline" : rawStatus;
    const activities = PresenceStore.getActivities?.(id) || [];
    const nativeRow = nativeFriendRows?.getRow(id);
    const gameIndex = activities.findIndex((activity: any) => activity.type === 0 || activity.type === 5);
    // Discord selects the first PLAYING/COMPETING activity, otherwise the first
    // activity. In particular, music alone does not qualify for Active Now.
    const activity = activities[nativeRow?.gameActivityIndex ?? (gameIndex < 0 ? 0 : gameIndex)];
    const gameName = nativeRow ? nativeRow.gameName : gameIndex < 0 ? null : activities[gameIndex].name ?? null;
    const voiceChannelId = nativeRow ? nativeRow.voiceChannelId : VoiceStateStore.getVoiceStateForUser(id)?.channelId ?? null;
    const hasRichActivity = activity?.type === 0 || activity?.type === 5;
    let icon: ActivityIcon = null;
    let activityBaseText: string | null = null;
    let activityStart: number | null = null;
    let emoji: FriendRowData["emoji"] = null;

    if (voiceChannelId != null) {
        icon = "voice";
        const start = gameName != null ? activity?.timestamps?.start : null;
        activityStart = normalizeActivityStart(start);
        activityBaseText = "In voice";
    } else if (activity) {
        icon = hasRichActivity ? "game" : activity.type === 2 ? "music" : activity.type === 3 ? "watching" : activity.type === 4 ? "custom" : null;
        if (icon === "custom") {
            emoji = activity.emoji ?? null;
            activityBaseText = activity.state ?? (emoji ? "" : null);
        } else if (icon) {
            try {
                activityBaseText = nativeActivityText?.(activity)?.text ?? null;
            } catch {
                activityBaseText = null;
            }
            activityBaseText ??= activity.status_display_type === 1
                ? activity.state || activity.name || null
                : activity.status_display_type === 2
                    ? activity.details || activity.name || null
                    : activity.name || null;
        }
        const start = activity.timestamps?.start;
        if (icon) activityStart = normalizeActivityStart(start);
    }
    const subtitle = activityBaseText == null ? null : activityStart == null
        ? activityBaseText
        : icon === "voice" ? `Playing for ${formatActivityDuration(activityStart)}`
            : `${activityBaseText} • ${formatActivityDuration(activityStart)}`;
    let gameAssetUrl = nativeRow?.gameAssetUrl ?? null;
    const gameAppId = nativeRow ? nativeRow.gameAppId ?? null
        : gameIndex < 0 ? null : activities[gameIndex].application_id ?? null;
    if (!nativeRow && gameIndex >= 0) {
        const game = activities[gameIndex];
        const asset = game.assets?.large_image ?? game.assets?.small_image;
        if (asset) {
            try {
                gameAssetUrl = ApplicationAssetUtils.getAssetImage(game.application_id, asset, 64) ?? null;
            } catch {
                gameAssetUrl = null;
            }
        }
    }

    return {
        user,
        status,
        avatarSrc: user.getAvatarURL(null, 32, false),
        displayName: nativeRow?.name ?? RelationshipStore.getNickname(id) ?? user.globalName ?? user.username,
        subtitle,
        hasRichActivity,
        section: classifyFriend(status, gameName, voiceChannelId),
        icon,
        emoji,
        activityStart,
        activityBaseText,
        gameAssetUrl,
        gameAppId,
        voiceIcon: icon === "voice" ? nativeChannelIcon?.(ChannelStore.getChannel(voiceChannelId)) ?? null : null
    };
}

function createFriendRow(id: string, data: FriendRowData): HTMLElement {
    let current = data;
    const row = document.createElement("div");
    row.classList.add("maruFriendRow");
    row.dataset.maruUserId = id;
    friendRowData.set(row, data);
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.setAttribute("aria-label", `${data.displayName}${data.subtitle ? `, ${data.subtitle}` : ""}`);

    row.style.cssText = `
        height: 48px;
        padding: 8px;
        display: flex;
        align-items: center;
        gap: 8px;
        box-sizing: border-box;
        border-radius: 8px;
        flex: none;
        position: relative;
    `;

    const content = document.createElement("div");
    content.className = "maruFriendContent";
    content.style.cssText = "display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;";
    const contentRef = { current: content };
    const plateHost = document.createElement("div");
    plateHost.className = "maruFriendNameplateHost";
    plateHost.style.cssText = "display: contents; border-radius: inherit;";

    const avatarWrap = document.createElement("div");

    avatarWrap.style.cssText = `
        width: 32px;
        height: 32px;
        position: relative;
        flex: none;
    `;

    // Let Discord render the native status masks, colors and avatar cutout.
    // SIZE_32 matches the preserved 32px avatar / 10px status geometry.
    // Only supply a static URL so animated PFPs remain static on hover, too.
    const avatarRoot = createRoot(avatarWrap);
    avatarRoots.set(avatarWrap, avatarRoot);
    const text = document.createElement("div");
    text.className = "maruFriendBody";

    text.style.cssText = `
        min-width: 0;
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
    `;

    const name = document.createElement("div");

    if (!friendCosmeticsComponent) name.textContent = data.displayName;

    name.style.cssText = `
        color: var(--text-default, var(--text-normal));
        font-size: 16px;
        line-height: 20px;
        font-weight: 400;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    `;

    text.appendChild(name);

    const gameAssetHost = document.createElement("span");
    gameAssetHost.className = "maruFriendGameAsset";
    gameAssetHost.style.cssText = "width: 32px; height: 32px; flex: none; display: flex; align-items: center;";
    let assetRenderer = nativeActivityAsset;

    function renderVisuals(data: FriendRowData) {
        assetRenderer = nativeActivityAsset;
        // Native theme context selects the equipped Nameplate palette.
        // Reuse the same provider bridge as profiles, keeping this root stable.
        avatarRoot.render(inheritNativeSidebarContexts(React.createElement(React.Fragment, null,
            friendAvatarComponent
                ? React.createElement(friendAvatarComponent, { userId: id, avatarSrc: data.avatarSrc, status: data.status, row })
                : plainFriendAvatar({ userId: id, avatarSrc: data.avatarSrc, status: data.status, row }),
            friendCosmeticsComponent && React.createElement(friendCosmeticsComponent, {
                user: data.user,
                displayName: data.displayName,
                row,
                nameHost: name,
                plateHost,
                content: contentRef
            }),
            assetRenderer && (data.gameAppId || data.gameAssetUrl) && ReactDOM.createPortal(
                React.createElement(ErrorBoundary, { noop: true },
                    React.createElement(assetRenderer, { gameAppId: data.gameAppId, gameAssetUrl: data.gameAssetUrl })),
                gameAssetHost)
        )).node);
    }
    renderVisuals(data);

    function createActivity(data: FriendRowData) {
        const activity = document.createElement("div");

        activity.style.cssText = `
            display: flex;
            align-items: center;
            gap: 4px;
            min-width: 0;
            overflow: hidden;
        `;

        if (data.icon) {
            const host = document.createElement("span");
            host.style.cssText = "display: flex; align-items: center; flex: none;";
            if (data.icon === "custom") {
                if (data.emoji) renderNativeIcon(host, "custom", { emoji: data.emoji, hideTooltip: true });
            } else if (data.icon === "voice") {
                renderNativeIcon(host, "game", { size: "xxs", color: "var(--text-voice-connected)" }, data.voiceIcon);
            } else {
                renderNativeIcon(host, data.icon, { size: "xxs", color: "var(--icon-voice-connected)" });
            }
            if (nativeIconRoots.has(host)) activity.appendChild(host);
        }

        const activityText = document.createElement("div");
        activityText.textContent = data.subtitle;
        activityText.style.cssText = `
            color: ${data.hasRichActivity ? "var(--text-voice-connected)" : "var(--text-muted, var(--text-subtle))"};
            font-size: 12px;
            line-height: 16px;
            font-weight: 400;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
        `;

        activity.appendChild(activityText);
        return activity;
    }

    let activity = data.subtitle != null ? createActivity(data) : null;
    if (activity)
        text.appendChild(activity);

    let gameAsset: HTMLImageElement | null = null;
    function updateGameAsset(data: FriendRowData) {
        const nativeAsset = nativeActivityAsset && (data.gameAppId || data.gameAssetUrl);
        if (!nativeAsset && !data.gameAssetUrl) {
            gameAssetHost.remove();
            gameAsset?.remove();
            gameAsset = null;
        } else {
            if (gameAssetHost.parentElement !== content) content.appendChild(gameAssetHost);
            if (nativeAsset) {
                gameAsset?.remove();
                gameAsset = null;
                return;
            }
            // Retain the existing rich-presence image fallback if native discovery
            // is unavailable; never invent an application icon or asset URL.
            if (!gameAsset) {
                gameAsset = document.createElement("img");
                gameAsset.style.cssText = "width: 32px; height: 32px; flex: none; border-radius: 8px; object-fit: cover;";
                gameAsset.alt = "";
                gameAssetHost.appendChild(gameAsset);
            }
            if (data.gameAssetUrl && gameAsset.getAttribute("src") !== data.gameAssetUrl)
                gameAsset.src = data.gameAssetUrl;
        }
    }

    friendRowUpdates.set(row, next => {
        // Reconcile props on the existing React root; never remount for presence updates.
        if (next.avatarSrc !== current.avatarSrc || next.status !== current.status || next.user !== current.user || next.displayName !== current.displayName || next.gameAppId !== current.gameAppId || next.gameAssetUrl !== current.gameAssetUrl || assetRenderer !== nativeActivityAsset)
            renderVisuals(next);
        if (!friendCosmeticsComponent && next.displayName !== current.displayName)
            name.textContent = next.displayName;
        if (next.displayName !== current.displayName || next.subtitle !== current.subtitle) {
            row.setAttribute("aria-label", `${next.displayName}${next.subtitle ? `, ${next.subtitle}` : ""}`);
            updateMaruFriendTooltip(row, next);
        }

        const sameActivityStyle = next.hasRichActivity === current.hasRichActivity && next.icon === current.icon && next.voiceIcon === current.voiceIcon && JSON.stringify(next.emoji) === JSON.stringify(current.emoji);
        if (next.subtitle !== current.subtitle || !sameActivityStyle) {
            if (activity && next.subtitle != null && sameActivityStyle) {
                activity.lastElementChild!.textContent = next.subtitle;
            } else {
                if (activity) unmountNativeIcons(activity);
                activity?.remove();
                activity = next.subtitle != null ? createActivity(next) : null;
                if (activity) text.appendChild(activity);
            }
        }
        updateGameAsset(next);

        // Existing event handlers read the latest user/activity without being replaced.
        current = next;
        friendRowData.set(row, next);
    });

    content.append(avatarWrap, text);
    row.append(plateHost, content);
    updateGameAsset(data);

    row.addEventListener("pointerenter", () => {
        showMaruFriendTooltip(
            row,
            current.user,
            current.subtitle,
            current.displayName
        );
    });

    row.addEventListener("pointerleave", () => {
        if (activeMaruFriendTooltipHideTimer)
            clearTimeout(activeMaruFriendTooltipHideTimer);

        // Keep the existing tooltip grace period for list membership/order changes.
        activeMaruFriendTooltipHideTimer = setTimeout(() => {
            activeMaruFriendTooltipHideTimer = null;
            hideMaruFriendTooltip();
        }, 50);
    });

    row.style.cursor = "pointer";
    row.addEventListener("click", event => {
        hideMaruFriendTooltip(true);
        openNativeUserProfileCard(event, current.user);
    });
    row.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        row.click();
    });

    row.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();

        hideMaruFriendTooltip(true);

        void openNativeUserContextMenu(event, current.user);
    });

    return row;
}

function scheduleSidebarRefresh() {
    if (refreshTimer) return;

    refreshTimer = setTimeout(() => {
        refreshTimer = null;

        if (lastShell && document.contains(lastShell))
            populateFriendsSidebar(lastShell);
    }, 100);
}

function handlePresenceChange() {
    if (selectedCategoryId)
        scheduleSidebarRefresh();
}

function findNativeFriendsList(shell: HTMLElement): HTMLElement | null {
    const labelled = shell.querySelector<HTMLElement>(
        ":scope > [aria-labelledby]:not(.maruFriendsList)"
    );

    if (labelled)
        return labelled;

    const children = [...shell.children] as HTMLElement[];

    return children.reverse().find(element => {
        if (element.classList.contains("maruFriendsList"))
            return false;

        // Discord can wrap the labelled scroller in a flex body. Return that
        // direct-child layout slot so hiding it releases space for our list.
        const scroller = element.querySelector<HTMLElement>(":scope > [aria-labelledby]");
        const style = getComputedStyle(scroller ?? element);

        return style.overflowY === "auto"
            || style.overflowY === "scroll";
    }) ?? null;
}

function restoreNativeSidebar(shell: HTMLElement | null = lastShell) {
    if (!shell)
        return;

    const maruList = shell.querySelector<HTMLElement>(":scope > .maruFriendsList");

    if (maruList) {
        unmountAvatars(maruList);
        maruList.remove();
    }

    const nativeList = findNativeFriendsList(shell);

    if (!nativeList)
        return;

    const previousDisplay = nativeList.getAttribute("data-maru-previous-display");

    if (previousDisplay !== null) {
        nativeList.style.display = previousDisplay;
        nativeList.removeAttribute("data-maru-previous-display");
    } else {
        nativeList.style.removeProperty("display");
    }
}

function populateFriendsSidebar(shell: HTMLElement) {
    const nativeList = findNativeFriendsList(shell);
    setupModeButton(shell);
    setupSortControl(shell);

    const selectedCategory = getSelectedCategory();
    let list = shell.querySelector<HTMLElement>(":scope > .maruFriendsList");

    // Normal Friends mode now belongs entirely to Discord.
    if (!selectedCategory) {
        if (durationTimer) clearTimeout(durationTimer);
        durationTimer = null;
        if (list) {
            unmountAvatars(list);
            list.remove();
        }

        if (nativeList) {
            const previousDisplay = nativeList.getAttribute("data-maru-previous-display");

            if (previousDisplay !== null) {
                nativeList.style.display = previousDisplay;
                nativeList.removeAttribute("data-maru-previous-display");
            } else {
                nativeList.style.removeProperty("display");
            }
        }

        updateModeButtonLabel(shell);
        return;
    }

    loadNativePresentation();

    // A PinDM category is selected, so hide Discord's native list without
    // touching its virtualized contents.
    // Native content may be absent while Discord mounts or loads its list.
    // Category selection/reconciliation must still run; the existing observer
    // hides a newly mounted native layout slot when it appears.
    if (nativeList) {
        if (!nativeList.hasAttribute("data-maru-previous-display"))
            nativeList.setAttribute("data-maru-previous-display", nativeList.style.display);

        nativeList.style.display = "none";
    }

    const previousScrollTop = list?.dataset.maruCategoryId === selectedCategory.id
        ? list.scrollTop : categoryScrollPositions.get(selectedCategory.id) ?? 0;

    if (!list) {
        list = document.createElement("div");
        list.classList.add("maruFriendsList");
        shell.appendChild(list);
    }
    list.dataset.maruCategoryId = selectedCategory.id;
    list.setAttribute("aria-label", `${selectedCategory.name} friends`);

    list.style.setProperty("width", "100%", "important");
    list.style.setProperty("height", "100%", "important");
    list.style.setProperty("max-height", "none", "important");
    list.style.setProperty("min-height", "0", "important");
    list.style.setProperty("flex", "1 1 auto", "important");
    list.style.setProperty("overflow-y", "auto", "important");
    list.style.setProperty("overflow-x", "hidden", "important");

    list.style.display = "block";
    list.style.padding = "0 0 4px";
    list.style.boxSizing = "border-box";

    observeSidebarWidth(shell);

    const friendIds = getCategoryUserIds(selectedCategory);
    const existingRows = new Map(
        [...list.querySelectorAll<HTMLElement>(".maruFriendRow")].map(row => [row.dataset.maruUserId!, row] as const)
    );
    const grouped: Record<SectionKey, { id: string; data: FriendRowData; }[]> = { active_now: [], online: [], offline: [] };
    for (const id of friendIds) {
        const data = getFriendRowData(id);
        if (data) grouped[data.section].push({ id, data });
    }
    let visibleSectionSeen = false;
    const collator = new Intl.Collator(nativeLocale?.locale, { sensitivity: "base", numeric: true });
    for (const { key, label } of sections) {
        let section = list.querySelector<HTMLElement>(`:scope > [data-maru-section="${key}"]`);
        if (!section) {
            section = createSection(key, label);
            list.appendChild(section);
        }
        const header = section.querySelector<HTMLButtonElement>(".maruFriendsSectionHeader")!;
        const rows = section.querySelector<HTMLElement>(".maruFriendsSectionRows")!;
        section.hidden = grouped[key].length === 0;
        const separated = !section.hidden && visibleSectionSeen;
        header.classList.toggle("maruFriendsSectionSeparated", separated);
        if (nativeSeparatedClass) header.classList.toggle(nativeSeparatedClass, separated);
        if (!section.hidden) visibleSectionSeen = true;
        renderSectionMarker(section, shell);
        updateSectionVisibility(section, list.dataset.maruCompact === "true");
        grouped[key].sort((a, b) => collator.compare(a.data.displayName, b.data.displayName) || (a.id === b.id ? 0 : BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        let nextRow = rows.firstElementChild;
        for (const { id, data } of grouped[key]) {
            let row = existingRows.get(id);
            if (row) {
                friendRowUpdates.get(row)?.(data);
                existingRows.delete(id);
            } else {
                row = createFriendRow(id, data);
            }
            // Move the same element/root between groups. Unchanged rows stay put.
            if (row !== nextRow) {
                if (row.dataset.maruUserId === activeMaruFriendTooltipUserId)
                    hideMaruFriendTooltip(true);
                rows.insertBefore(row, nextRow);
            }
            nextRow = row.nextElementSibling;
        }
    }

    for (const row of existingRows.values()) {
        if (row.dataset.maruUserId === activeMaruFriendTooltipUserId)
            hideMaruFriendTooltip(true);
        unmountAvatars(row);
        row.remove();
    }

    list.scrollTop = previousScrollTop;
    scheduleDurationUpdate();

    updateModeButtonLabel(shell);
}

function checkForSidebar() {
    ensureDualSidebarRenderer();
    // Discord can remove or replace the shell without going through our list cleanup.
    for (const [element, root] of avatarRoots) {
        if (!element.isConnected) {
            avatarRoots.delete(element);
            root.unmount();
        }
    }

    for (const [element, { root }] of nativeIconRoots) {
        if (!element.isConnected) {
            nativeIconRoots.delete(element);
            root.unmount();
        }
    }

    const shell = findFriendsSidebarShell();

    if (!shell) {
        removeSortControl();
        if (lastShell) {
            const list = lastShell.querySelector<HTMLElement>(":scope > .maruFriendsList");
            if (selectedCategoryId && list) categoryScrollPositions.set(selectedCategoryId, list.scrollTop);
            restoreNativeSidebar(lastShell);
        }
        widthObserver?.disconnect();
        widthObserver = null;
        observedShell = null;
        lastNativeList = null;
        if (durationTimer) clearTimeout(durationTimer);
        durationTimer = null;
        hideMaruFriendTooltip(true);
        lastShell = null;

        return;
    }

    if (shell === lastShell) {
        setupSortControl(shell);
        const button = findModeButton(shell);

        if (button && button !== modeButton)
            setupModeButton(shell);
        const nativeList = findNativeFriendsList(shell);
        if (nativeList && nativeList !== lastNativeList) {
            lastNativeList = nativeList;
            populateFriendsSidebar(shell);
        }

        return;
    }

    if (lastShell) restoreNativeSidebar(lastShell);
    lastShell = shell;
    lastNativeList = findNativeFriendsList(shell);

    setupModeButton(shell);
    populateFriendsSidebar(shell);
}

let dualSidebarRunning = false;
let membersOpen = true;
let profileOpen = true;
let dualSidebarProto: any = null;
let originalMemberRenderer: any = null;

const excludedSidebarSections = new Set([
    "PROFILE",
    "SEARCH",
    "CONVERSATIONS",
    "SIDEBAR_CHAT"
]);

function getChannelRenderer(): any | null {
    const area = document.querySelector<HTMLElement>(
        '[class*="channelArea_"]'
    );

    if (!area) return null;

    const key = Object.keys(area).find(
        key => key.startsWith("__reactFiber$")
    );

    if (!key) return null;

    let fiber = (area as any)[key];

    while (fiber) {
        if (typeof fiber.stateNode?.renderSidebar === "function")
            return fiber.stateNode;

        fiber = fiber.return;
    }

    return null;
}

const dualSidebarSettings = definePluginSettings({
    membersOpen: {
        type: OptionType.BOOLEAN,
        description: "Keep the member list open independently of Friends.",
        default: true
    },
    profileOpen: {
        type: OptionType.BOOLEAN,
        description: "Keep the DM Profile open independently of Friends.",
        default: true
    }
}).withPrivateSettings<{ collapsedSections?: Partial<Record<SectionKey, boolean>>; }>();

function initialMemberState() {
    return dualSidebarSettings.store.membersOpen;
}

function ensureDualSidebarRenderer() {
    if (!dualSidebarRunning) return;

    const instance = getChannelRenderer();
    if (!instance) return;

    const proto = Object.getPrototypeOf(instance);

    if (dualSidebarProto === proto) return;

    if (dualSidebarProto && originalMemberRenderer)
        dualSidebarProto.renderSidebar = originalMemberRenderer;

    const original = proto.renderSidebar;

    dualSidebarProto = proto;
    originalMemberRenderer = original;

    proto.renderSidebar = function (this: any, ...args: any[]) {
        const props = this.props;

        if (dualSidebarRunning && props?.channel?.type === 1) {
            if (
                props.showCall ||
                props.showActivityPanel ||
                props.showFramePanel ||
                (excludedSidebarSections.has(props.section) &&
                 props.section !== "PROFILE")
            ) {
                return original.apply(this, args);
            }

            if (!profileOpen)
                return null;

            if (props.section === "PROFILE")
                return original.apply(this, args);

            const dmShadow = Object.create(this);

            dmShadow.props = {
                ...props,
                section: "PROFILE"
            };

            return original.apply(dmShadow, args);
        }

        if (
            !dualSidebarRunning ||
            !(props?.channel?.guild_id || props?.channel?.type === 3) ||
            excludedSidebarSections.has(props.section)
        ) {
            return original.apply(this, args);
        }

        if (!membersOpen)
            return null;

        if (props.section === "MEMBERS")
            return original.apply(this, args);

        const shadow = Object.create(this);

        shadow.props = {
            ...props,
            section: "MEMBERS"
        };

        return original.apply(shadow, args);
    };

    instance.forceUpdate();
}

function restoreDualSidebarRenderer() {
    if (dualSidebarProto && originalMemberRenderer)
        dualSidebarProto.renderSidebar = originalMemberRenderer;

    dualSidebarProto = null;
    originalMemberRenderer = null;

    getChannelRenderer()?.forceUpdate();
}

function handleIndependentProfileToggle(event: MouseEvent) {
    if (!dualSidebarRunning) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    const button = target.closest(
        '[role="button"][aria-label="Show User Profile"],' +
        '[role="button"][aria-label="Hide User Profile"]'
    );

    if (!button || button.getAttribute("aria-disabled") === "true")
        return;

    const channel = getChannelRenderer();

    if (channel?.props?.channel?.type !== 1)
        return;

    if (
        channel.props.showCall ||
        channel.props.showActivityPanel ||
        channel.props.showFramePanel
    ) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    profileOpen = !profileOpen;
    dualSidebarSettings.store.profileOpen = profileOpen;

    channel.forceUpdate();
}

function handleIndependentMemberToggle(event: MouseEvent) {
    if (!dualSidebarRunning) return;

    const target = event.target;

    if (!(target instanceof Element)) return;

    const button = target.closest(
        '[role="button"][aria-label="Show Member List"],' +
        '[role="button"][aria-label="Hide Member List"]'
    );

    if (!button) return;

    const channel = getChannelRenderer();

    if (!(channel?.props?.channel?.guild_id || channel?.props?.channel?.type === 3))
        return;

    if (excludedSidebarSections.has(channel.props.section))
        return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    membersOpen = !membersOpen;

    dualSidebarSettings.store.membersOpen = membersOpen;

    channel.forceUpdate();
}
export default definePlugin({
    name: "MaruFriendsSidebar",
    settings: dualSidebarSettings,
    patches: [{
        find: "member_list_open:",
        replacement: {
            match: /([\w$]+)=([\w$]+)===([\w$.]+)\.MEMBERS;return/,
            replace: "$1=$self.getIndependentMemberSelection($2===$3.MEMBERS);return"
        }
    }, {
        find: "showCallOrActivityPanel:",
        replacement: {
            match: /([\w$]+)=([\w$]+)===([\w$.]+)\.PROFILE&&([\w$]+);return/,
            replace: "$1=$self.getIndependentProfileSelection($2===$3.PROFILE&&$4,$4);return"
        }
    }],

    getIndependentMemberSelection(nativeState: boolean) {
        return dualSidebarRunning ? membersOpen : nativeState;
    },

    getIndependentProfileSelection(nativeState: boolean, eligible: boolean) {
        return dualSidebarRunning ? profileOpen && eligible : nativeState;
    },

    description: "Adds PinDM category views and native user profile popouts to Discord's experimental Friends sidebar.",
    authors: [
        {
            name: "Maru",
            id: 0n
        }
    ],

    start() {
        membersOpen = initialMemberState();
        profileOpen = dualSidebarSettings.store.profileOpen;
        dualSidebarRunning = true;
        document.addEventListener("click", handleIndependentMemberToggle, true);
        document.addEventListener("click", handleIndependentProfileToggle, true);

        installStyles();

        // Preload Discord's native user context menu so the first right-click works immediately.
        void loadUserContextMenu();
        PresenceStore.addChangeListener(handlePresenceChange);
        UserStore.addChangeListener(handlePresenceChange);
        VoiceStateStore.addChangeListener(handlePresenceChange);
        RelationshipStore.addChangeListener(handlePresenceChange);
        ChannelStore.addChangeListener(handlePresenceChange);
        SettingsStore.addPrefixChangeListener("plugins.PinDMs.userBasedCategoryList", handlePresenceChange);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        observer = new MutationObserver(records => {
            // Keep the existing shell/dual-sidebar observer, but do not react to
            // our own list, duration, avatar, or tooltip DOM updates.
            if (records.every(record => record.target instanceof Element &&
                record.target.closest(".maruFriendsList, .maruFriendTooltipLayer, .maruFriendsSortControl"))) return;
            checkForSidebar();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        checkForSidebar();
    },

    stop() {
        dualSidebarRunning = false;
        document.removeEventListener("click", handleIndependentMemberToggle, true);
        document.removeEventListener("click", handleIndependentProfileToggle, true);
        restoreDualSidebarRenderer();
        observer?.disconnect();
        observer = null;
        PresenceStore.removeChangeListener(handlePresenceChange);
        UserStore.removeChangeListener(handlePresenceChange);
        VoiceStateStore.removeChangeListener(handlePresenceChange);
        RelationshipStore.removeChangeListener(handlePresenceChange);
        ChannelStore.removeChangeListener(handlePresenceChange);
        SettingsStore.removePrefixChangeListener("plugins.PinDMs.userBasedCategoryList", handlePresenceChange);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        nativeFriendRows?.removeChangeListener(handlePresenceChange);
        nativeFriendRows = null;
        nativeActivityAsset = null;
        nativeLocale = null;
        nativeActivityText = null;
        nativeDuration = null;
        presentationLoaded = false;
        nativeIcons = {};
        nativeChannelIcon = null;
        nativeSectionIcon = null;
        nativeFriendsContext = null;
        nativeSectionTypes = null;
        nativeSeparatedClass = null;
        widthObserver?.disconnect();
        widthObserver = null;
        observedShell = null;
        lastNativeList = null;
        if (durationTimer) clearTimeout(durationTimer);
        durationTimer = null;
        hideMaruFriendTooltip(true);
        closeActiveProfile?.();
        categoryScrollPositions.clear();

        if (refreshTimer)
            clearTimeout(refreshTimer);

        refreshTimer = null;

        removeSortControl();
        restoreModeButton();
        restoreNativeSidebar();
        unmountAvatars();
        friendAvatarComponent = null;
        nativeAvatarHook = null;
        friendCosmeticsComponent = null;
        nativeCosmetics = null;
        lastShell = null;

        styleElement?.remove();
        styleElement = null;
    }
});
