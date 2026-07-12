import { test } from "node:test";
import assert from "node:assert/strict";
import { stripStandaloneBrackets } from "./gmscreen.js";

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
