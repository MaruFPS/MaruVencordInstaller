import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createCustomizationHunks, applyCustomizationHunks } from "../source-customizations.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const policyPath = join(root, "bundle-policy.json");
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const targets = ["src/components/settings/tabs/themes/LocalThemesTab.tsx", "src/components/settings/tabs/vencord/index.tsx"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const files = {};
for (const file of targets) {
    const base = readFileSync(join(root, "source-overrides/base", file));
    const replacement = readFileSync(join(root, "source-overrides", file));
    const hunks = createCustomizationHunks(base.toString("utf8"), replacement.toString("utf8"));
    if (!hunks.length || applyCustomizationHunks(base.toString("utf8"), hunks, file).replace(/\r\n/g, "\n") !== replacement.toString("utf8").replace(/\r\n/g, "\n"))
        throw new Error(`Customization patch could not reproduce the bundled definition: ${file}`);
    files[file] = { baseSha256: digest(base), overrideSha256: digest(replacement) };
}
policy.overrides = {
    schemaVersion: 2,
    // Provenance of the reviewed patch base, never an upstream approval list.
    baseRevision: policy.overrides.baseRevision ?? policy.overrides.revision,
    files
};
if (!process.argv.includes("--dry-run")) writeFileSync(policyPath, JSON.stringify(policy, null, 2) + "\n");
console.log(`Verified ${targets.length} customization definitions${process.argv.includes("--dry-run") ? " (dry run)" : "; generated integrity metadata"}.`);
