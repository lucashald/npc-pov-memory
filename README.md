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

## NPC manager (context menu)

Right-click any portrait in the group speaker bar (enable "Show group
speaker buttons" in the extension settings) for the NPC manager menu:

- **Focus / clear focused speaker** — same as shift-click.
- **Set portrait from chat image** — pick any image that has appeared in
  the current chat (`extra.image` / `extra.image_swipes`); replaces the
  character card's portrait everywhere after a confirm.
- **Card role** — set `gmscreen_role` (Default / GM / NPC) per card, and
  **Bulk roles (group)** to mark everyone (or everyone except the
  right-clicked card) as NPC, or clear all roles.
- **View memory summary** — popup with autobiography, relationship,
  secrets, and goals.
- **Forget memory** — relationship-only or everything, confirmed.
- **Remove from group** / **Add character to group** — edit the current
  group's members without the native panel; the add submenu has a filter.
- **Rewrite history…** — per-message LLM rewrite over the last N messages
  or the whole chat, filtered to AI/user/all messages. Leaving the
  instruction empty removes places where the AI spoke or acted for your
  persona. A snapshot is taken first; progress toast click cancels.
- **Strip GM brackets from history** — persists what the NPC interceptor
  does live: removes `[bracket]` meta tags, deleting tag-only messages.
- **Undo last bulk change** — reverts the most recent rewrite/strip
  (snapshot stack of 10).

Bulk operations edit both `mes` and the active swipe, save the chat, and
refuse to apply if the chat changed while they were running.

## Appearance field

Off by default. Enable **Track appearance** in the extension settings to add a
fifth stored field alongside autobiography, relationship, secrets, and goals.

- **Blank until you write it.** The updater is explicitly told never to invent
  appearance details, so an undescribed character stays empty rather than
  acquiring a hallucinated face that then becomes canon.
- **Edit it by hand** in the settings panel, next to Secrets and Goals, and save
  with the same button. Right-click a portrait and choose *View memory summary*
  to read it.
- **Maintained like the other fields.** Once populated, the updater revises it
  from the transcript, preserving permanent features (species, build, face, eye
  colour, permanent marks) unless the story explicitly changes them, and
  rewording only what actually changed (clothing, injuries, dirt, exhaustion).
- **Not injected by default.** Recent appearance changes are already visible in
  the chat history, so injecting it usually wastes tokens. Turn on **Inject
  appearance into prompts** when a change needs to survive falling out of
  context.

The field is written as plain visual prose so an image generator can consume it
directly. Turning tracking off leaves stored text untouched and removes
appearance from the update call entirely.
