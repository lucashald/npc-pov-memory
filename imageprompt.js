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

// ---------------------------------------------------------------------------
// Tagger: turn a scene into ONE photographic description via an LLM.
//
// The raw narration path hands krea2 the whole message, which carries beats,
// interiority, and no single focus, so the encoder averages it into mush. The
// tagger distills one message into one photograph. Crucially it is GIVEN the
// characters' stored appearance rather than asked to invent it: identity stays
// fixed across renders, and the model only chooses the moment, pose, framing,
// and light.
// ---------------------------------------------------------------------------

// Default tagger instruction.
//
// The tagger describes ONLY the action of a moment: what the named characters
// are doing, their pose and expression, the setting, the light, and the shot
// framing. It is deliberately told NOT to describe fixed appearance (hair, eye
// colour, build, face, clothing) because we prepend the stored APPEARANCE field
// ourselves afterward (see composeImagePrompt). That split is the whole point:
// the appearance cannot drift if the tagger never handles it, and the tagger's
// job shrinks to distilling messy narration into one clean camera moment.
// Editable per install; resist re-bloating it.
export const DEFAULT_TAGGER_SYSTEM = [
    "You convert roleplay text into a photographic description of a single still",
    "image. Respond with ONLY the description, written as flowing prose. No tag",
    "lists, no preamble, no explanation.",
    "",
    "Write it as a brief to a photographer: what the named characters are doing,",
    "their pose and expression, the setting, the quality and direction of the",
    "light, and the camera framing and lens feel. Refer to the characters by",
    "name; do NOT describe their permanent appearance (hair, eye colour, skin,",
    "build, face, or clothing), which is supplied separately. Two to four",
    "sentences. Describe only what a camera would capture. Omit dialogue,",
    "personality, thoughts, intentions, sounds, smells, and abstract or",
    "metaphorical qualities. Never use Danbooru tags such as 1girl or masterpiece.",
].join("\n");

/**
 * Build the {system, user} message pair for the tagger.
 * names: the characters in frame, so the tagger can attribute actions.
 * narration: the scene text (dialogue and meta already stripped upstream).
 * systemOverride: a custom instruction; falls back to DEFAULT_TAGGER_SYSTEM.
 *
 * Appearance is intentionally NOT sent; composeImagePrompt prepends it to the
 * tagger's output, so the tagger cannot drift it.
 */
export function buildTaggerPrompt({ names = [], narration = "", systemOverride = "" } = {}) {
    const baseSystem = String(systemOverride ?? "").trim() || DEFAULT_TAGGER_SYSTEM;
    const cleanNames = (Array.isArray(names) ? names : [])
        .map(n => String(n ?? "").trim())
        .filter(Boolean);

    const lines = [];
    if (cleanNames.length) {
        lines.push(`Characters in frame: ${cleanNames.join(", ")}.`);
        lines.push("");
    }
    lines.push("Describe this moment as a single photograph:");
    lines.push("");
    lines.push(collapse(narration) || "(no action described)");

    const system = baseSystem;

    return { system, user: lines.join("\n") };
}

/**
 * Clean a tagger reply into a usable prompt.
 *
 * Models commonly prepend a label and then echo the input back, so keep the
 * first paragraph only. Reasoning blocks and code fences are stripped. Length
 * is capped because a runaway reply would send the whole transcript to the
 * image model. Reasoning-only replies (empty content, everything in a think
 * block) collapse to "" and the caller treats that as a failure.
 */
export function cleanTaggerOutput(text) {
    let out = String(text ?? "");

    // Reasoning models wrap thinking in channel markers and put the final
    // answer last. Harmony uses <|channel|>final<|message|>ANSWER; some local
    // Gemma/MLX variants use <|channel>thought ... <channel|>ANSWER. Take the
    // text after the LAST such marker, which is the answer. <|message|> wins
    // when present (real harmony); otherwise fall back to the channel marker.
    const messageMarks = [...out.matchAll(/<\|message\|>/gi)];
    if (messageMarks.length) {
        const last = messageMarks[messageMarks.length - 1];
        out = out.slice(last.index + last[0].length);
    } else {
        const channelMarks = [...out.matchAll(/<\/?\|?channel\|?>/gi)];
        if (channelMarks.length) {
            const last = channelMarks[channelMarks.length - 1];
            out = out.slice(last.index + last[0].length);
        }
    }

    out = out
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<think>[\s\S]*$/i, "")
        // strip any leftover control tokens like <|end|>, <|start|>, final tag
        .replace(/<\|?[a-z_]+\|?>/gi, "")
        .replace(/^\s*(?:final|analysis|thought)\b[:\s]*/i, "")
        .replace(/^```[a-z]*|```$/gim, "")
        .trim();
    // Drop a leading label such as "Description:".
    out = out.replace(/^[a-z ]{0,24}:\s*/i, "").trim();
    // Keep the whole reply: collapse folds any paragraph breaks into one line.
    // (Previously this took only the first paragraph to drop echoed input, but
    // that discarded the description whenever the model led with a one-line
    // framing header like "Shot on a 50mm lens, eye-level, medium shot.")
    out = collapse(out);
    if (out.length > 900) {
        out = out.slice(0, 900).replace(/\s+\S*$/, "");
    }
    return out;
}

// Remove everything a camera cannot see, for image prompts specifically:
// bracketed meta anywhere on the line (GM tags, [X sends a picture that
// contains: ...] captions, [SKILL DC]/[HP]), markdown links, and checkbox
// glyphs. The RP interceptor's stripStandaloneBrackets deliberately keeps
// mid-sentence brackets like "she said [sarcastically] hi"; for an image none
// of that is visual, so here it all goes.
const MARKDOWN_LINK = /\[[^\]\n]*\]\([^)\n]*\)/g;
const BRACKET_SPAN = /\[[^\]\n]*\]/g;
const NON_VISUAL_GLYPHS = /[☑☐✓✔✗✘√]/g;

export function stripNonVisual(text) {
    return String(text ?? "")
        .replace(MARKDOWN_LINK, " ")
        .replace(BRACKET_SPAN, " ")
        .replace(NON_VISUAL_GLYPHS, " ");
}
