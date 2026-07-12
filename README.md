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
