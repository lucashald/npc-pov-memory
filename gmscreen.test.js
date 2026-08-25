import { test } from "node:test";
import assert from "node:assert/strict";
import {
    stripStandaloneBrackets,
    extractFirstJsonObject,
    recoverJsonStringFields,
    resolveRewriteScope,
    buildRewritePrompt,
    cleanRewriteOutput,
    collectChatImages,
    planBracketStrip,
    DEFAULT_REWRITE_INSTRUCTION,
} from "./gmscreen.js";

test("strips a trailing tag but keeps the sentence", () => {
    assert.equal(
        stripStandaloneBrackets("The lock clicks open. [ITEM GAINED: silver rope]"),
        "The lock clicks open.",
    );
});

test("drops a whole-line meta tag and keeps surrounding prose", () => {
    assert.equal(
        stripStandaloneBrackets("I pick the lock\n\n[System: They SUCCEEDED.]"),
        "I pick the lock",
    );
});

test("empties a message that is only a bracket span", () => {
    assert.equal(stripStandaloneBrackets("[You add a dagger to your inventory]"), "");
});

test("keeps mid-sentence brackets", () => {
    assert.equal(
        stripStandaloneBrackets("she said [sarcastically] hello"),
        "she said [sarcastically] hello",
    );
});

test("keeps markdown links", () => {
    assert.equal(
        stripStandaloneBrackets("See [the docs](http://x) for more"),
        "See [the docs](http://x) for more",
    );
});

test("strips multiple trailing tags on one line", () => {
    assert.equal(
        stripStandaloneBrackets("Done. [ITEM LOST: rope] [SKILL DC: 12]"),
        "Done.",
    );
});

test("passes non-string through unchanged", () => {
    assert.equal(stripStandaloneBrackets(undefined), undefined);
});

import { gmscreenRole } from "./gmscreen.js";

const card = (role) => ({ data: { extensions: role === undefined ? {} : { gmscreen_role: role } } });

test("gmscreenRole reads an explicit npc", () => {
    assert.equal(gmscreenRole(card("npc")), "npc");
});

test("gmscreenRole reads an explicit gm", () => {
    assert.equal(gmscreenRole(card("gm")), "gm");
});

test("gmscreenRole returns null when unset", () => {
    assert.equal(gmscreenRole(card(undefined)), null);
});

test("gmscreenRole returns null for a malformed value", () => {
    assert.equal(gmscreenRole(card("boss")), null);
});

test("gmscreenRole tolerates a missing character", () => {
    assert.equal(gmscreenRole(null), null);
    assert.equal(gmscreenRole(undefined), null);
});

test("extractFirstJsonObject: plain object", () => {
    assert.equal(extractFirstJsonObject('{"a":"b"}'), '{"a":"b"}');
});

test("extractFirstJsonObject: ignores prose before and after", () => {
    assert.equal(
        extractFirstJsonObject('Sure! {"a":"b"} hope that helps'),
        '{"a":"b"}',
    );
});

test("extractFirstJsonObject: stops at the first balanced object, dropping trailing prose", () => {
    const input = '{"autobiography":"x","goals":"y"}\nAlice: and then she continued talking...';
    assert.equal(extractFirstJsonObject(input), '{"autobiography":"x","goals":"y"}');
});

test("extractFirstJsonObject: respects braces inside string values", () => {
    assert.equal(
        extractFirstJsonObject('{"a":"has } and { inside"}'),
        '{"a":"has } and { inside"}',
    );
});

test("extractFirstJsonObject: handles escaped quotes in values", () => {
    assert.equal(
        extractFirstJsonObject('{"a":"she said \\"hi\\" to me"} trailing'),
        '{"a":"she said \\"hi\\" to me"}',
    );
});

test("extractFirstJsonObject: returns empty when no object present", () => {
    assert.equal(extractFirstJsonObject("no json here"), "");
});

test("extractFirstJsonObject: returns empty for an unclosed object", () => {
    assert.equal(extractFirstJsonObject('{"a":"b" and it just kept going'), "");
});

test("extractFirstJsonObject: reconstructs from a prefill-style prepend", () => {
    const prefill = '{\n"autobiography": "';
    const modelReply = 'Bob is wary.","relationship":"tense","secrets":"none","goals":"gain trust"}\nextra prose';
    const parsed = JSON.parse(extractFirstJsonObject(prefill + modelReply));
    assert.equal(parsed.autobiography, "Bob is wary.");
    assert.equal(parsed.goals, "gain trust");
});

// ---- resolveRewriteScope ----
const scopeChat = [
    { is_user: true },                    // 0
    { is_user: false },                   // 1
    { is_user: true },                    // 2
    { is_user: false },                   // 3
    { is_user: false, is_system: true },  // 4
    { is_user: false },                   // 5
];

test("resolveRewriteScope: single passes filter", () => {
    assert.deepEqual(resolveRewriteScope(scopeChat, { mode: "single", mesId: 3, filter: "ai" }), [3]);
});

test("resolveRewriteScope: single blocked by filter", () => {
    assert.deepEqual(resolveRewriteScope(scopeChat, { mode: "single", mesId: 0, filter: "ai" }), []);
});

test("resolveRewriteScope: lastN then filter, drops system", () => {
    assert.deepEqual(resolveRewriteScope(scopeChat, { mode: "lastN", n: 3, filter: "ai" }), [3, 5]);
});

test("resolveRewriteScope: all + ai excludes user and system", () => {
    assert.deepEqual(resolveRewriteScope(scopeChat, { mode: "all", filter: "ai" }), [1, 3, 5]);
});

test("resolveRewriteScope: all + user", () => {
    assert.deepEqual(resolveRewriteScope(scopeChat, { mode: "all", filter: "user" }), [0, 2]);
});

test("resolveRewriteScope: range inclusive, filtered", () => {
    assert.deepEqual(resolveRewriteScope(scopeChat, { mode: "range", start: 1, end: 4, filter: "all" }), [1, 2, 3]);
});

test("resolveRewriteScope: includeSystem keeps system", () => {
    assert.deepEqual(resolveRewriteScope(scopeChat, { mode: "all", filter: "ai", includeSystem: true }), [1, 3, 4, 5]);
});

test("resolveRewriteScope: empty chat", () => {
    assert.deepEqual(resolveRewriteScope([], { mode: "all" }), []);
});

// ---- buildRewritePrompt ----
test("buildRewritePrompt: uses explicit instruction", () => {
    const { prompt } = buildRewritePrompt({ messageText: "Bob lived.", instruction: "Kill Bob." });
    assert.ok(prompt.includes("Kill Bob."));
    assert.ok(prompt.includes("Bob lived."));
});

test("buildRewritePrompt: default instruction substitutes persona name", () => {
    const { prompt } = buildRewritePrompt({ messageText: "x", instruction: "  ", userName: "Cara" });
    assert.ok(prompt.includes("Cara"));
    assert.ok(!prompt.includes("{{user}}"));
});

test("buildRewritePrompt: default template carries the token", () => {
    assert.ok(DEFAULT_REWRITE_INSTRUCTION.includes("{{user}}"));
});

test("buildRewritePrompt: system says output only", () => {
    const { system } = buildRewritePrompt({ messageText: "x", instruction: "y" });
    assert.ok(/only/i.test(system));
});

// ---- cleanRewriteOutput ----
test("cleanRewriteOutput: strips a wrapping fence", () => {
    assert.equal(cleanRewriteOutput("```\nHello world\n```"), "Hello world");
});

test("cleanRewriteOutput: strips wrapping quotes", () => {
    assert.equal(cleanRewriteOutput('"just this"'), "just this");
});

test("cleanRewriteOutput: passes plain text through trimmed", () => {
    assert.equal(cleanRewriteOutput("  kept  "), "kept");
});

// ---- collectChatImages ----
test("collectChatImages: gathers image and image_swipes, deduped, in order", () => {
    const chat = [
        { name: "Bob", extra: { image: "a.png" } },
        { name: "Alice", extra: {} },
        { name: "Bob", extra: { image: "a.png", image_swipes: ["a.png", "b.png"] } },
        { name: "Cara", extra: { image_swipes: ["c.png"] } },
    ];
    assert.deepEqual(collectChatImages(chat), [
        { url: "a.png", messageIndex: 0, name: "Bob" },
        { url: "b.png", messageIndex: 2, name: "Bob" },
        { url: "c.png", messageIndex: 3, name: "Cara" },
    ]);
});

test("collectChatImages: no images", () => {
    assert.deepEqual(collectChatImages([{ mes: "hi" }]), []);
});

// ---- planBracketStrip ----
test("planBracketStrip: flags trailing-tag and whole-line-tag messages", () => {
    const chat = [
        { mes: "The lock opens. [ITEM GAINED: rope]" },
        { mes: "plain text, nothing to do" },
        { mes: "[System: They SUCCEEDED.]" },
    ];
    assert.deepEqual(planBracketStrip(chat), [
        { index: 0, newText: "The lock opens.", remove: false },
        { index: 2, newText: "", remove: true },
    ]);
});

test("planBracketStrip: skips messages without brackets", () => {
    assert.deepEqual(planBracketStrip([{ mes: "no brackets here" }]), []);
});

test("collectChatImages: reads extra.media[] (current ST format)", () => {
    const chat = [
        { name: "Bob", extra: { media: [{ type: "image", url: "m1.png" }] } },
        { name: "Alice", extra: { media: [{ type: "video", url: "clip.mp4" }] } },
        { name: "Cara", extra: { media: [{ url: "m2.png" }, { type: "image", url: "m1.png" }] } },
    ];
    assert.deepEqual(collectChatImages(chat), [
        { url: "m1.png", messageIndex: 0, name: "Bob" },
        { url: "m2.png", messageIndex: 2, name: "Cara" },
    ]);
});

test("collectChatImages: still handles legacy fields", () => {
    const chat = [{ name: "Bob", extra: { image: "old.png", image_swipes: ["old.png", "old2.png"] } }];
    assert.deepEqual(collectChatImages(chat), [
        { url: "old.png", messageIndex: 0, name: "Bob" },
        { url: "old2.png", messageIndex: 0, name: "Bob" },
    ]);
});

test("extractFirstJsonObject: handles the five-key appearance payload with prefill", () => {
    const prefill = '{\n"autobiography": "';
    const reply = 'Bob is wary.","relationship":"tense","secrets":"none","goals":"gain trust",'
        + '"appearance":"A heavyset man in a soot-stained coat, left eye swollen shut."}\ntrailing prose';
    const parsed = JSON.parse(extractFirstJsonObject(prefill + reply));
    assert.equal(parsed.appearance, "A heavyset man in a soot-stained coat, left eye swollen shut.");
    assert.equal(parsed.goals, "gain trust");
});

test("extractFirstJsonObject: tolerates a payload with no appearance key", () => {
    const parsed = JSON.parse(extractFirstJsonObject(
        '{"autobiography":"a","relationship":"b","secrets":"c","goals":"d"}'));
    assert.equal(parsed.appearance, undefined);
});

test("recoverJsonStringFields: salvages complete fields from a truncated object", () => {
    const truncated = '{\n"autobiography": "Bob is gruff.",\n"relationship": "Wary of Cara.",\n"goals": "Fix the ship befor';
    const out = recoverJsonStringFields(truncated, ["autobiography", "relationship", "secrets", "goals", "appearance"]);
    assert.equal(out.autobiography, "Bob is gruff.");
    assert.equal(out.relationship, "Wary of Cara.");
    assert.equal(out.goals, undefined);
    assert.equal(out.secrets, undefined);
});

test("recoverJsonStringFields: unescapes JSON escapes in values", () => {
    // Build the source with JSON.stringify so escaping is unambiguous.
    const value = 'She said "hi" and left.\nThen returned.';
    const src = '{"autobiography": ' + JSON.stringify(value) + ', "goals": "trunc';
    const out = recoverJsonStringFields(src, ["autobiography", "goals"]);
    assert.equal(out.autobiography, value);
    assert.equal(out.goals, undefined);
});

test("recoverJsonStringFields: returns empty when nothing complete", () => {
    assert.deepEqual(recoverJsonStringFields('{"autobiography": "unclosed value', ["autobiography"]), {});
});
