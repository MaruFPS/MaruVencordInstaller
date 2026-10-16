import {
    readFileSync,
    readdirSync,
    lstatSync,
    writeFileSync
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundleRoot = join(root, "bundled-plugins");
const policyPath = join(root, "bundle-policy.json");

const names = JSON.parse(
    readFileSync(join(root, "bundled-plugin-names.json"), "utf8")
);

const validName = value =>
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);

if (
    !Array.isArray(names) ||
    names.length === 0 ||
    !names.every(validName) ||
    new Set(names.map(name => name.toLowerCase())).size !== names.length
) {
    throw new Error("Invalid or duplicate bundled plugin names.");
}

const entries = readdirSync(bundleRoot, { withFileTypes: true });
const registered = new Set(names.map(name => name.toLowerCase()));

for (const entry of entries) {
    if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !registered.has(entry.name.toLowerCase())
    ) {
        throw new Error(`Unexpected bundled plugin entry: ${entry.name}`);
    }
}

const plugins = {};
const hashes = {};

for (const name of names) {
    const pluginRoot = join(bundleRoot, name);

    if (!entries.some(entry => entry.name === name)) {
        throw new Error(`Missing registered plugin folder: ${name}`);
    }

    const files = [];

    function scan(directory, prefix = "") {
        const children = readdirSync(directory, {
            withFileTypes: true
        }).sort((a, b) => a.name.localeCompare(b.name));

        for (const child of children) {
            if (!validName(child.name)) {
                throw new Error(`Invalid plugin file name: ${child.name}`);
            }

            const relative = prefix
                ? `${prefix}/${child.name}`
                : child.name;

            const full = join(directory, child.name);
            const info = lstatSync(full);

            if (info.isSymbolicLink()) {
                throw new Error(`Refusing symbolic link: ${relative}`);
            }

            if (info.isDirectory()) {
                scan(full, relative);
            } else if (info.isFile() && info.size > 0) {
                files.push(relative);

                hashes[`${name}/${relative}`] =
                    createHash("sha256")
                        .update(readFileSync(full))
                        .digest("hex");
            } else {
                throw new Error(`Invalid or empty plugin file: ${relative}`);
            }
        }
    }

    scan(pluginRoot);

    if (!files.length) {
        throw new Error(`Plugin folder is empty: ${name}`);
    }

    plugins[name] = files;
}

const policy = JSON.parse(readFileSync(policyPath, "utf8"));

if (policy.schemaVersion !== 1) {
    throw new Error("Unsupported bundle policy schema.");
}

delete policy.legacyReleases;
policy.current = hashes;
policy.plugins = plugins;

console.log(
    `Verified ${names.length} registered plugins and ` +
    `${Object.keys(hashes).length} files.`
);

if (process.argv.includes("--dry-run")) {
    console.log("Dry run: no files modified.");
} else {
    writeFileSync(
        policyPath,
        JSON.stringify(policy, null, 2) + "\n",
        "utf8"
    );

    console.log("Bundled plugin manifest generated.");
}