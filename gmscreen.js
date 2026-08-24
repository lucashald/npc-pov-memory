// Pure, dependency-free helpers shared across the gmscreen extension suite.
// No SillyTavern imports here so this module is Node-testable and safe to
// import in the browser extension.

// A line that consists only of a single bracket span, e.g. "[System: ...]".
const WHOLE_LINE_TAG = /^\s*\[[^\]\n]*\]\s*$/;
// A bracket span flush at the end of a line, not immediately followed by "("
// (which would make it a markdown link like "[text](url)").
const TRAILING_TAG = /\s*\[[^\]\n]*\](?!\()\s*$/;

export function stripStandaloneBrackets(text) {
    if (typeof text !== "string" || text.indexOf("[") === -1) {
        return text;
    }

    const outLines = [];
    for (const line of text.split("\n")) {
        if (WHOLE_LINE_TAG.test(line)) {
            continue;
        }
        let out = line;
        while (TRAILING_TAG.test(out)) {
            out = out.replace(TRAILING_TAG, "");
        }
        outLines.push(out);
    }

    return outLines
        .join("\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// Extract the first complete, balanced top-level JSON object from a string,
// tolerating any prose the model emits before the opening "{" or after the
// closing "}". Respects string literals so braces inside string values do not
// throw off the brace counter. Returns "" when no balanced object is found.
export function extractFirstJsonObject(text) {
    const s = String(text ?? "");
    const start = s.indexOf("{");
    if (start === -1) {
        return "";
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === "\\") {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === "{") {
            depth++;
        } else if (ch === "}") {
            depth--;
            if (depth === 0) {
                return s.slice(start, i + 1);
            }
        }
    }

    return ""; // never closed
}

export function gmscreenRole(character) {
    const role = character?.data?.extensions?.gmscreen_role;
    return role === "gm" || role === "npc" ? role : null;
}
