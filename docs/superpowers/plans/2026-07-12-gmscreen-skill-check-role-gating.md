# Skill Check — gmscreen Role Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Skill Check extension from injecting its character sheet and GM instructions into the context of any card explicitly marked as a non-GM NPC, so only the game-master card authors game state (DCs, inventory) and in-world NPCs neither see the player's sheet nor emit protocol tags.

**Architecture:** Skill Check's single injection function becomes per-target aware. It resolves which card the current injection is for — the drafting member in a group (tracked via `GROUP_MEMBER_DRAFTED`) or the active character in a solo chat — and reads the neutral shared `data.extensions.gmscreen_role` flag. When that card is `"npc"`, it registers an empty extension prompt instead of the sheet+instructions blob. The flag read lives in a dependency-free `gmscreen.js` module unit-tested under Node; the ST wiring is verified manually. Skill Check works fully standalone: it both authors and reads the flag without requiring the NPC POV Memory extension.

**Tech Stack:** Vanilla ES-module JavaScript, jQuery (bundled by SillyTavern), SillyTavern extension context API (`getContext`, `setExtensionPrompt`, `writeExtensionField`, `eventSource`/`eventTypes`), Node built-in test runner (`node --test`).

**Target repository:** `C:\skill-check` (the production repo — the copy under `npc-pov-memory\references\skill-check` is a shallow reference and must not be edited). Run all commands from `C:\skill-check`.

## Global Constraints

- **Shared card contract (the `gmscreen` namespace):** the flag lives at `data.extensions.gmscreen_role`, a **flat** string field with values `"gm"` or `"npc"`, or **absent** (unset). Verbatim rule: only `gmscreen_role === "npc"` suppresses injection; `"gm"`, absent, or any other value injects normally (today's behavior).
- **Standalone requirement:** none of these changes may hard-depend on the NPC POV Memory extension. Read the flag defensively so that an unset flag means "inject everything," which is exactly the current behavior.
- **Never persist a default for `gmscreen_role`.** It is written only by explicit user action in the role control; "Default" clears it back to unset.
- **Node test files** use only `node:test` + `node:assert/strict` — no third-party test dependencies.
- Follow the existing code style in `index.js`: 4-space indent, single-quoted strings, `const`/`let`.

---

## File Structure

- `gmscreen.js` (new) — pure `gmscreenRole(character)` helper (Skill Check's own copy of the shared-contract reader; the two repos cannot share a file). No SillyTavern imports.
- `gmscreen.test.js` (new) — Node unit tests.
- `package.json` (new) — `{"type":"module","private":true}` for `node --test`; harmless to SillyTavern.
- `index.js` (modify) — import `gmscreenRole`; add a drafting-target resolver + `lastDraftedCharacterId`; gate `updateCharacterSheetPrompt`; hook `GROUP_MEMBER_DRAFTED`; add a role control to the character-sheet popup.
- `README.md` (modify) — document the `gmscreen` contract.

---

### Task 1: Pure `gmscreenRole` resolver

**Files:**
- Create: `C:\skill-check\package.json`
- Create: `C:\skill-check\gmscreen.js`
- Test: `C:\skill-check\gmscreen.test.js`

**Interfaces:**
- Produces: `export function gmscreenRole(character): "gm" | "npc" | null` — returns `"gm"`/`"npc"` only for those exact `data.extensions.gmscreen_role` values, else `null` (absent, malformed, or missing character).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "skill-check",
  "version": "1.0.0",
  "private": true,
  "type": "module"
}
```

- [ ] **Step 2: Write the failing test**

Create `C:\skill-check\gmscreen.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { gmscreenRole } from "./gmscreen.js";

const card = (role) => ({ data: { extensions: role === undefined ? {} : { gmscreen_role: role } } });

test("reads an explicit npc", () => {
    assert.equal(gmscreenRole(card("npc")), "npc");
});

test("reads an explicit gm", () => {
    assert.equal(gmscreenRole(card("gm")), "gm");
});

test("returns null when unset", () => {
    assert.equal(gmscreenRole(card(undefined)), null);
});

test("returns null for a malformed value", () => {
    assert.equal(gmscreenRole(card("dungeonmaster")), null);
});

test("tolerates a missing character", () => {
    assert.equal(gmscreenRole(null), null);
    assert.equal(gmscreenRole(undefined), null);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test`
Expected: FAIL — `Cannot find module './gmscreen.js'`.

- [ ] **Step 4: Implement**

Create `C:\skill-check\gmscreen.js`:

```javascript
// Reader for the neutral, extension-agnostic gmscreen card role flag.
// No SillyTavern imports so it is Node-testable and browser-importable.
export function gmscreenRole(character) {
    const role = character?.data?.extensions?.gmscreen_role;
    return role === "gm" || role === "npc" ? role : null;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add package.json gmscreen.js gmscreen.test.js
git commit -m "feat: add gmscreenRole shared-contract reader"
```

---

### Task 2: Gate injection on the drafting target's role

**Files:**
- Modify: `C:\skill-check\index.js` (imports; new resolver; `updateCharacterSheetPrompt`)

**Interfaces:**
- Consumes: `gmscreenRole` from `gmscreen.js`; existing `getContext`, `extensionName`, `buildExtensionPrompt`.
- Produces: module-level `let lastDraftedCharacterId`; `resolveInjectionTargetCharacter()`; a gated `updateCharacterSheetPrompt()`.

- [ ] **Step 1: Import the reader**

At the top of `index.js`, after the existing `import { extension_settings } …` lines, add:

```javascript
import { gmscreenRole } from "./gmscreen.js";
```

- [ ] **Step 2: Add the drafting-target tracker and resolver**

Near the top of `index.js` (after `const extensionName = "skill-check";`), add:

```javascript
// Which group member is currently drafting a reply (set on GROUP_MEMBER_DRAFTED,
// cleared when the group turn ends). Null in solo chats.
let lastDraftedCharacterId = null;

// The card the current injection is for: the drafting member in a group, or
// the active character in a solo chat. Null if it cannot be determined.
function resolveInjectionTargetCharacter() {
    const context = getContext();
    if (!context) return null;
    if (context.groupId) {
        return Number.isInteger(lastDraftedCharacterId)
            ? (context.characters?.[lastDraftedCharacterId] || null)
            : null;
    }
    const id = Number(context.characterId);
    return Number.isInteger(id) ? (context.characters?.[id] || null) : null;
}
```

- [ ] **Step 3: Gate `updateCharacterSheetPrompt`**

In `updateCharacterSheetPrompt()`, immediately inside the `if (context && typeof context.setExtensionPrompt === 'function') {` branch and **before** `const promptText = buildExtensionPrompt();`, add:

```javascript
        // Suppress all Skill Check injection for cards explicitly marked as
        // non-GM NPCs. "gm"/unset fall through to normal injection.
        if (gmscreenRole(resolveInjectionTargetCharacter()) === 'npc') {
            context.setExtensionPrompt(extensionName, '', 2, 0);
            console.log('[Skill Check] Suppressed injection for non-GM NPC card');
            return;
        }
```

- [ ] **Step 4: Verify in SillyTavern (solo)**

Reload ST (Ctrl+Shift+R). Open a **solo** chat with a character whose card JSON has `data.extensions.gmscreen_role: "npc"` (set by hand for this test). Send a message and inspect the outgoing prompt (network tab or a prompt-dump): the `---CHARACTER SHEET---` and `---GAME MASTER INSTRUCTIONS---` blocks must be absent. Then change the flag to `"gm"` (or remove it) and confirm both blocks return.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: suppress sheet and GM instructions for non-GM NPC cards"
```

---

### Task 3: Re-register injection per drafted group member

**Files:**
- Modify: `C:\skill-check\index.js` (`setupMessageTagProcessing`, or a small dedicated setup call in init)

**Interfaces:**
- Consumes: `context.eventSource`, `context.eventTypes` (`GROUP_MEMBER_DRAFTED`, `GROUP_WRAPPER_FINISHED`), `updateCharacterSheetPrompt`, `lastDraftedCharacterId`.
- Produces: per-member re-registration so each group member's generation sees the right injection for its own card.

- [ ] **Step 1: Hook the group-draft events**

Inside `setupMessageTagProcessing`, in the `if (source) {` block (right after the existing swipe/edit `source.on(...)` calls), add:

```javascript
            // Per-member injection gating: when a group member is drafted, the
            // relevant card changes, so recompute the injection for that card
            // before its generation runs.
            try {
                source.on(types?.GROUP_MEMBER_DRAFTED || 'group_member_drafted', (charId) => {
                    const id = Number(charId);
                    lastDraftedCharacterId = Number.isInteger(id) ? id : null;
                    updateCharacterSheetPrompt();
                });
                source.on(types?.GROUP_WRAPPER_FINISHED || 'group_wrapper_finished', () => {
                    lastDraftedCharacterId = null;
                    updateCharacterSheetPrompt();
                });
            } catch (e) {
                console.warn('[Skill Check] Could not hook group draft events:', e);
            }
```

- [ ] **Step 2: Verify in SillyTavern (group)**

Reload ST. Open a **group** chat containing at least one card marked `gmscreen_role: "npc"` and one GM card marked `"gm"` (or unset). Trigger replies from each member and inspect the outgoing prompts: the NPC member's prompt has no sheet/GM-instruction blocks; the GM/unset member's prompt has them. Confirm the console logs `Suppressed injection for non-GM NPC card` only on the NPC member's turn.

- [ ] **Step 3: Verify no leakage back to solo**

Return to a solo chat with an unset card and send a message; confirm the blocks inject normally (i.e., `lastDraftedCharacterId` reset did not leave stale suppression).

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: recompute injection per drafted group member"
```

---

### Task 4: Add the standalone role authoring control

**Files:**
- Modify: `C:\skill-check\index.js` (`openCharacterSheet` popup HTML + its handler-binding block)

**Interfaces:**
- Consumes: `getContext`, `context.writeExtensionField`, `resolveInjectionTargetCharacter` is not used here (authoring targets the active solo character explicitly).
- Produces: a three-state `<select>` in the character-sheet popup that writes `data.extensions.gmscreen_role` for the active character; "Default" clears it. Shown only in solo chats.

- [ ] **Step 1: Add the section to the popup HTML**

In `openCharacterSheet`, inside the popup markup, add a new section immediately after the closing `</div>` of the `Difficulty` section (the section that contains `#skill-check-use-llm-dc`):

```javascript
                    <div class="skill-check-popup-section">
                        <h4>Card role (gmscreen)</h4>
                        <small>Marking a card as NPC hides your character sheet and GM instructions from that card's replies. GM/Default cards are unaffected.</small>
                        <div id="skill-check-role-solo">
                            <select id="skill-check-gmscreen-role" class="text_pole">
                                <option value="">Default (unset)</option>
                                <option value="gm">GM / narrator</option>
                                <option value="npc">NPC</option>
                            </select>
                        </div>
                        <small id="skill-check-role-group-hint" style="display:none;">Open this character's own solo chat to set its role, or use a gmscreen extension that provides a per-member picker. The flag is shared.</small>
                    </div>
```

- [ ] **Step 2: Initialize the control when the popup opens**

In `openCharacterSheet`, after the popup element is appended to the DOM (where other controls are initialized), add:

```javascript
    (function initGmscreenRole() {
        const context = getContext();
        const inGroup = Boolean(context.groupId);
        const id = Number(context.characterId);
        const character = !inGroup && Number.isInteger(id) ? context.characters?.[id] : null;

        $('#skill-check-role-solo').toggle(!inGroup && !!character);
        $('#skill-check-role-group-hint').toggle(inGroup);

        if (character) {
            const raw = character.data?.extensions?.gmscreen_role;
            $('#skill-check-gmscreen-role').val(raw === 'gm' || raw === 'npc' ? raw : '');
        }

        $('#skill-check-gmscreen-role').off('change').on('change', async function () {
            const value = String($(this).val() || '');
            const roleValue = value === 'gm' || value === 'npc' ? value : undefined;
            const ctx = getContext();
            const chid = Number(ctx.characterId);
            if (!Number.isInteger(chid) || !ctx.characters?.[chid]) {
                return;
            }
            await ctx.writeExtensionField(chid, 'gmscreen_role', roleValue);
            updateCharacterSheetPrompt();
            console.log('[Skill Check] gmscreen_role set to', roleValue ?? '(unset)');
        });
    })();
```

- [ ] **Step 3: Verify in SillyTavern**

Reload ST. In a solo chat, open the character sheet popup (scroll icon). Confirm the "Card role (gmscreen)" select appears. Set it to NPC; confirm the exported card JSON gains `data.extensions.gmscreen_role: "npc"` and that the next reply's prompt drops the sheet/GM blocks. Set it back to Default; confirm the field is removed and injection returns. Open the popup in a group chat and confirm the select is hidden and the group hint shows.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: add standalone gmscreen role control to character sheet popup"
```

---

### Task 5: Document the shared contract

**Files:**
- Modify: `C:\skill-check\README.md`

- [ ] **Step 1: Add a contract section**

Add to `README.md`:

```markdown
## gmscreen shared card contract

Skill Check is part of the **gmscreen** suite. Cards may carry a neutral role flag:

- Field: `data.extensions.gmscreen_role`
- Values: `"gm"`, `"npc"`, or absent (unset)
- `"npc"` → Skill Check injects neither the character sheet nor the GM
  instructions for that card's replies (so it won't emit `[SKILL DC]` /
  `[ITEM …]` tags or read the player's sheet).
- `"gm"` or absent → normal injection (unchanged behavior).

Set the flag from the **Card role (gmscreen)** control in the character sheet
popup (solo chats). The same field is read by the NPC POV Memory extension,
which additionally strips existing bracket tags from `"npc"` cards' transcripts.
Each extension works standalone; they share only this one field. The flag is
never written automatically.
```

- [ ] **Step 2: Verify**

Run: `node --test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document gmscreen shared card contract"
```

---

## Self-Review

- **Spec coverage:** suppress sheet + GM instructions for `"npc"` cards (Task 2); per-member gating in groups (Task 3); standalone authoring UI with three-state Default/GM/NPC and group hint (Task 4); the never-default rule ("Default" clears via `undefined`, Task 4); works without NPC POV Memory (defensive `gmscreenRole`, unset = inject, Task 1/2); docs (Task 5). Covered.
- **Placeholder scan:** every code step is complete; verification steps name the exact prompt blocks (`---CHARACTER SHEET---`, `---GAME MASTER INSTRUCTIONS---`) and UI states to check. No TBDs.
- **Type consistency:** `gmscreenRole` → `"gm" | "npc" | null`, used only in equality checks; `lastDraftedCharacterId` set as a number or null and read the same way in the resolver; DOM ids `skill-check-gmscreen-role` / `skill-check-role-solo` / `skill-check-role-group-hint` are consistent between the markup and the init block; `writeExtensionField(chid, 'gmscreen_role', value)` matches the field name read everywhere else.
