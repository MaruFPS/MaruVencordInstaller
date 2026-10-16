// Exact-context patches derived from the reviewed base and bundled custom file.
// No upstream revision is approved or rejected here. Changes outside the patch
// context survive; missing or ambiguous context requires a compatibility review.
const normalize = text => text.replace(/\r\n/g, "\n");

function namedImports(text) {
    return [...text.matchAll(/^import[ \t]+\{([^}]+)\}[ \t]+from[ \t]+(["'])([^"']+)\2;?[ \t]*$/gm)].map(match => ({
        module: match[3], line: match[0], start: match.index, end: match.index + match[0].length,
        names: match[1].split(",").map(name => name.trim()).filter(Boolean)
    }));
}

function mergeNamedImport(text, hunk, label) {
    const rows = namedImports(text);
    const matches = rows.filter(row => row.module === hunk.module);
    if (matches.length > 1) throw new Error(`Customization import is ambiguous in ${label}: ${hunk.module}`);
    if (matches.length === 1) {
        const row = matches[0];
        if (!row.names.every(name => /^(?:type\s+)?[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?$/.test(name)))
            throw new Error(`Customization import needs compatibility review in ${label}: ${hunk.module}`);
        const added = hunk.names.filter(name => !row.names.includes(name));
        if (!added.length) return text;
        const line = `import { ${[...added, ...row.names].join(", ")} } from "${hunk.module}";`;
        return text.slice(0, row.start) + line + text.slice(row.end);
    }
    const otherImport = new RegExp(`^import[^\\n]*from[ \\t]+["']${hunk.module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "m");
    if (otherImport.test(text)) throw new Error(`Customization import style changed in ${label}: ${hunk.module}`);
    const anchor = rows.find(row => row.module === hunk.afterModule);
    const first = /^import\b/m.exec(text);
    if (!anchor && !first) throw new Error(`Customization import section is missing in ${label}.`);
    const at = anchor ? anchor.end + (text[anchor.end] === "\n" ? 1 : 0) : first.index;
    return text.slice(0, at) + hunk.line + "\n" + text.slice(at);
}

export function createCustomizationHunks(base, replacement, context = 5) {
    base = normalize(base);
    replacement = normalize(replacement);
    const baseImports = namedImports(base);
    const replacementImports = namedImports(replacement);
    const importHunks = [];
    // Named additions are compatible with unrelated import additions/reordering.
    // Removals or other changed import syntax still use exact checked patches.
    for (const [index, row] of replacementImports.entries()) {
        const originals = baseImports.filter(original => original.module === row.module);
        if (originals.length > 1) throw new Error(`Bundled import is ambiguous: ${row.module}`);
        const original = originals[0];
        const names = row.names.filter(name => !original?.names.includes(name));
        if (!names.length || original?.names.some(name => !row.names.includes(name))) continue;
        if (!names.every(name => /^[A-Za-z_$][\w$]*$/.test(name))) throw new Error(`Unsupported bundled import addition: ${row.module}`);
        importHunks.push({ kind: "named-import", module: row.module, names, line: row.line,
            afterModule: replacementImports[index - 1]?.module ?? null, start: row.start, end: row.end, original: original?.line });
    }
    let bodyReplacement = replacement;
    for (const hunk of [...importHunks].reverse()) {
        const end = hunk.original === undefined && bodyReplacement[hunk.end] === "\n" ? hunk.end + 1 : hunk.end;
        bodyReplacement = bodyReplacement.slice(0, hunk.start) + (hunk.original ?? "") + bodyReplacement.slice(end);
    }
    const a = base.split("\n");
    const b = bodyReplacement.split("\n");
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--)
            table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    const operations = [];
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) operations.push({ kind: "equal", line: a[i++] }), j++;
        else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) operations.push({ kind: "insert", line: b[j++] });
        else operations.push({ kind: "delete", line: a[i++] });
    }
    const ranges = [];
    for (let n = 0; n < operations.length; n++) {
        if (operations[n].kind === "equal") continue;
        let start = n, end = n + 1;
        for (let count = 0; start > 0 && count < context; start--) if (operations[start - 1].kind === "equal") count++;
        for (let count = 0; end < operations.length && count < context; end++) if (operations[end].kind === "equal") count++;
        const previous = ranges.at(-1);
        if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
        else ranges.push({ start, end });
    }
    const textHunks = ranges.map(({ start, end }) => {
        const group = operations.slice(start, end);
        return {
            before: group.filter(op => op.kind !== "insert").map(op => op.line).join("\n"),
            after: group.filter(op => op.kind !== "delete").map(op => op.line).join("\n")
        };
    });
    return [...textHunks, ...importHunks];
}

const nonemptyLines = text => text.split("\n").map(line => line.trim()).filter(Boolean);

function locations(text, block, allowFormatting = true) {
    const found = [];
    if (!block) return found;
    for (let from = 0; from <= text.length;) {
        const at = text.indexOf(block, from);
        if (at < 0) break;
        const end = at + block.length;
        if ((at === 0 || text[at - 1] === "\n") && (end === text.length || text[end] === "\n")) found.push({ start: at, end, formatted: false });
        from = at + 1;
    }
    // Accept indentation and empty-line differences only. Every nonempty line,
    // including its strings, expressions, comments, and inner spacing, must
    // still match. Multiline literals/comments keep the exact-match policy.
    if (!allowFormatting || /[`]|\/\*|\*\/|\\\n/.test(block)) return found;
    const expected = nonemptyLines(block);
    if (expected.length < 3) return found;
    const rows = [];
    let offset = 0;
    for (const line of text.split("\n")) {
        if (line.trim()) rows.push({ content: line.trim(), start: offset, end: offset + line.length });
        offset += line.length + 1;
    }
    for (let index = 0; index <= rows.length - expected.length; index++) {
        if (!expected.every((line, at) => rows[index + at].content === line)) continue;
        const start = rows[index].start;
        const end = rows[index + expected.length - 1].end;
        if (!found.some(match => match.start <= start && match.end >= end)) found.push({ start, end, formatted: true });
    }
    return found;
}

export function applyCustomizationHunks(source, hunks, label = "source customization") {
    let result = normalize(source);
    for (const [index, hunk] of hunks.entries()) {
        if (hunk.kind === "named-import") {
            result = mergeNamedImport(result, hunk, label);
            continue;
        }
        // Preservation also uses this engine for intentional user edits. A
        // formatting-only edit must be applied exactly, not mistaken for an
        // already-present semantic customization and silently discarded.
        const formattingOnly = JSON.stringify(nonemptyLines(hunk.before)) === JSON.stringify(nonemptyLines(hunk.after));
        const before = locations(result, hunk.before, !formattingOnly);
        const after = locations(result, hunk.after, !formattingOnly);
        if (after.length === 1 && (before.length === 0 || (before.length === 1 && before[0].start >= after[0].start && before[0].end <= after[0].end))) continue;
        if (before.length !== 1 || after.length !== 0)
            throw new Error(`Customization compatibility conflict in ${label}, patch ${index + 1}: expected one unchanged context or one already-applied context (found ${before.length}/${after.length}). Existing files were kept; developer review is required.`);
        const match = before[0];
        const replacement = match.formatted ? hunk.after.replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "") : hunk.after;
        result = result.slice(0, match.start) + replacement + result.slice(match.end);
    }
    return source.includes("\r\n") ? result.replace(/\n/g, "\r\n") : result;
}
