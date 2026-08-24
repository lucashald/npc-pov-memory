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

## Image generation (ComfyUI)

Off by default, behind **Enable image generation**. This is the raw-narration
path, built to be compared against the tagger-based `async-comfy-images`
extension: run one or the other, not both on auto at once.

Instead of asking a tagger LLM to rewrite the message into a prompt, it sends
Krea 2 the narration itself, prefixed by the stored **appearance** of whoever is
in frame. Krea 2's encoder reads prose directly, and a tagger is no better at
inventing framing or lighting the transcript never stated, so the extra hop only
adds latency. What the tagger cannot supply is a description that stays stable
across renders and changes only when the story changes it.

How a prompt is built:

1. GM/meta bracket tags are stripped, then dialogue is removed. Messages using
   `*asterisks*` keep only those spans; otherwise quoted speech is dropped.
2. Subjects are the right-clicked character plus any other group member named in
   the remaining narration (exact whole-word match, which is why cards should use
   single first names).
3. Each subject's stored appearance is prepended. One subject uses its
   description verbatim; several are name-prefixed. Characters with no stored
   appearance contribute nothing.
4. An optional style suffix is appended.

Renders go through SillyTavern's ComfyUI proxy and a **single-flight queue**, so
overlapping requests wait rather than thrashing VRAM. Seeds default to one
stable value per character, so the same card renders consistently; switch to
random for variety. Finished images attach to the originating message, located
by identity so a queued render still lands correctly after you have kept
chatting.

Trigger it from **Generate image** in the portrait right-click menu, or turn on
**Auto-generate after each character message**.

### Tagger vs raw

Image prompts default to a **tagger**: the scene (dialogue stripped) plus each
in-frame character's stored appearance are sent to an LLM that returns one
photographic description, choosing a single moment, framing, and light. Raw
narration overwhelms Krea 2's encoder with beats and interiority; the tagger
distills it. Unlike a generic tagger, this one is *given* the appearance, so
identity stays fixed and only the moment varies.

Configure it under image settings:

- **Prompt from** — Tagger LLM (default) or Raw scene (appearance + narration,
  kept for comparison).
- **Tagger uses** — a separate OpenAI-compatible endpoint (non-blocking, keeps
  the chat responsive) or the main chat model (queues with chat).
- Endpoint URL, model, and max tokens.

If the tagger errors or returns nothing usable, it falls back to the raw scene
rather than skipping the image.

#### How the tagger and appearance combine

The tagger is given only the character names and the scene, and it describes
only the action: pose, expression, setting, light, and camera framing. It is
told NOT to describe fixed appearance. The stored appearance field is then
prepended to the tagger's output by the same composition step the raw path
uses. So appearance is injected by the extension, never produced by the
tagger, which means it cannot drift between renders no matter what the tagger
does with the scene.
