// Discovery extension for the original Text Channel action. No OAuth or voice changes.
import { get } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function resolveStableDiscord() {
    const root = process.env.LOCALAPPDATA &&
        join(process.env.LOCALAPPDATA, 'Discord');

    if (!root || !existsSync(root)) {
        throw new Error('Discord Stable installation not found');
    }

    const apps = readdirSync(root, { withFileTypes: true })
        .filter(entry =>
            entry.isDirectory() &&
            /^app-\d+(?:\.\d+)+$/.test(entry.name)
        )
        .map(entry => ({
            name: entry.name,
            version: entry.name.slice(4).split('.').map(Number)
        }))
        .sort((a, b) => {
            const count = Math.max(a.version.length, b.version.length);
            for (let i = 0; i < count; i++) {
                const diff = (b.version[i] ?? 0) - (a.version[i] ?? 0);
                if (diff) return diff;
            }
            return 0;
        });

    for (const app of apps) {
        const exe = join(root, app.name, 'Discord.exe');
        if (existsSync(exe)) return exe;
    }

    throw new Error('Discord Stable executable not found');
}

export const SECTIONS = ['@favorites', '@dm', '@group', '@manual'];
export const isChannelId = value => typeof value === 'string' && /^[0-9]{16,22}$/.test(value);
const kind = type => type === 1 ? 'dm' : type === 3 ? 'group' : 'guild';

export function readBridge() {
    return new Promise((resolve, reject) => {
        const request = get({
            hostname: '127.0.0.1', port: 26433, path: '/v1/destinations',
            agent: false, headers: { 'X-StreamDock-Destinations': '1' }
        }, response => {
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error('bridge_unavailable'));
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > 4 * 1024 * 1024) request.destroy(new Error('bridge_invalid'));
                else chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch { reject(new Error('bridge_invalid')); }
            });
        });
        // Absolute deadline, including peers that trickle data without completing.
        const timer = setTimeout(() => request.destroy(new Error('bridge_unavailable')), 1800);
        request.on('close', () => clearTimeout(timer));
        request.on('error', reject);
    });
}

export function validateSnapshot(value, accountId) {
    if (value?.version !== 1 || !isChannelId(value.accountId) ||
        !Array.isArray(value.privateChannels) || !Array.isArray(value.favorites) ||
        value.privateChannels.length + value.favorites.length > 20000) throw new Error('bridge_invalid');
    if (!accountId || value.accountId !== accountId) throw new Error('account_mismatch');
    const normalize = (rows, privateOnly) => {
        const seen = new Set();
        return rows.flatMap(row => {
            if (!isChannelId(row?.id) || seen.has(row.id) || typeof row.name !== 'string' ||
                !(privateOnly ? [1, 3] : [0, 1, 2, 3, 5, 10, 11, 12, 13, 15, 16]).includes(row.type) ||
                (![1, 3].includes(row.type) && !isChannelId(row.guildId))) return [];
            seen.add(row.id);
            return [{ id: row.id, name: row.name.slice(0, 240), type: row.type,
                guildId: isChannelId(row.guildId) ? row.guildId : '',
                guildName: typeof row.guildName === 'string' ? row.guildName.slice(0, 100) : '' }];
        });
    };
    return { privateChannels: normalize(value.privateChannels, true), favorites: normalize(value.favorites, false),
        favoritesAvailable: value.favoritesAvailable === true,
        privateAvailable: value.privateAvailable === true };
}

function deadline(promise, ms = 5000) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('rpc_timeout')), ms);
    })]).finally(() => clearTimeout(timer));
}

export function createDestinationAction({ Actions, plugin, globals, listener, events, log, defaultImage,
    bridgeRead = readBridge }) {
    // Coalesce discovery across buttons. Never cache another Discord login's snapshot.
    let bridgePending, bridgeAccount, bridgeTime = 0;
    const discover = accountId => {
        if (!bridgePending || bridgeAccount !== accountId || Date.now() - bridgeTime > 2000) {
            bridgeAccount = accountId;
            bridgeTime = Date.now();
            bridgePending = bridgeRead().then(value => validateSnapshot(value, accountId));
        }
        return bridgePending;
    };
    return class extends Actions {
        revision = 0;
        disposed = false;

        async stateCallback() {
            const revision = ++this.revision;
            const settings = { ...this.settings };
            const client = globals.client;
            const account = client?.user?.id;
            let status = 'bridge_unavailable';
            let snapshot = { privateChannels: [], favorites: [] };
            let guilds = settings.guilds || [];
            const loggedIn = !!globals.LoginState.hasLogin && !!client;
            if (loggedIn) {
                const results = await Promise.allSettled([
                    deadline(listener.getGuilds()), discover(account)
                ]);
                if (results[0].status === 'fulfilled') guilds = listener.data.guilds || [];
                else log.warn('[Destinations] Guild discovery failed');
                if (results[1].status === 'fulfilled') {
                    snapshot = results[1].value;
                    status = snapshot.favoritesAvailable && snapshot.privateAvailable ? 'bridge_connected' : 'stores_unavailable';
                } else if (['account_mismatch', 'bridge_invalid'].includes(results[1].reason?.message)) {
                    status = results[1].reason.message;
                }
            } else status = 'rpc_unavailable';
            let select = settings.select || guilds[0]?.id || '@dm';
            let channels = [];
            let selectImage;
            let guildFailed = false;
            if (select === '@dm') channels = snapshot.privateChannels.filter(c => c.type === 1);
            else if (select === '@group') channels = snapshot.privateChannels.filter(c => c.type === 3);
            else if (select === '@favorites') channels = snapshot.favorites;
            else if (select !== '@manual' && loggedIn) {
                try {
                    channels = (await deadline(listener.getChannels(select))).filter(c => c.type === 0);
                    log.info(`[Destinations] Guild text channels: ${channels.length}`);
                    try { selectImage = await deadline(listener.getGuildImage(select)); } catch { /* keep existing icon */ }
                } catch {
                    guildFailed = true;
                    log.warn('[Destinations] Guild channel discovery failed');
                }
            }
            // Never silently replace a saved button's destination when Discord is unavailable,
            // a favorite is removed, or a channel no longer appears in the current list.
            const channel = settings.channel || channels[0]?.id || '';
            const selected = channels.find(c => c.id === channel);
            const next = { ...settings, guilds, select, channels, channel,
                destinationName: selected?.name || settings.destinationName ||
                    settings.channels?.find(c => c.id === channel)?.name || '',
                destinationType: selected ? kind(selected.type) : settings.destinationType || 'guild',
                destinationStatus: guildFailed ? 'guild_unavailable' : status };
            if (revision !== this.revision || this.disposed || client !== globals.client || account !== globals.client?.user?.id) return;
            this.settings = next;
            plugin.setSettings(this.context, next);
            if (selectImage) plugin.setImage(this.context, selectImage);
            else if (SECTIONS.includes(select) && defaultImage) plugin.setImage(this.context, defaultImage);
            plugin.setTitle(this.context, next.destinationName || '', 3, 10);
            log.info(`[Destinations] State: ${status}; DMs: ${snapshot.privateChannels.filter(c => c.type === 1).length}; groups: ${snapshot.privateChannels.filter(c => c.type === 3).length}; favorites: ${snapshot.favorites.length}`);
        }

        _willAppear() {
            this.disposed = false;
            this.unsubscribe = events.subscribe('Login', () => this.stateCallback());
            this.stateCallback();
        }
        _propertyInspectorDidAppear() { this.stateCallback(); }
        _willDisappear() {
            this.disposed = true;
            ++this.revision;
            if (typeof this.unsubscribe === 'function') this.unsubscribe();
        }
        _didReceiveSettings({ payload }) {
            const changed = this.settings.select !== payload.settings.select || this.settings.channel !== payload.settings.channel;
            this.settings = payload.settings;
            if (changed) this.stateCallback();
        }
        sendToPlugin({ payload }) {
            if (payload.refresh) { bridgePending = undefined; this.stateCallback(); return; }
            if (payload.destinationSection &&
                (SECTIONS.includes(payload.destinationSection) || isChannelId(payload.destinationSection))) {
                ++this.revision;
                this.settings = { ...this.settings, select: payload.destinationSection,
                    channel: '', channels: [], destinationName: '', destinationType: '' };
                plugin.setSettings(this.context, this.settings);
                this.stateCallback();
            } else if (isChannelId(payload.destinationChannel)) {
                const row = this.settings.channels?.find(c => c.id === payload.destinationChannel);
                if (!row && this.settings.select !== '@manual') return;
                ++this.revision;
                this.settings = { ...this.settings, channel: payload.destinationChannel,
                    destinationName: row?.name || payload.destinationChannel,
                    destinationType: row ? kind(row.type) : 'manual' };
                plugin.setSettings(this.context, this.settings);
                plugin.setTitle(this.context, this.settings.destinationName, 3, 10);
                log.info(`[Destinations] Selected type: ${this.settings.destinationType}`);
            }
        }
        async keyUp({ context, payload }) {
            if (!isChannelId(payload.settings.channel) || !globals.LoginState.hasLogin || !globals.client) {
                plugin.showAlert(context);
                log.warn('[Destinations] Navigation unavailable: missing channel or RPC connection');
                return;
            }
            try {
                if (payload.settings.select === '@favorites') {
            await new Promise((resolve, reject) => {
                execFile(resolveStableDiscord(), ['--url', '--', `discord://-/channels/@favorites/${payload.settings.channel}`],
                    error => error ? reject(error) : resolve());
            });
        } else {
            await deadline(globals.client.selectTextChannel(payload.settings.channel));
        }
                log.info(`[Destinations] Navigation completed; type: ${payload.settings.destinationType || 'guild'}`);
            } catch (error) {
                plugin.showAlert(context);
                log.warn(`[Destinations] Navigation failed; code: ${Number.isInteger(error?.code) ? error.code : 'unavailable'}`);
            }
        }
    };
}
