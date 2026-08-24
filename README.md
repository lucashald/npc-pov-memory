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
