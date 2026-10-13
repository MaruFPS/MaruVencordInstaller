import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { createHash } from "node:crypto";

export function sha256(file) {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// Refuse links/junctions in source, destination, and backup paths. Do not follow
// an installer-owned file through a redirected ancestor into unrelated data.
export function assertSafePath(file) {
    const absolute = resolve(file);
    const root = parse(absolute).root;
    let current = root;
    for (const segment of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
        current = join(current, segment);
        let entry;
        try { entry = lstatSync(current); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (entry?.isSymbolicLink()) throw new Error(`Refusing redirected filesystem path: ${current}`);
    }
    return absolute;
}

function regular(file) {
    assertSafePath(file);
    return existsSync(file) && lstatSync(file).isFile() && lstatSync(file).size > 0;
}

function approvedRelative(file) {
    if (typeof file !== "string" || file.includes("\\") || file.split("/").some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === ".."))
        throw new Error(`Invalid approved resource path: ${file}`);
    return file;
}

export function validatePluginBundle(root, registry, policy) {
    if (policy.schemaVersion !== 1) throw new Error("Unsupported bundle policy.");
    const expected = Object.entries(registry).flatMap(([name, files]) => files.map(file => approvedRelative(`${name}/${file}`))).sort();
    if (JSON.stringify(expected) !== JSON.stringify(Object.keys(policy.current).sort()))
        throw new Error("Plugin registry and approved payload policy disagree.");
    for (const rel of expected) {
        const file = join(root, rel);
        if (!regular(file) || sha256(file) !== policy.current[rel])
            throw new Error(`Bundled plugin failed approved hash verification: ${rel}`);
    }
    return true;
}

export function assessInstalledPlugins(root, registry, policy) {
    const newPlugin = "maruFriendsSidebar";
    const oldNames = Object.keys(registry).filter(name => name !== newPlugin);
    const newPath = join(root, newPlugin);
    assertSafePath(root);
    for (const name of Object.keys(registry)) {
        const folder = join(root, name);
        assertSafePath(folder);
        if (existsSync(folder) && !lstatSync(folder).isDirectory())
            return { upgradeEligible: false, updateSafe: false, reason: `Plugin path is not a directory: ${name}` };
    }
    const matches = files => Object.entries(files).every(([rel, hash]) => regular(join(root, approvedRelative(rel))) && sha256(join(root, rel)) === hash);
    const legacy = policy.legacyReleases.find(release => {
        const required = oldNames.flatMap(name => registry[name].map(file => `${name}/${file}`)).sort();
        return JSON.stringify(required) === JSON.stringify(Object.keys(release.files).sort()) && matches(release.files);
    });
    if (!existsSync(newPath) && legacy)
        return { upgradeEligible: true, updateSafe: true, legacyRelease: legacy.id, reason: "Verified five-plugin release; use Update Maru Plug-ins to add Friends Sidebar." };
    if (matches(policy.current))
        return { upgradeEligible: false, updateSafe: true, reason: "Approved six-plugin payload is installed." };

    // Recovery is separate from normal/staged update eligibility. Absent approved
    // files may be restored when every surviving managed file belongs
    // to one trusted release. Extra files/plugins are never copied over or removed.
    const expected = Object.entries(registry).flatMap(([name, files]) => files.map(file => approvedRelative(`${name}/${file}`))).sort();
    if (JSON.stringify(expected) !== JSON.stringify(Object.keys(policy.current).sort()))
        throw new Error("Plugin registry and approved payload policy disagree.");
    const missingFiles = [];
    const present = [];
    for (const rel of expected) {
        const file = join(root, rel);
        assertSafePath(file);
        if (!existsSync(file)) missingFiles.push(rel);
        else if (!regular(file))
            return { upgradeEligible: false, updateSafe: false, repairEligible: false, reason: `Managed plugin file is not a non-empty regular file: ${rel}. It will not be overwritten.` };
        else present.push([rel, sha256(file)]);
    }
    const trustedRelease = [
        { id: "current", files: policy.current },
        ...policy.legacyReleases
    ].find(release => present.every(([rel, hash]) => release.files[rel] === hash));
    if (missingFiles.length && trustedRelease)
        return { upgradeEligible: false, updateSafe: false, repairEligible: true, missingFiles, recoveryRelease: trustedRelease.id, reason: `${missingFiles.length} approved plugin file(s) are missing; surviving managed files match a trusted release. Use Repair Managed Vencord to restore bundled plugins, then continue Automatic Setup.` };
    return { upgradeEligible: false, updateSafe: false, repairEligible: false, reason: "Managed plugin files are modified or from an unrecognized release. Repair will not overwrite them. Verified managed Discord patches can still be uninstalled below; the workspace and custom files are kept." };
}

export function copyApprovedPlugin(bundleRoot, destination, name, registry, policy) {
    validatePluginBundle(bundleRoot, registry, policy);
    assertSafePath(destination);
    if (existsSync(destination)) throw new Error(`Refusing existing plugin destination: ${destination}`);
    mkdirSync(destination, { recursive: true });
    for (const file of registry[name]) {
        const source = join(bundleRoot, name, file);
        const target = join(destination, file);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target, { force: false, errorOnExist: true });
        if (sha256(target) !== policy.current[`${name}/${file}`])
            throw new Error(`Copied plugin failed hash verification: ${name}/${file}`);
    }
}

export function validateSourceOverrides(sourceRoot, overrideRoot, policy, revision) {
    if (revision !== policy.overrides.revision)
        throw new Error(`Source overrides support reviewed Vencord ${policy.overrides.revision}; refusing unreviewed revision ${revision ?? "unknown"}.`);
    const approved = ["src/components/settings/tabs/themes/LocalThemesTab.tsx", "src/components/settings/tabs/vencord/index.tsx"].sort();
    if (JSON.stringify(Object.keys(policy.overrides.files).sort()) !== JSON.stringify(approved))
        throw new Error("Source override policy must contain exactly the two reviewed targets.");
    for (const rel of approved) {
        const baseline = join(sourceRoot, rel);
        const replacement = join(overrideRoot, rel);
        const hashes = policy.overrides.files[rel];
        if (!regular(baseline) || sha256(baseline) !== hashes.upstreamSha256)
            throw new Error(`Upstream override target changed; compatibility review required: ${rel}`);
        if (!regular(replacement) || sha256(replacement) !== hashes.overrideSha256)
            throw new Error(`Bundled override hash mismatch: ${rel}`);
    }
    return approved;
}

export function applyApprovedOverrides(sourceRoot, overrideRoot, policy, revision) {
    const approved = validateSourceOverrides(sourceRoot, overrideRoot, policy, revision);
    for (const rel of approved) {
        const target = join(sourceRoot, rel);
        cpSync(join(overrideRoot, rel), target, { force: true });
        if (sha256(target) !== policy.overrides.files[rel].overrideSha256)
            throw new Error(`Applied override hash verification failed: ${rel}`);
    }
    return { source: overrideRoot, destination: sourceRoot, revision, files: approved };
}

export function ensureTrackedDirectory(directory, created) {
    assertSafePath(directory);
    if (existsSync(directory)) {
        if (!lstatSync(directory).isDirectory()) throw new Error(`Expected directory: ${directory}`);
        return;
    }
    ensureTrackedDirectory(dirname(directory), created);
    mkdirSync(directory);
    created.push(resolve(directory));
}

export function verifyUnchangedDestination(change) {
    assertSafePath(change.sourcePath);
    assertSafePath(change.destinationPath);
    if (!regular(change.sourcePath) || sha256(change.sourcePath) !== change.sourceSha256)
        throw new Error(`Update source changed during preparation: ${change.component}/${change.file}`);
    if (change.destinationExisted) {
        if (!regular(change.destinationPath) || sha256(change.destinationPath) !== change.destinationSha256)
            throw new Error(`Destination changed during preparation: ${change.component}/${change.file}`);
    } else if (existsSync(change.destinationPath)) {
        throw new Error(`Previously absent destination appeared: ${change.destinationPath}`);
    }
}

export function restoreUpdatedFile(change) {
    assertSafePath(change.destinationPath);
    if (change.destinationExisted) {
        if (!regular(change.backupPath) || sha256(change.backupPath) !== change.destinationSha256)
            throw new Error(`Rollback backup hash mismatch: ${change.component}/${change.file}`);
        mkdirSync(dirname(change.destinationPath), { recursive: true });
        cpSync(change.backupPath, change.destinationPath, { force: true });
        if (sha256(change.destinationPath) !== change.destinationSha256)
            throw new Error(`Restored file hash mismatch: ${change.component}/${change.file}`);
    } else {
        if (existsSync(change.destinationPath)) {
            if (!lstatSync(change.destinationPath).isFile()) throw new Error(`Refusing rollback of non-file: ${change.destinationPath}`);
            rmSync(change.destinationPath);
        }
        if (existsSync(change.destinationPath)) throw new Error(`Rollback did not remove new file: ${change.destinationPath}`);
    }
}

export function removeCreatedEmptyDirectories(created) {
    for (const directory of [...created].reverse()) {
        assertSafePath(directory);
        if (!existsSync(directory)) continue;
        if (!lstatSync(directory).isDirectory()) throw new Error(`Rollback directory changed type: ${directory}`);
        if (readdirSync(directory).length === 0) rmdirSync(directory);
        else throw new Error(`Preserved additional contents in transaction-created directory: ${directory}`);
    }
}

export function restoreBuildOutput(distPath, backupPath, quarantinePath, originalManifest, getManifest, verifyManifests) {
    assertSafePath(distPath);
    assertSafePath(backupPath);
    assertSafePath(quarantinePath);
    if (originalManifest !== null) {
        const check = verifyManifests(originalManifest, getManifest(backupPath));
        if (!check.verified) throw new Error(`Build rollback backup is invalid: ${check.reason}`);
    }
    if (existsSync(distPath)) {
        if (existsSync(quarantinePath)) throw new Error(`Build quarantine path already exists: ${quarantinePath}`);
        renameSync(distPath, quarantinePath);
    }
    if (originalManifest !== null) {
        cpSync(backupPath, distPath, { recursive: true, force: false, errorOnExist: true });
        const check = verifyManifests(originalManifest, getManifest(distPath));
        if (!check.verified) throw new Error(`Restored build verification failed: ${check.reason}`);
    } else if (existsSync(distPath)) {
        throw new Error("Previously absent build output was not restored to absence.");
    }
}
