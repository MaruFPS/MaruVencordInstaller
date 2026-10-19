import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vencordRoot = process.env.VENCORD_ROOT ?? "C:/Users/User/Documents/Vencord";
const require = createRequire(path.join(vencordRoot, "package.json"));
const { transformSync } = require("esbuild");

// Keep these synchronized with the actual plugin and installed SpotifyControls.
// The assertions below prevent this test from silently testing obsolete copies.
const maruMatch = /(?<=\i\.jsxs?\)\()(\i\.\i),{(?=value:\i,children:\(0,\i\.jsxs?\)\([^,]+,{[^}]*?userTag:\i,occluded:)/;
const maruReplace = "$self.PanelProvider,{MaruOriginalProvider:$1,";
const spotifyMatch = /(?<=\i\.jsxs?\)\()(\i),{(?=[^}]*?userTag:\i,occluded:)/;
const spotifyReplace = "$self.PanelWrapper,{VencordOriginal:$1,";

function canonicalize(match) {
    return new RegExp(match.source.replaceAll(/\\i/g, String.raw`(?:[A-Za-z_$][\w$]*)`), match.flags);
}

function patch(source, match, replacement, pluginName) {
    const pattern = canonicalize(match);
    const matches = [...source.matchAll(new RegExp(pattern.source, "g"))];
    assert.equal(matches.length, 1, `${pluginName} must match exactly one provider expression`);
    return source.replace(pattern, replacement.replaceAll("$self", `Vencord.Plugins.plugins.${pluginName}`));
}

function verifyPatchComposition(source) {
    const maru = input => patch(input, maruMatch, maruReplace, "MaruActivityPanel");
    const spotify = input => patch(input, spotifyMatch, spotifyReplace, "SpotifyControls");
    const maruOnly = maru(source);
    const spotifyThenMaru = maru(spotify(source));
    const maruThenSpotify = spotify(maru(source));
    assert.equal(spotifyThenMaru, maruThenSpotify, "patch order must not change the result");
    assert.equal((maruOnly.match(/MaruActivityPanel\.PanelProvider/g) ?? []).length, 1);
    assert.equal((spotifyThenMaru.match(/MaruActivityPanel\.PanelProvider/g) ?? []).length, 1);
    assert.equal((spotifyThenMaru.match(/SpotifyControls\.PanelWrapper/g) ?? []).length, 1);
    assert.match(spotifyThenMaru, /MaruOriginalProvider:\w+\.\w+,value:/);
    assert.match(spotifyThenMaru, /SpotifyControls\.PanelWrapper,\{VencordOriginal:\w+,currentUser:/);
    for (const expression of [source, maruOnly, spotifyThenMaru, maruThenSpotify]) {
        assert.doesNotThrow(() => transformSync(`const panel = ${expression};`, { loader: "js" }));
    }
}

// Extract only the balanced provider call; no user state or complete Discord module
// is written to disk. The fixture contains property names and minified identifiers.
function extractProvider(source) {
    const match = canonicalize(maruMatch).exec(source);
    assert.ok(match, "current cached Discord provider patch anchor was not found");
    const expressionStart = source.lastIndexOf("(0,", match.index);
    assert.ok(expressionStart >= 0 && match.index - expressionStart < 50);
    let quote = "";
    let escaped = false;
    const stack = [];
    const pairs = { ")": "(", "]": "[", "}": "{" };
    for (let index = expressionStart; index < expressionStart + 4000; index++) {
        const char = source[index];
        assert.ok(char, "provider expression was truncated");
        if (quote) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === quote) quote = "";
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if ("([{".includes(char)) stack.push(char);
        else if (Object.hasOwn(pairs, char)) {
            assert.equal(stack.pop(), pairs[char], "provider expression must balance");
            if (!stack.length && source[index + 1] !== "(" && source[index + 1] !== ".") {
                return source.slice(expressionStart, index + 1);
            }
        }
    }
    assert.fail("provider expression exceeded the 4 KB extraction bound");
}

test("tested patch definitions match the shipped plugin and local SpotifyControls", () => {
    const plugin = readFileSync(path.join(bundleRoot, "src/userplugins/maruActivityPanel/index.tsx"), "utf8");
    const spotify = readFileSync(path.join(vencordRoot, "src/plugins/spotifyControls/index.tsx"), "utf8");
    assert.ok(plugin.includes(maruMatch.toString()), "shipped Maru patch changed; update the composition test");
    assert.ok(plugin.includes(JSON.stringify(maruReplace)));
    assert.ok(spotify.includes(spotifyMatch.toString()), "installed Spotify patch changed; inspect it before updating this test");
    assert.ok(spotify.includes(JSON.stringify(spotifyReplace)));
});

test("actual cached account-provider fixture composes with Spotify in both patch orders", () => {
    const fixture = readFileSync(path.join(bundleRoot, "tests/fixtures/account-provider.txt"), "utf8").trim();
    verifyPatchComposition(fixture);
});

const cachePath = process.env.MARU_DISCORD_CACHE
    ?? "C:/Users/User/AppData/Roaming/discordcanary/Cache/Cache_Data/f_00092a";

test("currently available cached Discord JavaScript matches and composes", { skip: !existsSync(cachePath) }, () => {
    const source = brotliDecompressSync(readFileSync(cachePath)).toString("utf8");
    const provider = canonicalize(maruMatch).exec(source);
    assert.ok(provider);
    const factories = [...source.matchAll(/(?:^|,)\d+\(e,t,n\)\{/g)];
    const factoryStart = factories.findLast(factory => factory.index < provider.index)?.index;
    const factoryEnd = factories.find(factory => factory.index > provider.index)?.index ?? source.length;
    assert.ok(factoryStart !== undefined);
    // Same hash algorithm and package as Vencord's src/utils/intlHash.ts.
    const { hash } = require("@intrnl/xxhash64");
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(hash("USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL", 0));
    const intlKey = bytes.toString("base64").slice(0, 6);
    const accountModule = source.slice(factoryStart, factoryEnd);
    assert.ok(accountModule.includes(`.${intlKey}`) || accountModule.includes(`["${intlKey}"]`),
        "the provider must be in the module selected by the actual Vencord intl find anchor");
    verifyPatchComposition(extractProvider(source));
});
