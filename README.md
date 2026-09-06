# NPC POV Memory

A SillyTavern extension that keeps character-card memory from an NPC's point of view, injects it into replies, and provides group speaker controls, history editing, and optional ComfyUI illustrations.

This README describes the current implementation. The extension manifest reports **0.6.12**; `package.json` still reports `0.1.0`. No minimum compatible SillyTavern version is declared or verified.

## Installation and first use

1. Install this repository through SillyTavern's extension installer: <https://github.com/lucashald/npc-pov-memory>.
2. Reload SillyTavern and open **Extensions → NPC POV Memory**.
3. Open a character or group chat. A portrait and **NPC tools** button appear above the message box. In groups, use the adjacent character selector to choose the card to manage.
4. Use your configured chat model. Memory updates and prompt injection are enabled by default.
5. To seed private state, fill in **Secrets and hidden knowledge** and **Private goals**, then click **Save private notes**. Enable **Track appearance** to expose its editor.
6. Click **Update selected NPC** to summarize new messages immediately, or let automatic updates run.

This is a browser extension loaded by SillyTavern, not a standalone Node application. There is no build or dependency-install step. It imports SillyTavern's generation, group, popup, reasoning, and media APIs directly. ComfyUI and a separate tagger server are optional; neither is needed for memory.

## How memory works

Each update asks the active chat model to revise these fields:

| Field | Scope |
| --- | --- |
| Autobiography | The NPC's accumulated experiences across chats and personas |
| Relationship | That NPC's history with the current user persona |
| Secrets | Hidden knowledge, suspicions, and things the NPC conceals |
| Goals | Active objectives, plans, and unresolved intentions |
| Appearance | Optional current physical description, clothing, and visible condition |

The updater receives existing memory and new non-system transcript messages. It is instructed to use only what the NPC witnessed, was told, or could infer. This is model guidance: the extension does not track physical presence or enforce who witnessed each message. Character-card descriptions are not explicitly included in the update prompt.

Automatic updates are considered after an AI character message renders, for the card identified as that message's speaker. **Update every** counts chat entries since that card's checkpoint, including user and other characters' entries; it does not mean that many replies by the selected NPC. Only one memory update runs at a time; overlapping attempts are skipped.

The update consumes unsummarized entries up to **Max messages**. Older backlog beyond that limit is skipped. **Update selected NPC** bypasses the interval but still uses the checkpoint and message cap; it does not rebuild all history. Empty or missing response fields preserve existing text, and complete fields may be recovered from truncated JSON.

| Setting | Default |
| --- | --- |
| Enable / automatic updates / inject memory | On |
| Update every | 8 chat entries |
| Max messages per update | 80 |
| Max words | About 450 per field, requested from the model |
| Response tokens | 2,500 |
| Inject secrets / goals | On |
| Track appearance / inject appearance | Off / off |
| Group speaker buttons | Off |

Autobiography and the current persona's relationship are included in injection by default. Secrets and goals have individual injection switches. Appearance injection requires both appearance switches. These notes are sent to the model with instructions to keep them private in the fiction; they are not a security boundary or encrypted storage.

### Storage and forgetting

Memory lives on the character card at `data.extensions.npcPovMemory` (store version 2). Autobiography, secrets, goals, and appearance are shared across that card's chats. Relationships are keyed by a lowercased, ASCII-normalized persona **name**, not a unique persona ID: names such as `Alex!` and `Alex` share a key, and names containing no ASCII letters or digits fall back to `user`.

Progress checkpoints are stored per chat. Extension settings live in `extension_settings["npc-pov-memory"]`.

- **Forget relationship** removes only the current persona's relationship entry.
- **Forget all** resets all extension memory on the selected card, including appearance and checkpoints.
- Forgetting does not delete the transcript, so later updates can learn those events again.
- The panel edits secrets, goals, and appearance directly; autobiography and relationship are displayed as summaries.
- Turning appearance tracking off preserves stored appearance. Image generation can still use that stored text.

Memory can travel with a card when its extension fields are retained. Review those fields before sharing cards. Debug logging currently prints memory model replies, image prompts, and appearance text to the browser console.

## Card roles and bracket filtering

**Card role (gmscreen)** writes `data.extensions.gmscreen_role`, a shared field other extensions can read. No companion extension is required, and roles are not assigned automatically.

With **Strip GM/meta bracket tags for non-GM NPCs** enabled (the default):

| Card role | Filter outgoing transcript and memory-update input? |
| --- | --- |
| NPC (`npc`) | Yes |
| GM / narrator (`gm`) | No |
| Default / unset | Only if **Treat unmarked cards as NPCs** is enabled; off by default |

The filter removes whole-line and trailing square-bracket spans, including tag-only messages. For example, `She nods. [GM: hidden clue]` becomes `She nods.`. Mid-sentence brackets and Markdown links remain. It uses position rather than tag names, so ordinary trailing bracketed prose is removed too.

Live filtering modifies the transcript supplied to generation, not saved chat history. It does not remove hidden information written in ordinary prose or already stored in memory. The history-strip menu action below is a separate, persistent operation.

## NPC tools in any chat

The portrait and **NPC tools** button above the message box both open the manager with a click, tap, or right-click. Both are keyboard-accessible buttons. It is visible in single-character chats and in groups with speaker buttons turned off. When **Show group speaker buttons** is on, one wrapping character list replaces the toolbar, with a **⋯** tools button beside each character. In groups, select a character beside the button; in a single-character chat, the current character is selected automatically. You can also use **Open NPC tools** in the extension settings.

The menu provides image generation, portrait selection, card roles, memory summaries and updates, forgetting memory, and history editing. Focus, membership, and bulk group roles appear only in group chats. The card-role selector in settings is also available for single-character chats. The toolbar hides when there is no active character or the current group is empty.

### Optional group speaker bar

Enable **Show group speaker buttons** in a group chat:

- **Click a portrait:** request one reply from that member.
- **Shift-click:** toggle focused speaker. Focus switches the group's activation strategy to Manual and arranges replies from that character after user messages.
- **Clear focus:** apply the strategy selected in **When focus clears**: Pooled order (default), Natural order, or Manual. This does not restore a remembered previous strategy.
- **Right-click:** open the NPC manager.

The manager supports setting individual or bulk roles, viewing and forgetting memory, adding/removing group members, generating an image, and choosing a new card portrait from chat images. Portrait changes affect the card everywhere and require confirmation. The image picker reads `extra.media[]` and legacy image fields.

Focus is held in memory, while the group's Manual strategy is saved. After reloading while focused, you may need to choose a speaker or change the group's strategy. The optional portrait row retains its right-click shortcut; each character also has a **⋯** button to open the manager without requiring a right-click. Full names wrap, and the list flows into additional rows rather than scrolling horizontally.

### History editing

**Rewrite history…** rewrites each selected message with a separate model call. Choose the last N chat entries or the entire chat, then filter to AI, user, or all non-system messages. N is applied before the speaker filter. Blank instructions ask the model to remove places where the AI speaks, acts, or thinks for the user persona. Empty rewritten results delete messages.

Clicking the progress toast cancels further work after the current call; completed rewrites are still applied. Individual failed calls are skipped. Text edits update `mes` and the active swipe, leaving alternate swipes untouched.

**Strip GM brackets from history** applies the positional bracket filter to the whole current chat, including user and system messages, regardless of card role. It deletes tag-only messages and saves the result after confirmation.

**Undo last bulk change** restores a whole-chat snapshot. Up to ten snapshots are kept in memory and lost on reload. Snapshots are scoped to their originating chat. Undo is blocked while a bulk operation runs or if the chat has changed since the operation, so it cannot overwrite another chat or discard newer messages, edits, or attachments. Export a chat before bulk editing it.

## Optional ComfyUI images

Both **Enable image generation (ComfyUI)** and automatic images default to off. To configure:

1. Run ComfyUI at an address reachable from the SillyTavern server. The default is `http://127.0.0.1:8188`.
2. Provide a ComfyUI API workflow in SillyTavern's user workflow storage (`comfyWorkflows`) and enter its filename. The configured default, `Krea2_Turbo.json`, is **not included in this repository**; supply it or select your own compatible workflow and install its required models/nodes.
3. Enable images and optionally seed each card's appearance through **Track appearance → Save private notes**.
4. Click **NPC tools → Generate image** in either chat type, or enable **Auto-generate after each character message**. Right-clicking a group speaker portrait remains an alternative shortcut.

Manual generation uses the latest non-user, non-system message as the scene, even if another character wrote it; the selected card is the primary subject. Automatic generation uses the triggering message and its speaker.

### Prompt construction

1. Remove square-bracket spans, Markdown links, and checkbox glyphs. This image-specific filter is broader than the NPC transcript filter.
2. Remove paired quoted speech, asterisk markers, and selected scene-marker emoji. Words inside asterisks are kept. Malformed straight quotes preserve the words rather than guessing which spans are dialogue. Skip messages with no remaining narration.
3. Select the primary subject plus group members whose full card names occur in the narration, using case-insensitive whole-word matching. Aliases, pronouns, and partial names are not resolved.
4. By default, a **Tagger LLM** receives the names and cleaned narration and produces one photographic description. Stored appearance is not included in the explicit tagger prompt. **Raw scene** skips this call. Failed or empty tagger output falls back to raw narration.
5. Prepend stored appearance descriptions and append the optional style suffix. Multiple nonempty descriptions receive name labels.

Appearance preservation is an instruction to the memory updater, and the tagger is instructed not to invent fixed features. Neither those instructions nor a stable seed guarantee consistent generated identity.

| Image setting | Default |
| --- | --- |
| Prompt from / Tagger uses | Tagger LLM / Main chat model |
| Tagger max tokens | 1,000 |
| Dimensions / steps | 832 × 1,216 / 8 |
| Seed | Stable hash of the character's avatar filename, falling back to name |
| Style suffix / custom tagger instructions | Empty / built-in instructions |

**Separate endpoint** sends a browser request directly to an OpenAI-compatible chat-completions URL. Set your own full URL and model: the prefilled URL is a developer-specific private address, not a bundled service. The endpoint needs to permit the browser request, including CORS where applicable. This client has no API-key/header setting. Main-model tagging uses SillyTavern's quiet generation and can contend with chat generation.

### Workflow contract and output

The extension loads a workflow through `/api/sd/comfy/workflow` and submits it through `/api/sd/comfy/generate`. It replaces these **quoted, whole-value placeholders** in workflow JSON:

```json
{
  "text": "%prompt%",
  "seed": "%seed%",
  "steps": "%steps%",
  "width": "%width%",
  "height": "%height%"
}
```

This is a placeholder example, not a complete workflow. `%negative_prompt%` is also supported and replaced with an empty string. Embedded tokens such as `"prefix %prompt%"` are not substituted. Unused settings have no effect if their placeholders are absent.

ComfyUI renders are serialized within this extension; tagger calls happen before the render queue. The queue does not coordinate with other extensions. Images are saved through SillyTavern and attached as `extra.media[]` gallery entries with the prompt as metadata. If the original message is no longer in the active chat when rendering finishes, the file is saved but not attached.

## Troubleshooting and limitations

- **Nothing new to summarize:** check that the extension is enabled, the selected card has new transcript entries, and another update is not running. Bracket-only entries may filter to nothing.
- **Incomplete memory:** increase Response tokens or reduce Max words. Partial JSON recovery preserves older values for unfinished fields; it does not retry the missing fields.
- **Images fail:** verify the workflow filename, required ComfyUI models/nodes, server URL, and browser console. A failed tagger falls back to raw text; a failed render does not.
- **Disabling memory:** the main enable switch gates memory and NPC filtering. Images and group controls have separate switches and can remain active.
- **Edited history:** stored memory and index checkpoints are not rebuilt when messages are edited, deleted, swiped, or rewritten. For substantial changes, review/reset affected memory; subsequent summarization still uses the message cap.
- **Concurrent edits:** rewrites discard their results if the chat, message identities, text, or swipes change during generation. Memory updates allow new messages to arrive but checkpoint only the original transcript; changes to the source, persona, card, or stored notes discard the pending update. Bracket stripping also checks for changes while its confirmation dialog is open. Discarded memory updates can be retried with **Update selected NPC**.

## Development

Run the dependency-free helper tests with Node.js:

```sh
node --test
```

The current suite has 117 tests covering `gmscreen.js`, `imageprompt.js`, and the actual memory/bulk-operation orchestration with mocked SillyTavern services. Regression tests exercise cross-chat Undo, concurrent edits and swipes, checkpoint boundaries, confirmation-time chat changes, and tool availability in single-character/group chats. Live SillyTavern events, server persistence, and ComfyUI/LLM transport still need integration testing.

| File | Responsibility |
| --- | --- |
| `index.js` | Settings, card memory, injection, events, speaker bar, manager, image orchestration |
| `gmscreen.js` | Roles, bracket filtering, JSON recovery, rewrite and image-collection helpers |
| `imageprompt.js` | Scene cleanup, subjects, appearance composition, seeds, tagger prompts |
| `tagger.js` | Main-model and direct-endpoint tagger clients |
| `comfy.js` | Workflow substitution and serialized ComfyUI rendering |
| `style.css` | Settings, group bar, and manager styling |
| `sample-characters/` | Example character-card JSON files |

Existing design notes may describe earlier behavior. The implementation and tests are the basis for this README; a live compatibility test is still needed for any particular SillyTavern build.
