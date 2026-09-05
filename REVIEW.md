# Code review and fixes

The three findings from the initial review are fixed in `index.js`. Validation: **114 tests passed**, including 20 new orchestration regression tests. No live SillyTavern instance or ComfyUI/LLM endpoint was exercised.

## 1. Fixed: bulk Undo could overwrite a different chat

Previously, a global stack held only message arrays and Undo restored the latest snapshot into whichever chat was open.

Snapshots now carry their originating chat key and the state immediately after the operation. Undo selects only the current chat's latest snapshot and refuses restoration if newer changes would be lost. It is also blocked during a bulk operation. Snapshots are created when edits are applied, so aborted rewrites do not add misleading Undo entries. The ten-snapshot cap remains shared across chats, and snapshots remain session-only.

Tests cover switching chats and returning, refusing newer messages/edits, consecutive Undo, restoring deleted messages and swipes, and blocking Undo during generation.

## 2. Fixed: memory updates could mark unseen messages as summarized

Previously, the update wrote its checkpoint using the live chat length after awaiting the model. Messages arriving during that wait were marked as processed despite never reaching the updater.

The checkpoint now uses the captured transcript boundary. New appended messages remain eligible for the next update. Before saving, the extension verifies the chat key/array, original message identities and text/swipes, card identity, persona key, and stored memory. Conflicting results are discarded. The update works on a deep copy so rejected results cannot mutate existing relationships or notes.

Tests cover appended messages and their inclusion in the next update, source edits/swipes, chat/card changes, manual note changes, and preservation of stored relationships after rejection.

## 3. Fixed: rewrite conflict detection missed edits and swipes

Previously, the final guard compared only array identity and length, allowing pending output to replace newly edited text or a different active swipe.

Rewrites now capture message identities and text/swipe state before generation and check them between calls and before applying edits. Any conflict aborts application of the batch. Stable input still updates the active swipe and preserves alternatives. Bracket stripping uses the same check across its confirmation dialog, and refuses to run concurrently with other bulk operations.

Tests cover text/swipe edits, same-length message replacement, appended messages, chat switches (including a reused array), successful rewriting and Undo, and confirmation-time chat changes.

## Remaining limits

These are client-side consistency checks, not server transactions. Live integration and save-failure handling still need validation. Undo conservatively rejects any change to the serialized chat since the operation, including attachment or metadata changes. Editing or deleting history still does not rebuild previously stored memory automatically.
