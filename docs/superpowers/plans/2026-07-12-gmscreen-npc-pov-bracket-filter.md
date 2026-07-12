# NPC POV Memory — gmscreen Bracket Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the NPC POV Memory extension the ability to strip GM/meta bracket tags (e.g. `[ITEM GAINED: dagger]`, `[System: … SUCCEEDED.]`) out of the transcript sent to any card explicitly marked as a non-GM NPC, so in-world NPCs neither see nor act on game-master mechanics.

**Architecture:** A new SillyTavern `generate_interceptor` runs before each generation, identifies the drafting card, and — only when that card's shared `gmscreen_role` flag is `"npc"` — replaces the outgoing transcript messages with copies whose standalone bracket spans are removed. The filter is stateless (recomputed every turn), operates on cloned message objects so the saved chat is never mutated, and reads the same neutral `data.extensions.gmscreen_role` field skill-check uses. Pure string/role logic lives in a dependency-free `gmscreen.js` module that is unit-tested under Node; the ST-coupled wiring is verified manually in the app.

**Tech Stack:** Vanilla ES-module JavaScript, jQuery (bundled by SillyTavern), SillyTavern extension context API (`getContext`, `setExtensionPrompt`, `writeExtensionField`, `generate_interceptor`), Node built-in test runner (`node --test`) for pure functions.

**Target repository:** `C:\npc-pov-memory` (this repo). The plan file lives here; run all commands from this repo root.

## Global Constraints

- **Shared card contract (the `gmscreen` namespace):** the flag lives at `data.extensions.gmscreen_role`, a **flat** string field with values `"gm"` or `"npc"`, or **absent** (meaning "unset / no opinion"). Verbatim rule: only `gmscreen_role === "npc"` ever triggers stripping; `"gm"`, absent, or any other value strips nothing.
- **Never persist a default for `gmscreen_role`.** It must never be written by any autosave/normalize path (it is NOT part of `makeEmptyStore`/`normalizeStore`). It is written only by explicit user action in the role UI. Absent must stay absent until the user chooses.
- **Never mutate saved chat.** The interceptor may only replace array slots with cloned message objects (`{ ...message, mes: filtered }`) or splice slots out; it must never assign to `message.mes` on an object shared with the live chat.
- **Node test files** use only `node:test` + `node:assert/strict` — no third-party test dependencies.
- Follow the existing code style in `index.js`: 4-space indent, double-quoted strings, `const`/`let`, no semicolon omission.

---

## File Structure

- `gmscreen.js` (new) — pure, dependency-free helpers: `gmscreenRole(character)` and `stripStandaloneBrackets(text)`. No SillyTavern imports, so it is Node-testable and browser-importable.
- `gmscreen.test.js` (new) — Node unit tests for `gmscreen.js`.
- `package.json` (new) — `{"type":"module","private":true}` so Node treats `.js` as ESM for `node --test`; harmless to SillyTavern.
- `manifest.json` (modify) — declare the `generate_interceptor`.
- `index.js` (modify) — import `gmscreen.js`; add the interceptor global; add two settings (master filter toggle + treat-unmarked-as-NPC toggle); add a role authoring `<select>` to the settings panel; write the flag via `writeExtensionField`.
- `sample-characters/dampener-block-h-gm.dampener-block-h.json` (modify) — seed `gmscreen_role: "gm"`.
- `README.md` (modify) — document the `gmscreen` contract and the filter feature.

---

### Task 1: Pure `stripStandaloneBrackets` function

**Files:**
- Create: `C:\npc-pov-memory\package.json`
- Create: `C:\npc-pov-memory\gmscreen.js`
- Test: `C:\npc-pov-memory\gmscreen.test.js`

**Interfaces:**
- Produces: `export function stripStandaloneBrackets(text: string): string` — returns `text` with (a) any line that is *only* a `[...]` span removed entirely, and (b) any `[...]` span flush at the end of a line removed, while leaving mid-sentence brackets and markdown links (`[x](y)`) untouched. Non-string input returns the input unchanged.

- [ ] **Step 1: Create `package.json` so Node runs `.js` as ESM**

```json
{
  "name": "npc-pov-memory",
  "version": "0.1.0",
  "private": true,
  "type": "module"
}
```

- [ ] **Step 2: Write the failing test**

Create `C:\npc-pov-memory\gmscreen.test.js`:

```javascript
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test`
Expected: FAIL — `Cannot find module './gmscreen.js'` (or export missing).

- [ ] **Step 4: Write the minimal implementation**

Create `C:\npc-pov-memory\gmscreen.js`:

```javascript
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add package.json gmscreen.js gmscreen.test.js
git commit -m "feat: add pure stripStandaloneBrackets bracket filter"
```

---

### Task 2: Pure `gmscreenRole` resolver

**Files:**
- Modify: `C:\npc-pov-memory\gmscreen.js`
- Test: `C:\npc-pov-memory\gmscreen.test.js`

**Interfaces:**
- Produces: `export function gmscreenRole(character): "gm" | "npc" | null` — reads `character.data.extensions.gmscreen_role`; returns `"gm"` or `"npc"` only for those exact values, otherwise `null` (covers absent, unset, malformed, and a null/undefined character).

- [ ] **Step 1: Add the failing tests**

Append to `C:\npc-pov-memory\gmscreen.test.js`:

```javascript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test`
Expected: FAIL — `gmscreenRole` is not exported.

- [ ] **Step 3: Implement the resolver**

Append to `C:\npc-pov-memory\gmscreen.js`:

```javascript
export function gmscreenRole(character) {
    const role = character?.data?.extensions?.gmscreen_role;
    return role === "gm" || role === "npc" ? role : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add gmscreen.js gmscreen.test.js
git commit -m "feat: add gmscreenRole shared-contract resolver"
```

---

### Task 3: Interceptor mutation-safety spike (VERIFY BEFORE BUILDING THE FILTER)

This task exists because the entire filter approach depends on one unknown: does the `chat` array a `generate_interceptor` receives affect the **saved** chat when mutated? Do not write filter logic until this is answered. The deliverable is a documented answer plus a confirmed-safe write pattern.

**Files:**
- Modify: `C:\npc-pov-memory\manifest.json`
- Modify: `C:\npc-pov-memory\index.js`
- Create: `C:\npc-pov-memory\docs\superpowers\plans\notes-interceptor-safety.md` (findings)

**Interfaces:**
- Produces: a global `globalThis.npcPovMemoryGenerateInterceptor(chat, contextSize, abort, type)` that (for this task) only logs, and a documented decision on clone-vs-in-place.

- [ ] **Step 1: Declare the interceptor in the manifest**

Edit `C:\npc-pov-memory\manifest.json`, add the field after `"css"`:

```json
{
  "display_name": "NPC POV Memory",
  "loading_order": 1,
  "requires": [],
  "optional": [],
  "js": "index.js",
  "css": "style.css",
  "generate_interceptor": "npcPovMemoryGenerateInterceptor",
  "author": "lucashald",
  "version": "0.1.0",
  "homePage": "https://github.com/lucashald/npc-pov-memory",
  "auto_update": true
}
```

- [ ] **Step 2: Add a logging-only interceptor to `index.js`**

At the top of `index.js`, add to the existing import block from `gmscreen.js` (create the import if absent):

```javascript
import { gmscreenRole, stripStandaloneBrackets } from "./gmscreen.js";
```

Then, near the bottom of `index.js` (just before the `jQuery(async () => {` bootstrap call), add:

```javascript
// Spike: log what the interceptor receives without modifying anything, to
// determine whether the chat array is a throwaway copy or the live chat.
globalThis.npcPovMemoryGenerateInterceptor = async function (chat, contextSize, abort, type) {
    try {
        const drafting = lastDraftCharacterId ?? getActiveCharacterId();
        console.log("[NPC POV Memory] interceptor fired", {
            type,
            length: Array.isArray(chat) ? chat.length : null,
            draftingCharacterId: drafting,
            firstIsLiveRef: Array.isArray(chat) && chat[0] === getContext().chat?.[0],
        });
    } catch (error) {
        console.error("[NPC POV Memory] interceptor spike error", error);
    }
};
```

- [ ] **Step 3: Verify in SillyTavern**

Reload SillyTavern (Ctrl+Shift+R), open the browser console (F12), and send one message in any chat. In the console:
- Confirm `interceptor fired` logs once per generation (and once per member in a group).
- Read `firstIsLiveRef`. If `false`, the interceptor received cloned message objects — in-place edits would be discarded, and slot replacement is safe. If `true`, the objects are shared with the live chat and you must clone before editing.

- [ ] **Step 4: Record the finding**

Create `C:\npc-pov-memory\docs\superpowers\plans\notes-interceptor-safety.md` capturing: whether `chat` is a copy, whether `chat[i]` objects are shared (`firstIsLiveRef`), and the resulting rule. Regardless of the outcome, Task 4 uses **clone-on-write** (never assign to `message.mes`), so this note just confirms it is sufficient and whether splicing slots is safe.

- [ ] **Step 5: Commit**

```bash
git add manifest.json index.js docs/superpowers/plans/notes-interceptor-safety.md
git commit -m "chore: add generate_interceptor spike and record chat mutation safety"
```

---

### Task 4: Wire the interceptor to filter for non-GM NPCs

**Files:**
- Modify: `C:\npc-pov-memory\index.js` (replace the spike interceptor)

**Interfaces:**
- Consumes: `gmscreenRole` and `stripStandaloneBrackets` from `gmscreen.js`; `lastDraftCharacterId`, `getActiveCharacterId`, `getCharacterById`, `getContext`, `getSettings` from `index.js`.
- Produces: the production `globalThis.npcPovMemoryGenerateInterceptor` that clones-and-filters transcript messages for cards whose effective role is non-GM.

- [ ] **Step 1: Add a helper that decides whether to filter a card**

In `index.js`, directly above the interceptor assignment, add:

```javascript
// Decide whether this card's outgoing transcript should have bracket tags
// stripped. Only an explicit "npc" strips; "gm"/unset never strips, unless
// the global "treat unmarked as NPC" opt-out is on (then unset also strips).
function shouldFilterForCharacter(character) {
    const settings = getSettings();
    if (!settings.enabled || !settings.filterMetaForNpcs) {
        return false;
    }
    const role = gmscreenRole(character);
    if (role === "npc") {
        return true;
    }
    if (role === "gm") {
        return false;
    }
    return Boolean(settings.treatUnmarkedAsNpc);
}
```

- [ ] **Step 2: Replace the spike interceptor with the production filter**

Replace the `globalThis.npcPovMemoryGenerateInterceptor = …` block from Task 3 with:

```javascript
globalThis.npcPovMemoryGenerateInterceptor = async function (chat, contextSize, abort, type) {
    try {
        if (!Array.isArray(chat) || !chat.length) {
            return;
        }
        const context = getContext();
        const draftingId = lastDraftCharacterId ?? getActiveCharacterId(context);
        const character = getCharacterById(draftingId, context);
        if (!shouldFilterForCharacter(character)) {
            return;
        }

        // Walk backwards so slot removal does not shift not-yet-visited indices.
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            const original = String(message?.mes ?? "");
            if (original.indexOf("[") === -1) {
                continue;
            }
            const filtered = stripStandaloneBrackets(original);
            if (filtered === original) {
                continue;
            }
            if (filtered.trim() === "") {
                chat.splice(i, 1); // message was only meta tags
            } else {
                chat[i] = Object.assign({}, message, { mes: filtered }); // clone-on-write
            }
        }
    } catch (error) {
        console.error("[NPC POV Memory] interceptor filter error", error);
    }
};
```

- [ ] **Step 3: Verify in SillyTavern (marked NPC)**

Reload ST. On a card with `data.extensions.gmscreen_role` set to `"npc"` (set it by hand in the card JSON for this test, or via Task 6's UI once built), start a chat that already contains messages with `[ITEM GAINED: …]` / `[System: …]` tags. Send a message. Confirm via the console/network that the model prompt no longer contains those bracket spans, and that the visible chat messages in the UI **still show the tags** (saved chat untouched).

- [ ] **Step 4: Verify GM/unset is untouched**

Repeat on a card with `gmscreen_role: "gm"` and on a card with no flag: the prompt must still contain the tags. Confirm the on-screen chat is unchanged in every case.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: strip bracket meta tags from transcript for non-GM NPC turns"
```

---

### Task 5: Add the two settings and their controls

**Files:**
- Modify: `C:\npc-pov-memory\index.js` (`DEFAULT_SETTINGS`, settings-panel HTML, `bindSettingsPanel`, `refreshSettingsPanel`)

**Interfaces:**
- Consumes: existing `getSettings`, `saveSettings`, `clampNumber` patterns.
- Produces: `settings.filterMetaForNpcs` (default `true`) and `settings.treatUnmarkedAsNpc` (default `false`), each with a checkbox.

- [ ] **Step 1: Add defaults**

In `DEFAULT_SETTINGS` (index.js ~line 21), add two keys after `includeGoals: true,`:

```javascript
    filterMetaForNpcs: true,
    treatUnmarkedAsNpc: false,
```

- [ ] **Step 2: Add the checkboxes to the panel HTML**

In `createSettingsPanel`, after the `npc-pov-memory-include-goals` label block, insert:

```javascript
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-filter-meta" type="checkbox">
                            <span>Strip GM/meta bracket tags for non-GM NPCs</span>
                        </label>
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-treat-unmarked" type="checkbox">
                            <span>Treat unmarked cards as NPCs (strip by default)</span>
                        </label>
```

- [ ] **Step 3: Bind the checkboxes**

In `bindSettingsPanel`, add:

```javascript
    $("#npc-pov-memory-filter-meta").on("change", function () {
        getSettings().filterMetaForNpcs = Boolean($(this).prop("checked"));
        saveSettings();
    });

    $("#npc-pov-memory-treat-unmarked").on("change", function () {
        getSettings().treatUnmarkedAsNpc = Boolean($(this).prop("checked"));
        saveSettings();
    });
```

- [ ] **Step 4: Reflect them in `refreshSettingsPanel`**

In `refreshSettingsPanel`, next to the other `.prop("checked", …)` lines, add:

```javascript
    $("#npc-pov-memory-filter-meta").prop("checked", settings.filterMetaForNpcs);
    $("#npc-pov-memory-treat-unmarked").prop("checked", settings.treatUnmarkedAsNpc);
```

- [ ] **Step 5: Verify in SillyTavern**

Reload ST, open the extension settings drawer. Toggle each checkbox, reload, and confirm the state persists. With "Strip GM/meta…" off, confirm a marked-`npc` card's prompt keeps its tags again.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat: add filter master toggle and treat-unmarked-as-NPC setting"
```

---

### Task 6: Add the role authoring control (three-state select)

**Files:**
- Modify: `C:\npc-pov-memory\index.js` (settings-panel HTML, `bindSettingsPanel`, `refreshSettingsPanel`, a new writer function)

**Interfaces:**
- Consumes: existing `getSettingsCharacterId`, `getCharacterById`, `getContext`, `writeExtensionField`.
- Produces: a `<select id="npc-pov-memory-role">` with options Default / GM / NPC that writes `data.extensions.gmscreen_role` for the currently selected NPC; "Default" clears the field back to unset.

- [ ] **Step 1: Add the select to the panel HTML**

In `createSettingsPanel`, inside `npc-pov-memory-character-picker` (right after the NPC `<select>` label), add a sibling block:

```javascript
                        <div class="npc-pov-memory-role-picker">
                            <label>
                                <span>Card role (gmscreen)</span>
                                <select id="npc-pov-memory-role" class="text_pole">
                                    <option value="">Default (unset)</option>
                                    <option value="gm">GM / narrator</option>
                                    <option value="npc">NPC</option>
                                </select>
                            </label>
                        </div>
```

- [ ] **Step 2: Add a writer that respects the three states**

Add this function near `savePrivateFieldsForCurrent`:

```javascript
async function setGmscreenRoleForCurrent(value) {
    const context = getContext();
    const characterId = getSettingsCharacterId(context);
    const character = getCharacterById(characterId, context);
    if (!character) {
        toastr.warning("No NPC is currently selected.");
        return;
    }
    // "gm"/"npc" persist an explicit value; anything else clears back to unset.
    const roleValue = value === "gm" || value === "npc" ? value : undefined;
    await context.writeExtensionField(characterId, "gmscreen_role", roleValue);
    refreshSettingsPanel();
    toastr.success(
        roleValue
            ? `Set ${character.name} role to ${roleValue.toUpperCase()}.`
            : `Cleared ${character.name} gmscreen role.`,
    );
}
```

- [ ] **Step 3: Bind the select**

In `bindSettingsPanel`, add:

```javascript
    $("#npc-pov-memory-role").on("change", async function () {
        await setGmscreenRoleForCurrent(String($(this).val() || ""));
    });
```

- [ ] **Step 4: Reflect the current card's value in `refreshSettingsPanel`**

Inside `refreshSettingsPanel`, after `const character = getCharacterById(characterId, context);` is available and a character exists, set the select from the raw field (not from `gmscreenRole`, so a malformed legacy value still shows as Default):

```javascript
    const rawRole = character?.data?.extensions?.gmscreen_role;
    $("#npc-pov-memory-role").val(rawRole === "gm" || rawRole === "npc" ? rawRole : "");
```

Place this alongside the other per-character reads; in the early-return "no character" branch, also reset it: `$("#npc-pov-memory-role").val("");`.

- [ ] **Step 5: Verify in SillyTavern**

Reload ST. Pick an NPC in the extension panel, set its role to NPC, and confirm: (a) the card's exported JSON now has `data.extensions.gmscreen_role: "npc"`, (b) that card's turn strips tags (Task 4), (c) choosing "Default (unset)" removes the field again and stripping stops. Confirm switching the NPC picker updates the select to that card's own value.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat: add three-state gmscreen role picker to settings panel"
```

---

### Task 7: Seed the sample GM card and document the contract

**Files:**
- Modify: `C:\npc-pov-memory\sample-characters\dampener-block-h-gm.dampener-block-h.json`
- Modify: `C:\npc-pov-memory\README.md` (or create if absent)

**Interfaces:** none (data + docs).

- [ ] **Step 1: Seed the GM sample card**

In `sample-characters\dampener-block-h-gm.dampener-block-h.json`, add `gmscreen_role` inside `data.extensions`, as a sibling of `npcPovMemory` and `depth_prompt`:

```json
      "gmscreen_role": "gm",
```

(Explicitly marking GM cards protects them if a user later enables "Treat unmarked cards as NPCs".)

- [ ] **Step 2: Document the shared contract in the README**

Add a section to `README.md`:

```markdown
## gmscreen shared card contract

This extension is part of the **gmscreen** suite. Cards can carry a neutral,
extension-agnostic role flag:

- Field: `data.extensions.gmscreen_role`
- Values: `"gm"`, `"npc"`, or absent (unset)
- Absent/`"gm"` behave identically here (nothing is stripped). Only `"npc"`
  causes GM/meta bracket tags to be removed from that card's turn.

The same field is read by the skill-check extension, which suppresses its
character sheet and GM instructions for `"npc"` cards. Either extension works
standalone; they interoperate only by reading this one shared field. The flag
is never written automatically — set it via the Card role control in the
extension settings panel.
```

- [ ] **Step 3: Verify**

Run: `node --test`
Expected: PASS (docs/data changes don't break tests).
Load the seeded GM card in SillyTavern and confirm the role picker shows "GM / narrator".

- [ ] **Step 4: Commit**

```bash
git add sample-characters/dampener-block-h-gm.dampener-block-h.json README.md
git commit -m "docs: seed gmscreen_role on GM sample card and document the contract"
```

---

## Self-Review

- **Spec coverage:** interceptor + flag (Tasks 3–4), the `gmscreen_role` contract and never-default rule (Global Constraints, Tasks 4/6), unset = don't strip with an opt-out (Task 4 `shouldFilterForCharacter` + Task 5 toggle), three-state UI that can't flip a card by viewing it (Task 6, "Default" clears), clone-not-mutate safety (Task 3 spike + Task 4 clone-on-write), sample seeding + docs (Task 7). Covered.
- **Placeholder scan:** every code step contains complete code; verification steps name exact console fields and expected prompt/UI states. No TBDs.
- **Type consistency:** `gmscreenRole` returns `"gm" | "npc" | null` and is used only for equality checks; `stripStandaloneBrackets` returns a string (or passes non-strings through); settings keys `filterMetaForNpcs` / `treatUnmarkedAsNpc` are used identically in defaults, bind, refresh, and `shouldFilterForCharacter`; the DOM id `npc-pov-memory-role` is consistent across HTML, bind, and refresh.
