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

// ============================================================
// NPC-manager pure helpers (no SillyTavern imports; Node-testable)
// ============================================================

// Resolve which chat indices a bulk operation targets.
// opts: { mode:'single'|'lastN'|'all'|'range', mesId?, n?, start?, end?,
//         filter?:'all'|'ai'|'user', includeSystem?:boolean }
export function resolveRewriteScope(chat, opts = {}) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return [];
    }
    const filter = opts.filter || "all";
    const includeSystem = Boolean(opts.includeSystem);

    let candidates = [];
    switch (opts.mode) {
        case "single":
            if (Number.isInteger(opts.mesId)) {
                candidates = [opts.mesId];
            }
            break;
        case "lastN": {
            const n = Math.max(0, Math.trunc(opts.n) || 0);
            for (let i = Math.max(0, chat.length - n); i < chat.length; i++) {
                candidates.push(i);
            }
            break;
        }
        case "range": {
            const start = Math.max(0, Math.trunc(opts.start) || 0);
            const end = Math.min(chat.length - 1, Math.trunc(opts.end) || 0);
            for (let i = start; i <= end; i++) {
                candidates.push(i);
            }
            break;
        }
        case "all":
        default:
            for (let i = 0; i < chat.length; i++) {
                candidates.push(i);
            }
            break;
    }

    return candidates.filter((i) => {
        if (i < 0 || i >= chat.length) return false;
        if (!includeSystem && chat[i].is_system === true) return false;
        if (filter === "ai") return !chat[i].is_user;
        if (filter === "user") return Boolean(chat[i].is_user);
        return true;
    });
}

// Default bulk-rewrite instruction when the user gives none: strip anywhere the
// assistant speaks for / narrates / controls the user persona. {{user}} is
// replaced with the persona name by buildRewritePrompt.
export const DEFAULT_REWRITE_INSTRUCTION =
    "Remove any portion of this message where the assistant speaks for, " +
    "narrates the actions of, describes the inner thoughts or feelings of, or " +
    "otherwise controls {{user}}. Delete those portions entirely; do not invent " +
    "replacement content. Keep everything else exactly as written: other " +
    "characters' dialogue, their actions, and narration of the environment. If a " +
    "sentence mixes allowed content with content about {{user}}, keep only the " +
    "allowed part. If nothing would remain, return an empty string.";

// Build the {system, prompt} pair for rewriting one message.
export function buildRewritePrompt({ messageText, instruction, userName } = {}) {
    const resolved =
        instruction && String(instruction).trim()
            ? String(instruction).trim()
            : DEFAULT_REWRITE_INSTRUCTION.replaceAll("{{user}}", userName || "the user");

    const system =
        "You are a careful copy editor revising one message from an existing " +
        "roleplay transcript. Apply the instruction and return ONLY the resulting " +
        "message text: no preamble, no explanation, no quotes, no code fences. " +
        "Preserve the original voice, tense, and markdown/asterisk formatting. " +
        "Change only what the instruction requires; leave everything else verbatim.";

    const prompt =
        `Instruction: ${resolved}\n\n` +
        `Message to edit:\n"""\n${String(messageText ?? "")}\n"""\n\n` +
        "Rewritten message:";

    return { system, prompt };
}

// Strip wrapping code fences / quotes the model may add around a rewrite.
// (Reasoning-block removal is applied by the caller via ST's removeReasoningFromString.)
export function cleanRewriteOutput(raw) {
    if (raw == null) {
        return "";
    }
    let text = String(raw).trim();
    const fence = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
    if (fence) {
        text = fence[1].trim();
    }
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        text = text.slice(1, -1);
    }
    return text.trim();
}

// Collect images that appear in a chat (generated or attached).
//
// Current SillyTavern stores attachments in extra.media[] as
// { type, url, ... } and migrates the legacy extra.image / extra.image_swipes
// fields into it on load, deleting the originals. Read media[] first and keep
// the legacy fields only as a fallback for chats that have not been migrated.
// Deduplicated, in chat order.
export function collectChatImages(chat) {
    if (!Array.isArray(chat)) {
        return [];
    }
    const out = [];
    const seen = new Set();
    for (let i = 0; i < chat.length; i++) {
        const extra = chat[i] && chat[i].extra;
        if (!extra) continue;
        const urls = [];

        if (Array.isArray(extra.media)) {
            for (const item of extra.media) {
                // type is absent on some older entries; treat those as images.
                if (item && typeof item.url === "string" && item.url
                    && (item.type === undefined || item.type === "image")) {
                    urls.push(item.url);
                }
            }
        }

        // Legacy fallback.
        if (typeof extra.image === "string" && extra.image) {
            urls.push(extra.image);
        }
        if (Array.isArray(extra.image_swipes)) {
            for (const u of extra.image_swipes) {
                if (typeof u === "string" && u) urls.push(u);
            }
        }

        for (const url of urls) {
            if (seen.has(url)) continue;
            seen.add(url);
            out.push({ url, messageIndex: i, name: (chat[i] && chat[i].name) || "" });
        }
    }
    return out;
}

// Plan a persisted bracket-strip pass over a chat. Returns a list of
// { index, newText, remove } where remove:true means the message became empty.
export function planBracketStrip(chat) {
    if (!Array.isArray(chat)) {
        return [];
    }
    const changes = [];
    for (let i = 0; i < chat.length; i++) {
        const original = String(chat[i] && chat[i].mes != null ? chat[i].mes : "");
        if (original.indexOf("[") === -1) continue;
        const stripped = stripStandaloneBrackets(original);
        if (stripped === original) continue;
        changes.push({ index: i, newText: stripped, remove: stripped.trim() === "" });
    }
    return changes;
}

// Salvage complete "key": "value" string fields from a possibly-truncated
// JSON object. When a model reply is cut off mid-object the JSON is invalid
// (no closing brace), so extractFirstJsonObject yields nothing; rather than
// discard the whole update, keep the fields that did finish. Values are
// JSON-unescaped. The truncated final field is simply omitted.
export function recoverJsonStringFields(text, keys) {
    const src = String(text ?? "");
    const out = {};
    for (const key of keys) {
        const safe = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = src.match(new RegExp('"' + safe + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
        if (match) {
            try {
                out[key] = JSON.parse('"' + match[1] + '"');
            } catch {
                out[key] = match[1];
            }
        }
    }
    return out;
}
