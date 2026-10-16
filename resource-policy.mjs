import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createCustomizationHunks, applyCustomizationHunks } from "./source-customizations.mjs";

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
    assertSafePath(root);

    const missingFiles = [];
    let missingPluginFolder = false;
    let survivingFilesCurrent = true;

    for (const [name, files] of Object.entries(registry)) {
        approvedRelative(name);
        const folder = join(root, name);
        assertSafePath(folder);

        const folderExists = existsSync(folder);

        if (folderExists && !lstatSync(folder).isDirectory()) {
            return {
                updateSafe: false,
                repairEligible: false,
                reason: `Plugin path is not a directory: ${name}`
            };
        }

        if (!folderExists) missingPluginFolder = true;

        for (const nameOfFile of files) {
            const rel = approvedRelative(`${name}/${nameOfFile}`);
            const target = join(root, rel);
            assertSafePath(target);

            if (!existsSync(target)) {
                missingFiles.push(rel);
                continue;
            }

            if (!regular(target)) {
                return {
                    updateSafe: false,
                    repairEligible: false,
                    reason: `Managed plugin file is not a non-empty regular file: ${rel}`
                };
            }

            if (policy.current?.[rel] !== sha256(target)) {
                survivingFilesCurrent = false;
            }
        }
    }

    const repairEligible =
        missingFiles.length > 0 &&
        !missingPluginFolder &&
        survivingFilesCurrent;

    return {
        upgradeEligible: false,
        updateSafe: true,
        repairEligible,
        missingFiles,
        reason: repairEligible
            ? "Missing managed plugin files can be restored."
            : "Registered Maru plug-ins can be updated from the current bundle."
    };
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

export function planSourceOverrides(sourceRoot, overrideRoot, policy) {
    const approved = ["src/components/settings/tabs/themes/LocalThemesTab.tsx", "src/components/settings/tabs/vencord/index.tsx"].sort();
    if (policy.overrides?.schemaVersion !== 2 || JSON.stringify(Object.keys(policy.overrides.files).sort()) !== JSON.stringify(approved))
        throw new Error("Source customization policy is missing or unsupported. Rebuild the installer's customization metadata.");
    return approved.map(rel => {
        const target = join(sourceRoot, rel);
        const base = join(overrideRoot, "base", rel);
        const replacement = join(overrideRoot, rel);
        const hashes = policy.overrides.files[rel];
        if (!regular(base) || sha256(base) !== hashes.baseSha256) throw new Error(`Bundled customization base hash mismatch: ${rel}`);
        if (!regular(replacement) || sha256(replacement) !== hashes.overrideSha256) throw new Error(`Bundled customization hash mismatch: ${rel}`);
        if (!regular(target)) throw new Error(`Required customization target is missing or empty: ${rel}`);
        const original = readFileSync(target, "utf8");
        const hunks = createCustomizationHunks(readFileSync(base, "utf8"), readFileSync(replacement, "utf8"));
        if (!hunks.length) throw new Error(`Bundled customization contains no changes: ${rel}`);
        const output = applyCustomizationHunks(original, hunks, rel);
        return { rel, target, original, output };
    });
}

export function validateSourceOverrides(sourceRoot, overrideRoot, policy, revision) {
    // The revision is recorded as provenance, never used as an approval gate.
    if (!/^[0-9a-f]{40}$/i.test(revision ?? "")) throw new Error("Source customization requires an exact upstream commit identity.");
    return planSourceOverrides(sourceRoot, overrideRoot, policy).map(plan => plan.rel);
}

export function assessSourceOverrides(sourceRoot, overrideRoot, policy) {
    try {
        const plans = planSourceOverrides(sourceRoot, overrideRoot, policy);
        const ready = plans.every(plan => plan.original === plan.output);
        return { ready, compatible: true, reason: ready ? null : "Required source customizations have not all been applied." };
    } catch (error) {
        return { ready: false, compatible: false, reason: error?.message ?? String(error) };
    }
}

export function applyApprovedOverrides(sourceRoot, overrideRoot, policy, revision) {
    validateSourceOverrides(sourceRoot, overrideRoot, policy, revision);
    // Preflight both targets before writing either. Callers customize isolated
    // source, so a conflict cannot replace an active build or discard user data.
    const plans = planSourceOverrides(sourceRoot, overrideRoot, policy);
    for (const plan of plans) {
        if (readFileSync(plan.target, "utf8") !== plan.original) throw new Error(`Customization target changed during preflight: ${plan.rel}`);
    }
    for (const plan of plans) {
        if (plan.output !== plan.original) writeFileSync(plan.target, plan.output, "utf8");
        const expected = createHash("sha256").update(plan.output).digest("hex");
        if (sha256(plan.target) !== expected) throw new Error(`Applied customization verification failed: ${plan.rel}`);
    }
    return { source: overrideRoot, destination: sourceRoot, revision, files: plans.map(plan => plan.rel) };
}

export function listManagedPluginFiles(folder) {
    assertSafePath(folder);

    if (!existsSync(folder)) return [];

    if (!lstatSync(folder).isDirectory()) {
        throw new Error(`Managed plugin path is not a directory: ${folder}`);
    }

    const files = [];

    function scan(directory, prefix = "") {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const relative = prefix
                ? `${prefix}/${entry.name}`
                : entry.name;

            approvedRelative(relative);

            const full = join(directory, entry.name);
            assertSafePath(full);

            const info = lstatSync(full);

            if (info.isDirectory()) {
                scan(full, relative);
            } else if (info.isFile() && info.size > 0) {
                files.push(relative);
            } else {
                throw new Error(`Unsafe or empty plugin entry: ${relative}`);
            }
        }
    }

    scan(folder);
    return files.sort();
}
export function verifyObsoletePluginFile(change) {
    assertSafePath(change.destinationPath);

    if (
        !regular(change.destinationPath) ||
        sha256(change.destinationPath) !== change.destinationSha256
    ) {
        throw new Error(
            `Obsolete plugin file changed before removal: ${change.component}/${change.file}`
        );
    }
}

export function removeObsoletePluginFile(change) {
    verifyObsoletePluginFile(change);

    rmSync(change.destinationPath);

    if (existsSync(change.destinationPath)) {
        throw new Error(
            `Obsolete plugin file removal failed: ${change.component}/${change.file}`
        );
    }
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
