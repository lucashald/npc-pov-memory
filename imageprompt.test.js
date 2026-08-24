import { test } from "node:test";
import assert from "node:assert/strict";
import {
    stripDialogue,
    findMentionedCharacters,
    composeImagePrompt,
    stableSeedFrom,
} from "./imageprompt.js";

// ---- stripDialogue ----

test("stripDialogue: keeps asterisk narration and drops bare speech", () => {
    const input = '*She leans against the fuselage, arms folded.* You\'re late, again.';
    assert.equal(stripDialogue(input), "She leans against the fuselage, arms folded.");
});

test("stripDialogue: joins multiple asterisk spans", () => {
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
