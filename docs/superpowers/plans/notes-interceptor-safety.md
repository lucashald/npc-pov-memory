# Interceptor mutation-safety spike — findings

This note records the result of the Task 3 spike: does the `chat` array a
`generate_interceptor` receives affect the **saved** chat when mutated? The
answer decides whether Task 4 can splice/replace slots safely.

## How to run the spike

1. Reload SillyTavern (Ctrl+Shift+R) so the updated `manifest.json` and
   `index.js` load.
2. Open the browser console (F12).
3. Send one message in any chat (and, separately, in a group chat, to see the
   per-member behavior).

## What to observe in the console

The spike logs `[NPC POV Memory] interceptor fired` with an object. For each
generation, capture:

- **Firing cadence** — does `interceptor fired` log exactly once per
  single-character generation, and once per drafted member in a group? (In a
  group, expect one log per active member as each is drafted.)
- **`type`** — the generation type string passed by SillyTavern.
- **`length`** — the length of the `chat` array the interceptor received.
- **`draftingCharacterId`** — the resolved drafting card id
  (`lastDraftCharacterId ?? getActiveCharacterId()`); confirm it matches the
  card actually about to speak (especially per-member in a group).
- **`firstIsLiveRef`** — whether `chat[0]` is the *same object reference* as
  `getContext().chat?.[0]` (the live, saved chat).

## How to interpret `firstIsLiveRef`

- If **`false`**: the interceptor received cloned message objects. In-place
  edits to `message.mes` would be discarded, and replacing array slots
  (`chat[i] = { ...message, mes: filtered }`) or splicing slots out is safe —
  the saved chat is untouched.
- If **`true`**: the message objects are shared with the live chat. Assigning
  to `message.mes` would corrupt the saved chat, so Task 4 **must** clone
  before editing (clone-on-write) and must confirm whether splicing the
  interceptor's `chat` array also mutates the live array.

Regardless of the outcome, Task 4 uses **clone-on-write** (never assign to
`message.mes` on a shared object). This note just confirms that pattern is
sufficient and whether splicing slots out of the received `chat` array is safe
without disturbing the saved chat.

## Finding

**FINDING:** _(pending — to be filled after running the spike in SillyTavern)_
