import { test } from "node:test";
import assert from "node:assert/strict";
import {
    stripDialogue,
    findMentionedCharacters,
    composeImagePrompt,
    stableSeedFrom,
    buildTaggerPrompt,
    cleanTaggerOutput,
    stripNonVisual,
} from "./imageprompt.js";

// ---- stripDialogue ----

test("stripDialogue: strips asterisk markers but keeps every word they wrapped", () => {
    const input = '*She leans against the fuselage, arms folded.* You\'re late, again.';
    assert.equal(stripDialogue(input), "She leans against the fuselage, arms folded. You're late, again.");
});

test("stripDialogue: removes quoted speech regardless of surrounding asterisks", () => {
    const input = '*He sets down the crate.* "Careful." *Dust rises around his boots.*';
    assert.equal(stripDialogue(input), "He sets down the crate. Dust rises around his boots.");
});

test("stripDialogue: removes quoted speech when there are no asterisks", () => {
    const input = 'She wipes grease from her hands. "It\'ll hold," she says, not looking up.';
    assert.equal(stripDialogue(input), "She wipes grease from her hands. she says, not looking up.");
});

test("stripDialogue: removes curly-quoted speech", () => {
    const input = "He stands in the rain. “Go home.” The door closes.";
    assert.equal(stripDialogue(input), "He stands in the rain. The door closes.");
});

test("stripDialogue: passes through a message with no markers", () => {
    const input = "The hangar is cold and mostly dark, one lamp burning over the workbench.";
    assert.equal(stripDialogue(input), input);
});

test("stripDialogue: collapses newlines into one line", () => {
    assert.equal(stripDialogue("Line one.\n\nLine two."), "Line one. Line two.");
});

test("stripDialogue: empty input", () => {
    assert.equal(stripDialogue(""), "");
    assert.equal(stripDialogue(null), "");
});

// ---- findMentionedCharacters ----

test("findMentionedCharacters: returns names in order of appearance", () => {
    const text = "She hands Cara a blaster while Bren watches from the gantry.";
    assert.deepEqual(findMentionedCharacters(text, ["Bren", "Cara", "Pellam"]), ["Cara", "Bren"]);
});

test("findMentionedCharacters: is case-insensitive", () => {
    assert.deepEqual(findMentionedCharacters("cara nods.", ["Cara"]), ["Cara"]);
});

test("findMentionedCharacters: matches whole words only", () => {
    assert.deepEqual(findMentionedCharacters("The caravan rolls past.", ["Cara"]), []);
});

test("findMentionedCharacters: no matches", () => {
    assert.deepEqual(findMentionedCharacters("Nobody is here.", ["Cara", "Bren"]), []);
});

test("findMentionedCharacters: tolerates bad input", () => {
    assert.deepEqual(findMentionedCharacters(null, ["Cara"]), []);
    assert.deepEqual(findMentionedCharacters("Cara", null), []);
});

// ---- composeImagePrompt ----

test("composeImagePrompt: single subject uses the description verbatim", () => {
    const out = composeImagePrompt({
        appearances: [{ name: "Cara", text: "A teal-skinned Twi'lek pilot in a worn flight suit." }],
        narration: "She leans against the fuselage.",
    });
    assert.equal(
        out,
        "A teal-skinned Twi'lek pilot in a worn flight suit.\n\nShe leans against the fuselage.",
    );
});

test("composeImagePrompt: multiple subjects are name-prefixed", () => {
    const out = composeImagePrompt({
        appearances: [
            { name: "Cara", text: "Teal Twi'lek in a flight suit." },
            { name: "Bren", text: "Grey-haired mechanic, goggles pushed up." },
        ],
        narration: "They argue over the open panel.",
    });
    assert.ok(out.includes("Cara: Teal Twi'lek in a flight suit."));
    assert.ok(out.includes("Bren: Grey-haired mechanic, goggles pushed up."));
    assert.ok(out.endsWith("They argue over the open panel."));
});

test("composeImagePrompt: skips characters with no stored appearance", () => {
    const out = composeImagePrompt({
        appearances: [{ name: "Cara", text: "Teal Twi'lek." }, { name: "Bren", text: "" }],
        narration: "They wait.",
    });
    assert.equal(out, "Teal Twi'lek.\n\nThey wait.");
});

test("composeImagePrompt: appends a style suffix", () => {
    const out = composeImagePrompt({
        appearances: [{ name: "Cara", text: "Teal Twi'lek." }],
        narration: "She waits.",
        styleSuffix: "Shot on 35mm, shallow depth of field.",
    });
    assert.equal(out, "Teal Twi'lek.\n\nShe waits.\n\nShot on 35mm, shallow depth of field.");
});

test("composeImagePrompt: narration only, no appearances", () => {
    assert.equal(composeImagePrompt({ narration: "An empty hangar at dusk." }), "An empty hangar at dusk.");
});

test("composeImagePrompt: everything empty", () => {
    assert.equal(composeImagePrompt({}), "");
});

// ---- stableSeedFrom ----

test("stableSeedFrom: deterministic for the same input", () => {
    assert.equal(stableSeedFrom("cara.png"), stableSeedFrom("cara.png"));
});

test("stableSeedFrom: differs across inputs", () => {
    assert.notEqual(stableSeedFrom("cara.png"), stableSeedFrom("bren.png"));
});

test("stableSeedFrom: returns an unsigned 32-bit integer", () => {
    const seed = stableSeedFrom("cara.png");
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32);
});

// ---- unbalanced quotes (regression: inverted strip) ----

test("stripDialogue: a stray leading quote does not invert the strip", () => {
    const input = '"Hello there. She walks to the window, arms folded. "It is cold," she says.';
    const out = stripDialogue(input);
    assert.ok(out.includes("She walks to the window"), `narration was dropped: ${out}`);
});

test("stripDialogue: odd quote count keeps all words rather than guessing", () => {
    const input = 'She sets down the mug. "Careful, it is hot.';
    const out = stripDialogue(input);
    assert.ok(out.includes("She sets down the mug."));
    assert.ok(!out.includes('"'));
});

test("stripDialogue: empty quote pair at the start is harmless", () => {
    const input = '"" She leans against the doorway. "Go on," he says.';
    const out = stripDialogue(input);
    assert.ok(out.includes("She leans against the doorway"), out);
    assert.ok(!out.includes("Go on"), out);
});

test("stripDialogue: balanced quotes still strip normally", () => {
    const input = 'She wipes her hands. "It will hold." The lamp flickers.';
    const out = stripDialogue(input);
    assert.ok(!out.includes("It will hold"));
    assert.ok(out.includes("She wipes her hands."));
    assert.ok(out.includes("The lamp flickers."));
});

// ---- asterisks as emphasis, not action markers (regression) ----

test("stripDialogue: keeps the body when asterisks only wrap a scene header", () => {
    const input = [
        "⏳ *Monday afternoon, after final bell*",
        "\u{1F4CD} *Classroom 118 - ground floor, art wing*",
        "",
        "Rows of old wooden desks, a tall window facing the athletic field,",
        "afternoon light slanting gold through half-drawn blinds.",
    ].join("\n");
    const out = stripDialogue(input);
    assert.ok(out.includes("Rows of old wooden desks"), `body was dropped: ${out}`);
    assert.ok(out.includes("half-drawn blinds"), out);
});

test("stripDialogue: drops scene-marker emoji", () => {
    const out = stripDialogue("⏳ *The next morning* \u{1F4CD} *Her bedroom* Light through the blinds.");
    assert.ok(!/[⏳\u{1F4CD}]/u.test(out), out);
});

test("stripDialogue: keeps narration when asterisks wrap a short quoted message", () => {
    const input = "Three dots. Then: *Good. I was worried.* A pause. The next message arrives with a photo attached, taken in a mirror under bad light.";
    const out = stripDialogue(input);
    assert.ok(out.includes("The next message arrives with a photo attached"), out);
});

test("stripDialogue: asterisks never decide what is kept, whatever their share", () => {
    // Same words, opposite asterisk usage: both keep all the prose.
    const mostlyWrapped = "*She leans against the fuselage, watching the horizon.* You are late.";
    const barelyWrapped = "She leans against the fuselage, watching the horizon. *You* are late.";
    assert.equal(stripDialogue(mostlyWrapped), "She leans against the fuselage, watching the horizon. You are late.");
    assert.equal(stripDialogue(barelyWrapped), "She leans against the fuselage, watching the horizon. You are late.");
});

// ---- buildTaggerPrompt ----

test("buildTaggerPrompt: lists names and the scene, not appearance", () => {
    const { system, user } = buildTaggerPrompt({
        names: ["Cara", "Bren"],
        narration: "They argue over the open engine panel at dusk.",
    });
    assert.ok(/Characters in frame: Cara, Bren/.test(user));
    assert.ok(/single photograph/i.test(user));
    assert.ok(user.includes("They argue over the open engine panel at dusk."));
    // Appearance must NOT be requested from the tagger.
    assert.ok(!/APPEARANCE/.test(user));
    assert.ok(/not describe their permanent appearance/i.test(system));
});

test("buildTaggerPrompt: omits the names line when none are given", () => {
    const { user } = buildTaggerPrompt({ names: [], narration: "An empty corridor." });
    assert.ok(!/Characters in frame/.test(user));
    assert.ok(user.includes("An empty corridor."));
});

test("buildTaggerPrompt: notes an empty scene", () => {
    const { user } = buildTaggerPrompt({ names: ["Cara"], narration: "" });
    assert.ok(user.includes("(no action described)"));
});

test("buildTaggerPrompt: default points appearance at the supplied APPEARANCE", () => {
    const { system } = buildTaggerPrompt({ names: ["Cara"], narration: "y" });
    assert.ok(/photographer/i.test(system));
    assert.ok(/not describe their permanent appearance/i.test(system));
});

test("buildTaggerPrompt: systemOverride replaces the default", () => {
    const { system } = buildTaggerPrompt({ names: ["Cara"], narration: "y", systemOverride: "Custom instructions here." });
    assert.equal(system, "Custom instructions here.");
});

test("buildTaggerPrompt: blank override falls back to default", () => {
    const { system } = buildTaggerPrompt({ names: [], narration: "y", systemOverride: "   " });
    assert.ok(/photographer/i.test(system));
});

// ---- cleanTaggerOutput ----

test("cleanTaggerOutput: drops a leading label", () => {
    assert.equal(cleanTaggerOutput("Description: A woman by a window."), "A woman by a window.");
});

test("cleanTaggerOutput: keeps the description when a framing header comes first", () => {
    const raw = "Shot on a 50mm lens, eye-level, medium shot.\n\nSienna sits on a bench holding an iced coffee.";
    assert.equal(
        cleanTaggerOutput(raw),
        "Shot on a 50mm lens, eye-level, medium shot. Sienna sits on a bench holding an iced coffee.",
    );
});

test("cleanTaggerOutput: keeps all paragraphs of a multi-paragraph description", () => {
    const raw = "First beat of the scene.\n\nSecond beat, same shot.";
    assert.equal(cleanTaggerOutput(raw), "First beat of the scene. Second beat, same shot.");
});

test("cleanTaggerOutput: strips a think block", () => {
    assert.equal(cleanTaggerOutput("<think>hmm</think>A lit hallway."), "A lit hallway.");
});

test("cleanTaggerOutput: reasoning-only reply collapses to empty", () => {
    assert.equal(cleanTaggerOutput("<think>all my reasoning and nothing else"), "");
});

test("cleanTaggerOutput: caps runaway length", () => {
    const out = cleanTaggerOutput("word ".repeat(400));
    assert.ok(out.length <= 900);
});


// ---- stripNonVisual ----

test("stripNonVisual: removes a bracket caption even with trailing punctuation", () => {
    const out = stripNonVisual("[Chloe sends a picture that contains: 1girl, blonde].  She stands by the window.");
    assert.ok(!out.includes("["));
    assert.ok(out.includes("She stands by the window."));
});

test("stripNonVisual: removes GM tags mid-line and DC/HP tags", () => {
    const out = stripNonVisual("She kneels [sarcastically] on the tile. [SKILL DC: 3] [HP: -3]");
    assert.ok(!/\[/.test(out));
    assert.ok(out.includes("She kneels"));
});

test("stripNonVisual: removes checkbox glyphs", () => {
    const out = stripNonVisual("First box ☑ second box ☐ done ✓");
    assert.ok(!/[☑☐✓]/.test(out));
});

test("stripNonVisual: removes a markdown link entirely", () => {
    const out = stripNonVisual("See [the note](http://x) on the desk.");
    assert.ok(!out.includes("http"));
    assert.ok(!out.includes("["));
    assert.ok(out.includes("on the desk."));
});

