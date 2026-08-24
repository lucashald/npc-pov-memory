// Pure helpers for building image-generation prompts from chat text.
// No SillyTavern imports, so this module is Node-testable.
//
// The design bet: Krea 2 pairs a Qwen3-VL encoder with prose, so it reads a
// plain description better than a tag list, and it is no worse than a separate
// tagger model at inventing framing or lighting that the transcript never
// stated. So instead of asking an LLM to rewrite the message into a prompt, we
// hand the image model the narration itself, with speech removed, prefixed by
// the stored appearance of whoever is in frame.

// Curly quotes are written as escapes so the pattern cannot be flattened into
// plain quotes by an editor or an encoding round-trip.
const QUOTED_SPEECH = /[\u201C\u201D][^\u201C\u201D\n]*[\u201C\u201D]|"[^"\n]*"/g;

/**
 * Reduce a roleplay message to just its visual narration.
 *
 * Only quotes are treated as a signal. Quotation marks reliably mean speech,
 * so quoted spans are removed.
 *
 * Asterisks are deliberately NOT used as a signal. They mean whatever the
 * writer wants: actions in one message, a scene header in the next, a quoted
 * text message in a third, or plain markdown italics on a single word. Any
 * rule built on them inverts as soon as a message uses them the other way,
 * and inverting means discarding the scene description and keeping the
 * speech, which is the worst possible outcome. So the markers are stripped
 * and every word they wrapped is kept.
 *
 * Scene-marker emoji are dropped: they are bookkeeping, and an image model
 * will happily render them as literal text.
 */
const SCENE_MARKERS = /[⏳⌛\u{1F4CD}\u{1F4C5}\u{1F4C6}\u{1F552}\u{1F55B}]/gu;

export function stripDialogue(text) {
    const input = String(text ?? "").replace(SCENE_MARKERS, " ");
    if (!input.trim()) {
        return "";
    }

    return collapse(removeQuotedSpeech(input.replace(/\*/g, " ")));
}

/**
 * Remove quoted speech, but only when the quoting is unambiguous.
 *
 * Straight quotes carry no direction, so pairing them depends entirely on
 * their count being even. One stray quote (a message that opens with one and
 * never closes it, say) shifts every pair by one, which inverts the result:
 * the narration gets deleted and only the dialogue survives. That is far worse
 * than doing nothing, because the image model then receives speech and no
 * description at all.
 *
 * So: strip empty pairs first, and if an odd number of straight quotes remains
 * the text is malformed and unparseable. In that case drop the quote
 * characters and keep every word. The cost is a little dialogue leaking into
 * the prompt; the alternative is losing the entire scene description.
 */
function removeQuotedSpeech(input) {
    // Empty pairs ("") carry no speech and would otherwise skew the parity.
    let text = input.replace(/""/g, " ").replace(/[“”]{2}/g, " ");

    const straightQuotes = (text.match(/"/g) || []).length;
    if (straightQuotes % 2 !== 0) {
        return text.replace(/["“”]/g, " ");
    }

    const stripped = text.replace(QUOTED_SPEECH, " ");

    // A message that is nothing but dialogue legitimately strips to nothing;
    // that is handled by the caller, which skips messages with no narration.
    return stripped;
}

function collapse(text) {
    return String(text)
        .replace(/\s*\n\s*/g, " ")
        .replace(/\s{2,}/g, " ")
        // Tidy punctuation stranded by a removed quote span.
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/^[\s,.;:]+/, "")
        .trim();
}

/**
 * Find which of `names` appear in `text`, in order of first appearance.
 *
 * Deliberately exact, whole-word and case-insensitive, with no fuzzy or
 * partial matching: character cards are expected to use single first names
 * so a plain match is enough. Duplicates are dropped.
 */
export function findMentionedCharacters(text, names) {
    const haystack = String(text ?? "");
    if (!haystack || !Array.isArray(names)) {
        return [];
    }

    const found = [];
    for (const name of names) {
        const clean = String(name ?? "").trim();
        if (!clean || found.includes(clean)) {
            continue;
        }
        const pattern = new RegExp(`\\b${escapeRegExp(clean)}\\b`, "i");
        const index = haystack.search(pattern);
        if (index !== -1) {
            found.push({ name: clean, index });
        }
    }

    return found.sort((a, b) => a.index - b.index).map(entry => entry.name);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Assemble the final prose prompt.
 *
 * appearances: [{ name, text }] for everyone who should be in frame.
 * Single subject gets its description verbatim; multiple subjects are
 * name-prefixed so the encoder can tell whose description is whose.
 * Entries with empty text are skipped, so an untracked character simply
 * contributes nothing rather than a blank label.
 */
export function composeImagePrompt({ appearances = [], narration = "", styleSuffix = "" } = {}) {
    const described = appearances
        .map(entry => ({ name: String(entry?.name ?? "").trim(), text: String(entry?.text ?? "").trim() }))
        .filter(entry => entry.text);

    const parts = [];

    if (described.length === 1) {
        parts.push(described[0].text);
    } else if (described.length > 1) {
        parts.push(described.map(entry => `${entry.name}: ${entry.text}`).join("\n"));
    }

    const scene = collapse(narration);
    if (scene) {
        parts.push(scene);
    }

    const suffix = String(styleSuffix ?? "").trim();
    if (suffix) {
        parts.push(suffix);
    }

    return parts.join("\n\n").trim();
}

/**
 * A stable 32-bit seed derived from a string, so the same character can be
 * rendered with the same seed every time. FNV-1a; the exact hash does not
 * matter, only that it is deterministic and spreads well.
 */
export function stableSeedFrom(value) {
    const input = String(value ?? "");
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
