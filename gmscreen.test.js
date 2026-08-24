import { test } from "node:test";
import assert from "node:assert/strict";
import { stripStandaloneBrackets, extractFirstJsonObject } from "./gmscreen.js";

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
