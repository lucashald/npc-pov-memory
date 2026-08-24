import { extension_settings, getContext } from "../../../extensions.js";
import {
    Generate,
    appendMediaToMessage,
    default_avatar,
    extension_prompt_roles,
    extension_prompt_types,
    getRequestHeaders,
    getThumbnailUrl,
    updateMessageBlock,
} from "../../../../script.js";
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE } from "../../../constants.js";
import { saveBase64AsFile } from "../../../utils.js";
import { humanizedDateTime } from "../../../RossAscends-mods.js";
import { enqueueRender, getQueueDepth, renderImage } from "./comfy.js";
import {
    composeImagePrompt,
    findMentionedCharacters,
    stableSeedFrom,
    stripDialogue,
} from "./imageprompt.js";
import { removeReasoningFromString } from "../../../reasoning.js";
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from "../../../popup.js";
import {
    editGroup,
    group_activation_strategy,
    groups,
    selected_group,
} from "../../../group-chats.js";
import {
    gmscreenRole,
    stripStandaloneBrackets,
    extractFirstJsonObject,
    resolveRewriteScope,
    buildRewritePrompt,
    cleanRewriteOutput,
    collectChatImages,
    planBracketStrip,
} from "./gmscreen.js";

const EXTENSION_KEY = "npc-pov-memory";
const STORAGE_KEY = "npcPovMemory";
const PROMPT_KEY = "npc-pov-memory";

const DEFAULT_SETTINGS = {
    enabled: true,
    autoUpdate: true,
    injectMemory: true,
    includeAutobiography: true,
    includeRelationship: true,
    includeSecrets: true,
    includeGoals: true,
    // Appearance is opt-in: when off it is neither maintained nor injected,
    // and the update call does not spend tokens on it.
    trackAppearance: false,
    includeAppearance: false,
    // Image generation. Off by default; the separate async-comfy-images
    // extension covers the tagger-based path, so both can be compared.
    imagesEnabled: false,
    imagesAuto: false,
    imageComfyUrl: "http://127.0.0.1:8188",
    imageWorkflow: "Krea2_Turbo.json",
    imageSteps: 8,
    imageWidth: 832,
    imageHeight: 1216,
    imageStyleSuffix: "",
    // "character" reuses one seed per card so a character renders
    // consistently; "random" varies every time.
    imageSeedMode: "character",
    filterMetaForNpcs: true,
    treatUnmarkedAsNpc: false,
    updateInterval: 8,
    maxMessagesPerUpdate: 80,
    maxMemoryWords: 450,
    responseLength: 700,
    showGroupSpeakerButtons: false,
    focusClearStrategy: group_activation_strategy.POOLED,
    depth: 4,
    position: extension_prompt_types.IN_PROMPT,
    role: extension_prompt_roles.SYSTEM,
};

let lastDraftCharacterId = null;
let selectedSettingsCharacterId = null;
let isUpdating = false;
let isGroupGenerationRunning = false;
let focusedSpeakerCharacterId = null;
let focusedSpeakerGroupId = null;
let isHandlingFocusedReply = false;
let pendingFocusedReply = false;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function getSettings() {
    if (!extension_settings[EXTENSION_KEY]) {
        extension_settings[EXTENSION_KEY] = clone(DEFAULT_SETTINGS);
    }

    extension_settings[EXTENSION_KEY] = Object.assign(
        {},
        DEFAULT_SETTINGS,
        extension_settings[EXTENSION_KEY],
    );

    return extension_settings[EXTENSION_KEY];
}

function saveSettings() {
    const context = getContext();
    if (typeof context.saveSettingsDebounced === "function") {
        context.saveSettingsDebounced();
    }
}

function nowIso() {
    return new Date().toISOString();
}

function makeEmptyStore() {
    return {
        version: 2,
        autobiography: {
            text: "",
            updatedAt: null,
            lastMessageIndexByChat: {},
        },
        secrets: {
            text: "",
            updatedAt: null,
        },
        goals: {
            text: "",
            updatedAt: null,
        },
        // Physical description, maintained only when trackAppearance is on.
        // Blank by default and never auto-invented; see buildUpdateSystemPrompt.
        appearance: {
            text: "",
            updatedAt: null,
        },
        relationships: {},
    };
}

function normalizeStore(rawStore) {
    const store = Object.assign(makeEmptyStore(), rawStore || {});
    store.autobiography = Object.assign(makeEmptyStore().autobiography, store.autobiography || {});
    store.autobiography.lastMessageIndexByChat = store.autobiography.lastMessageIndexByChat || {};
    store.secrets = Object.assign(makeEmptyStore().secrets, store.secrets || {});
    store.goals = Object.assign(makeEmptyStore().goals, store.goals || {});
    store.appearance = Object.assign(makeEmptyStore().appearance, store.appearance || {});
    store.relationships = store.relationships || {};

    for (const [key, relationship] of Object.entries(store.relationships)) {
        store.relationships[key] = Object.assign(
            {
                personaName: key,
                text: "",
                updatedAt: null,
                lastMessageIndexByChat: {},
            },
            relationship || {},
        );
        store.relationships[key].lastMessageIndexByChat =
            store.relationships[key].lastMessageIndexByChat || {};
    }

    return store;
}

function readStore(character) {
    return normalizeStore(character?.data?.extensions?.[STORAGE_KEY]);
}

async function writeStore(characterId, store) {
    const context = getContext();
    if (typeof context.writeExtensionField !== "function") {
        throw new Error("writeExtensionField is not available in this SillyTavern build.");
    }

    await context.writeExtensionField(characterId, STORAGE_KEY, normalizeStore(store));
}

function getPersona() {
    const context = getContext();
    const name = String(context.name1 || "User").trim() || "User";
    const key = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "user";

    return { key, name };
}

function getChatKey(context = getContext()) {
    const chatId = context.chatId || context.getCurrentChatId?.() || "unknown-chat";
    if (context.groupId) {
        return `group:${context.groupId}:${chatId}`;
    }

    return `character:${context.characterId ?? "unknown"}:${chatId}`;
}

function getCharacterById(characterId, context = getContext()) {
    const id = Number(characterId);
    if (!Number.isInteger(id) || id < 0) {
        return null;
    }

    return context.characters?.[id] || null;
}

function getGroupById(groupId) {
    return groups?.find(item => item.id === groupId) || null;
}

function getCurrentGroup(context = getContext()) {
    if (!context.groupId) {
        return null;
    }

    return context.groups?.find(item => item.id === context.groupId) || null;
}

function getGroupMemberCharacters(context = getContext()) {
    const group = getCurrentGroup(context);
    if (!group || !Array.isArray(group.members)) {
        return [];
    }

    const disabledMembers = new Set(group.disabled_members || []);
    const members = [];
    for (const avatar of group.members) {
        const id = context.characters?.findIndex(character => character?.avatar === avatar);
        if (Number.isInteger(id) && id >= 0 && !members.some(member => member.id === id)) {
            members.push({
                id,
                avatar,
                character: context.characters[id],
                disabled: disabledMembers.has(avatar),
            });
        }
    }

    return members;
}

function getGroupMemberCharacterIds(context = getContext()) {
    return getGroupMemberCharacters(context).map(member => member.id);
}

function getActiveCharacterId(context = getContext()) {
    if (lastDraftCharacterId !== null && getCharacterById(lastDraftCharacterId, context)) {
        return lastDraftCharacterId;
    }

    const rawId = context.characterId;
    const id = Number(rawId);
    if (Number.isInteger(id) && getCharacterById(id, context)) {
        return id;
    }

    const lastNpcMessage = [...(context.chat || [])]
        .reverse()
        .find(message => message && !message.is_user && !message.is_system);

    return findCharacterIdForMessage(lastNpcMessage, context);
}

function getSettingsCharacterId(context = getContext()) {
    const groupMemberIds = getGroupMemberCharacterIds(context);

    if (groupMemberIds.length) {
        if (groupMemberIds.includes(selectedSettingsCharacterId)) {
            return selectedSettingsCharacterId;
        }

        if (groupMemberIds.includes(lastDraftCharacterId)) {
            return lastDraftCharacterId;
        }

        selectedSettingsCharacterId = groupMemberIds[0];
        return selectedSettingsCharacterId;
    }

    const activeId = getActiveCharacterId(context);
    selectedSettingsCharacterId = activeId;
    return activeId;
}

function findCharacterIdForMessage(message, context = getContext()) {
    if (!message) {
        return null;
    }

    const originalAvatar = message.original_avatar || message.avatar;
    if (originalAvatar) {
        const byAvatar = context.characters.findIndex(character => character?.avatar === originalAvatar);
        if (byAvatar >= 0) {
            return byAvatar;
        }
    }

    const messageName = String(message.name || "").trim();
    if (messageName) {
        const byName = context.characters.findIndex(character => character?.name === messageName);
        if (byName >= 0) {
            return byName;
        }
    }

    return null;
}

function cleanMessageText(text) {
    return String(text || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function formatTranscript(messages, personaName) {
    return messages
        .map((message, index) => {
            const speaker = message.is_user ? personaName : (message.name || "System");
            const text = cleanMessageText(message.mes);
            return `${index + 1}. ${speaker}: ${text}`;
        })
        .filter(line => !line.endsWith(": "))
        .join("\n");
}

function getRelationship(store, persona) {
    if (!store.relationships[persona.key]) {
        store.relationships[persona.key] = {
            personaName: persona.name,
            text: "",
            updatedAt: null,
            lastMessageIndexByChat: {},
        };
    }

    store.relationships[persona.key].personaName = persona.name;
    store.relationships[persona.key].lastMessageIndexByChat =
        store.relationships[persona.key].lastMessageIndexByChat || {};

    return store.relationships[persona.key];
}

function getLastUpdatedIndex(store, relationship, chatKey) {
    const autobiographyIndex = Number(store.autobiography.lastMessageIndexByChat?.[chatKey] ?? -1);
    const relationshipIndex = Number(relationship.lastMessageIndexByChat?.[chatKey] ?? -1);

    return Math.min(autobiographyIndex, relationshipIndex);
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.max(min, Math.min(max, Math.floor(number)));
}

function buildUpdateSystemPrompt(characterName, personaName, maxWords, trackAppearance = false) {
    const appearanceRules = trackAppearance
        ? [
            "- The appearance field is what this NPC physically looks like right now: build, features, hair, clothing, and visible condition such as injuries, dirt, or exhaustion.",
            "- Write appearance in plain visual prose that a photographer could shoot from. Describe only what a camera would capture.",
            "- NEVER invent appearance details. If the transcript does not describe how someone looks, leave the existing appearance exactly as it is, and leave it empty if it is already empty.",
            "- Preserve permanent features (species, build, face, eye colour, permanent marks) verbatim unless the transcript explicitly describes them changing. Reword only the parts that actually changed.",
        ]
        : [];

    return [
        "You maintain private memory for one NPC in a SillyTavern roleplay.",
        `NPC: ${characterName}`,
        `Current user persona: ${personaName}`,
        "",
        `Update ${trackAppearance ? "five" : "four"} private memory fields from the new transcript.`,
        "Rules:",
        "- Write from the NPC's point of view.",
        "- Include only things the NPC witnessed, was told, did, felt, or could reasonably infer.",
        "- Do not treat hidden narrator facts as NPC knowledge just because they appear in the transcript.",
        "- The autobiography is the NPC's life memory across all chats and personas.",
        "- The relationship memory is only this NPC's history with the current user persona.",
        "- The secrets field is for things the NPC knows, suspects, hides, or should not reveal casually.",
        "- The goals field is for active objectives, plans, unresolved intentions, and things the NPC wants to accomplish.",
        "- Preserve existing secrets and goals unless the transcript clearly changes, reveals, completes, or invalidates them.",
        "- Do not write secrets or goals as instructions to the user; write them as private NPC state.",
        ...appearanceRules,
        "- If the new scene appears separate from earlier memories, say that it seems to be a separate encounter or later time.",
        `- Keep each field concise, no more than about ${maxWords} words.`,
        "",
        "Return JSON only, with exactly these keys:",
        trackAppearance
            ? "{\"autobiography\":\"...\",\"relationship\":\"...\",\"secrets\":\"...\",\"goals\":\"...\",\"appearance\":\"...\"}"
            : "{\"autobiography\":\"...\",\"relationship\":\"...\",\"secrets\":\"...\",\"goals\":\"...\"}",
    ].join("\n");
}

function buildUpdateUserPrompt(character, persona, store, relationship, messages, trackAppearance = false) {
    const appearanceBlock = trackAppearance
        ? [
            `Existing appearance for ${character.name}:`,
            store.appearance.text || "(empty)",
            "",
        ]
        : [];

    return [
        `Existing autobiography for ${character.name}:`,
        store.autobiography.text || "(empty)",
        "",
        `Existing relationship memory with ${persona.name}:`,
        relationship.text || "(empty)",
        "",
        `Existing secrets for ${character.name}:`,
        store.secrets.text || "(empty)",
        "",
        `Existing goals for ${character.name}:`,
        store.goals.text || "(empty)",
        "",
        ...appearanceBlock,
        "New transcript:",
        formatTranscript(messages, persona.name),
    ].join("\n");
}

function parseJsonResponse(text) {
    const cleaned = removeReasoningFromString(String(text || "")).trim();
    const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = extractFirstJsonObject(fenced ? fenced[1] : cleaned);

    if (!candidate) {
        throw new Error("The model did not return a JSON object.");
    }

    const parsed = JSON.parse(candidate);
    return {
        autobiography: String(parsed.autobiography || "").trim(),
        relationship: String(parsed.relationship || "").trim(),
        secrets: String(parsed.secrets || "").trim(),
        goals: String(parsed.goals || "").trim(),
        // Absent whenever appearance tracking is off; callers ignore "".
        appearance: String(parsed.appearance || "").trim(),
    };
}

async function generateMemoryUpdate(systemPrompt, userPrompt) {
    const context = getContext();
    const settings = getSettings();
    const responseLength = clampNumber(settings.responseLength, 100, 4000, DEFAULT_SETTINGS.responseLength);

    // Text-completion backends continue the transcript instead of obeying
    // "return JSON only", so seed the reply with the opening of the JSON
    // object. The response omits the prefill, so prepend it before parsing.
    const JSON_PREFILL = '{\n"autobiography": "';

    if (typeof context.generateRaw === "function") {
        const raw = await context.generateRaw({
            prompt: userPrompt,
            systemPrompt,
            responseLength,
            prefill: JSON_PREFILL,
        });
        return parseJsonResponse(JSON_PREFILL + raw);
    }

    if (typeof context.generateQuietPrompt === "function") {
        const raw = await context.generateQuietPrompt({
            quietPrompt: `${systemPrompt}\n\n${userPrompt}`,
            responseLength,
        });
        return parseJsonResponse(raw);
    }

    throw new Error("No quiet generation API is available in this SillyTavern build.");
}

async function maybeUpdateMemory(characterId, { force = false } = {}) {
    const context = getContext();
    const settings = getSettings();
    const character = getCharacterById(characterId, context);

    if (!settings.enabled || !character || isUpdating) {
        return false;
    }

    const chat = context.chat || [];
    if (!chat.length) {
        return false;
    }

    const persona = getPersona();
    const chatKey = getChatKey(context);
    const store = readStore(character);
    const relationship = getRelationship(store, persona);
    const lastUpdatedIndex = getLastUpdatedIndex(store, relationship, chatKey);
    const interval = clampNumber(settings.updateInterval, 1, 1000, DEFAULT_SETTINGS.updateInterval);
    const messagesSinceUpdate = Math.max(0, chat.length - 1 - lastUpdatedIndex);

    if (!force && messagesSinceUpdate < interval) {
        return false;
    }

    const maxMessages = clampNumber(
        settings.maxMessagesPerUpdate,
        1,
        500,
        DEFAULT_SETTINGS.maxMessagesPerUpdate,
    );
    const startIndex = Math.max(0, Math.max(lastUpdatedIndex + 1, chat.length - maxMessages));
    const messages = chat
        .slice(startIndex)
        .filter(message => message && !message.is_system && cleanMessageText(message.mes));

    if (!messages.length) {
        return false;
    }

    // For cards that filter GM/meta brackets from their replies, strip those
    // brackets from the transcript the summarizer sees too, so hidden info
    // never enters this NPC's persisted memory.
    const summaryMessages = shouldFilterForCharacter(character)
        ? messages
            .map(message => Object.assign({}, message, { mes: stripStandaloneBrackets(String(message.mes ?? "")) }))
            .filter(message => cleanMessageText(message.mes))
        : messages;

    if (!summaryMessages.length) {
        return false;
    }

    const maxWords = clampNumber(settings.maxMemoryWords, 50, 2000, DEFAULT_SETTINGS.maxMemoryWords);
    const trackAppearance = Boolean(settings.trackAppearance);
    const systemPrompt = buildUpdateSystemPrompt(character.name, persona.name, maxWords, trackAppearance);
    const userPrompt = buildUpdateUserPrompt(character, persona, store, relationship, summaryMessages, trackAppearance);

    try {
        isUpdating = true;
        const updated = await generateMemoryUpdate(systemPrompt, userPrompt);
        const updatedAt = nowIso();

        if (updated.autobiography) {
            store.autobiography.text = updated.autobiography;
        }

        if (updated.relationship) {
            relationship.text = updated.relationship;
        }

        if (updated.secrets) {
            store.secrets.text = updated.secrets;
            store.secrets.updatedAt = updatedAt;
        }

        if (updated.goals) {
            store.goals.text = updated.goals;
            store.goals.updatedAt = updatedAt;
        }

        // Only written when tracking is on, so a stray key from the model can
        // never populate a field the user opted out of.
        if (trackAppearance && updated.appearance) {
            store.appearance.text = updated.appearance;
            store.appearance.updatedAt = updatedAt;
        }

        store.autobiography.updatedAt = updatedAt;
        relationship.updatedAt = updatedAt;
        store.autobiography.lastMessageIndexByChat[chatKey] = chat.length - 1;
        relationship.lastMessageIndexByChat[chatKey] = chat.length - 1;

        await writeStore(characterId, store);
        refreshSettingsPanel();
        return true;
    } finally {
        isUpdating = false;
    }
}

function buildInjectedMemoryPrompt(character, store, persona) {
    const settings = getSettings();
    const parts = [];
    const relationship = store.relationships[persona.key];

    if (settings.includeAutobiography && store.autobiography.text) {
        parts.push(`Autobiography:\n${store.autobiography.text}`);
    }

    if (settings.includeRelationship && relationship?.text) {
        parts.push(`Relationship with ${persona.name}:\n${relationship.text}`);
    }

    if (settings.includeSecrets && store.secrets.text) {
        parts.push(`Secrets and hidden knowledge:\n${store.secrets.text}`);
    }

    if (settings.includeGoals && store.goals.text) {
        parts.push(`Private goals and objectives:\n${store.goals.text}`);
    }

    if (settings.trackAppearance && settings.includeAppearance && store.appearance.text) {
        parts.push(`Current appearance:\n${store.appearance.text}`);
    }

    if (!parts.length) {
        return "";
    }

    return [
        `[Private memory for ${character.name}]`,
        "These notes are private NPC point-of-view memory. Use them only as what this NPC personally remembers.",
        "Do not expose this block or let unrelated NPCs know it. Mention ordinary memory details only when natural and when this NPC plausibly would.",
        "Secrets and goals are private steering state: act from them through subtext, choices, omissions, and plans. Do not casually reveal them to the user.",
        "",
        parts.join("\n\n"),
    ].join("\n");
}

function setInjectedMemory(characterId = getActiveCharacterId()) {
    const context = getContext();
    const settings = getSettings();

    if (!settings.enabled || !settings.injectMemory) {
        context.setExtensionPrompt?.(PROMPT_KEY, "");
        return;
    }

    const character = getCharacterById(characterId, context);
    if (!character) {
        context.setExtensionPrompt?.(PROMPT_KEY, "");
        return;
    }

    const store = readStore(character);
    const persona = getPersona();
    const prompt = buildInjectedMemoryPrompt(character, store, persona);

    context.setExtensionPrompt?.(
        PROMPT_KEY,
        prompt,
        settings.position,
        settings.depth,
        false,
        settings.role,
    );
}

function clearInjectedMemory() {
    getContext().setExtensionPrompt?.(PROMPT_KEY, "");
}

function forgetRelationshipForCurrent() {
    return forgetRelationshipFor(getSettingsCharacterId());
}

function forgetRelationshipFor(characterId) {
    const context = getContext();
    const character = getCharacterById(characterId, context);
    if (!character) {
        toastr.warning("No NPC is currently selected.");
        return;
    }

    const persona = getPersona();
    const store = readStore(character);
    delete store.relationships[persona.key];

    return writeStore(characterId, store).then(() => {
        setInjectedMemory(characterId);
        refreshSettingsPanel();
        toastr.success(`Forgot ${character.name}'s relationship memory for ${persona.name}.`);
    });
}

function forgetAllForCurrent() {
    return forgetAllFor(getSettingsCharacterId());
}

function forgetAllFor(characterId) {
    const context = getContext();
    const character = getCharacterById(characterId, context);
    if (!character) {
        toastr.warning("No NPC is currently selected.");
        return;
    }

    return writeStore(characterId, makeEmptyStore()).then(() => {
        setInjectedMemory(characterId);
        refreshSettingsPanel();
        toastr.success(`Forgot all NPC POV memory for ${character.name}.`);
    });
}

function savePrivateFieldsForCurrent() {
    const context = getContext();
    const characterId = getSettingsCharacterId(context);
    const character = getCharacterById(characterId, context);
    if (!character) {
        toastr.warning("No NPC is currently selected.");
        return;
    }

    const store = readStore(character);
    const updatedAt = nowIso();
    store.secrets.text = String($("#npc-pov-memory-secrets").val() || "").trim();
    store.goals.text = String($("#npc-pov-memory-goals").val() || "").trim();
    store.appearance.text = String($("#npc-pov-memory-appearance").val() || "").trim();
    store.secrets.updatedAt = updatedAt;
    store.goals.updatedAt = updatedAt;
    store.appearance.updatedAt = updatedAt;

    return writeStore(characterId, store).then(() => {
        setInjectedMemory(characterId);
        refreshSettingsPanel();
        toastr.success(`Saved private notes for ${character.name}.`);
    });
}

async function setGmscreenRoleForCurrent(value) {
    return setGmscreenRoleFor(getSettingsCharacterId(), value);
}

async function setGmscreenRoleFor(characterId, value) {
    const context = getContext();
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

function createSettingsPanel() {
    if ($("#npc-pov-memory-settings").length) {
        return;
    }

    const html = `
        <div id="npc-pov-memory-settings" class="npc-pov-memory-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>NPC POV Memory</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="npc-pov-memory-body">
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-enabled" type="checkbox">
                            <span>Enable NPC POV Memory</span>
                        </label>
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-inject" type="checkbox">
                            <span>Inject memory into prompts</span>
                        </label>
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-auto" type="checkbox">
                            <span>Automatically update after NPC messages</span>
                        </label>
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-show-speaker-buttons" type="checkbox">
                            <span>Show group speaker buttons</span>
                        </label>
                        <div class="npc-pov-memory-focus-setting">
                            <label>
                                <span>When focus clears</span>
                                <select id="npc-pov-memory-focus-clear-strategy" class="text_pole"></select>
                            </label>
                        </div>
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-include-secrets" type="checkbox">
                            <span>Inject secrets and hidden knowledge</span>
                        </label>
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-include-goals" type="checkbox">
                            <span>Inject private goals</span>
                        </label>
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-track-appearance" type="checkbox">
                            <span>Track appearance (physical description)</span>
                        </label>
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-include-appearance" type="checkbox">
                            <span>Inject appearance into prompts</span>
                        </label>
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-filter-meta" type="checkbox">
                            <span>Strip GM/meta bracket tags for non-GM NPCs</span>
                        </label>
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-treat-unmarked" type="checkbox">
                            <span>Treat unmarked cards as NPCs (strip by default)</span>
                        </label>
                        <div class="npc-pov-memory-character-picker">
                            <label>
                                <span>NPC</span>
                                <select id="npc-pov-memory-character-select" class="text_pole"></select>
                            </label>
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
                        </div>
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-images-enabled" type="checkbox">
                            <span>Enable image generation (ComfyUI)</span>
                        </label>
                        <label class="checkbox_label">
                            <input id="npc-pov-memory-images-auto" type="checkbox">
                            <span>Auto-generate after each character message</span>
                        </label>
                        <div class="npc-pov-memory-image-settings">
                            <label>
                                <span>ComfyUI URL</span>
                                <input id="npc-pov-memory-image-url" class="text_pole" type="text">
                            </label>
                            <label>
                                <span>Workflow file</span>
                                <input id="npc-pov-memory-image-workflow" class="text_pole" type="text">
                            </label>
                            <label>
                                <span>Seed</span>
                                <select id="npc-pov-memory-image-seed-mode" class="text_pole">
                                    <option value="character">Consistent per character</option>
                                    <option value="random">Random every time</option>
                                </select>
                            </label>
                            <div class="npc-pov-memory-grid">
                                <label>
                                    <span>Width</span>
                                    <input id="npc-pov-memory-image-width" class="text_pole" type="number" min="256" max="2048" step="64">
                                </label>
                                <label>
                                    <span>Height</span>
                                    <input id="npc-pov-memory-image-height" class="text_pole" type="number" min="256" max="2048" step="64">
                                </label>
                                <label>
                                    <span>Steps</span>
                                    <input id="npc-pov-memory-image-steps" class="text_pole" type="number" min="1" max="60">
                                </label>
                            </div>
                            <label>
                                <span>Style suffix (appended to every prompt)</span>
                                <textarea id="npc-pov-memory-image-style" class="text_pole" rows="2"
                                    placeholder="e.g. Shot on 35mm, shallow depth of field."></textarea>
                            </label>
                        </div>
                        <div class="npc-pov-memory-grid">
                            <label>
                                <span>Update every</span>
                                <input id="npc-pov-memory-interval" class="text_pole" type="number" min="1" max="1000">
                            </label>
                            <label>
                                <span>Max messages</span>
                                <input id="npc-pov-memory-max-messages" class="text_pole" type="number" min="1" max="500">
                            </label>
                            <label>
                                <span>Max words</span>
                                <input id="npc-pov-memory-max-words" class="text_pole" type="number" min="50" max="2000">
                            </label>
                            <label>
                                <span>Response tokens</span>
                                <input id="npc-pov-memory-response-length" class="text_pole" type="number" min="100" max="4000">
                            </label>
                        </div>
                        <div class="npc-pov-memory-current">
                            <div class="npc-pov-memory-current-target"></div>
                            <div class="npc-pov-memory-preview"></div>
                        </div>
                        <div class="npc-pov-memory-private-editor">
                            <label>
                                <span>Secrets and hidden knowledge</span>
                                <textarea id="npc-pov-memory-secrets" class="text_pole" rows="5"></textarea>
                            </label>
                            <label>
                                <span>Private goals</span>
                                <textarea id="npc-pov-memory-goals" class="text_pole" rows="5"></textarea>
                            </label>
                            <label class="npc-pov-memory-appearance-editor">
                                <span>Appearance (visual description for image generation)</span>
                                <textarea id="npc-pov-memory-appearance" class="text_pole" rows="5"
                                    placeholder="Write what this character looks like, as plain visual prose."></textarea>
                            </label>
                            <button id="npc-pov-memory-save-private" class="menu_button">Save private notes</button>
                        </div>
                        <div class="npc-pov-memory-buttons">
                            <button id="npc-pov-memory-update-now" class="menu_button">Update selected NPC</button>
                            <button id="npc-pov-memory-forget-relationship" class="menu_button">Forget relationship</button>
                            <button id="npc-pov-memory-forget-all" class="menu_button">Forget all</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    $("#extensions_settings2").append(html);
    bindSettingsPanel();
    refreshSettingsPanel();
}

function bindSettingsPanel() {
    $("#npc-pov-memory-enabled").on("change", function () {
        getSettings().enabled = Boolean($(this).prop("checked"));
        saveSettings();
        setInjectedMemory();
    });

    $("#npc-pov-memory-inject").on("change", function () {
        getSettings().injectMemory = Boolean($(this).prop("checked"));
        saveSettings();
        setInjectedMemory();
    });

    $("#npc-pov-memory-auto").on("change", function () {
        getSettings().autoUpdate = Boolean($(this).prop("checked"));
        saveSettings();
    });

    $("#npc-pov-memory-show-speaker-buttons").on("change", function () {
        getSettings().showGroupSpeakerButtons = Boolean($(this).prop("checked"));
        saveSettings();
        refreshGroupSpeakerBar();
    });

    $("#npc-pov-memory-focus-clear-strategy").on("change", function () {
        getSettings().focusClearStrategy = clampNumber($(this).val(), 0, 3, group_activation_strategy.POOLED);
        saveSettings();
        refreshGroupSpeakerBar();
    });

    $("#npc-pov-memory-include-secrets").on("change", function () {
        getSettings().includeSecrets = Boolean($(this).prop("checked"));
        saveSettings();
        setInjectedMemory();
    });

    $("#npc-pov-memory-include-goals").on("change", function () {
        getSettings().includeGoals = Boolean($(this).prop("checked"));
        saveSettings();
        setInjectedMemory();
    });

    $("#npc-pov-memory-track-appearance").on("change", function () {
        getSettings().trackAppearance = Boolean($(this).prop("checked"));
        saveSettings();
        setInjectedMemory();
        refreshSettingsPanel();
    });

    $("#npc-pov-memory-include-appearance").on("change", function () {
        getSettings().includeAppearance = Boolean($(this).prop("checked"));
        saveSettings();
        setInjectedMemory();
    });

    $("#npc-pov-memory-images-enabled").on("change", function () {
        getSettings().imagesEnabled = Boolean($(this).prop("checked"));
        saveSettings();
        refreshSettingsPanel();
    });

    $("#npc-pov-memory-images-auto").on("change", function () {
        getSettings().imagesAuto = Boolean($(this).prop("checked"));
        saveSettings();
    });

    $("#npc-pov-memory-image-url").on("change", function () {
        getSettings().imageComfyUrl = String($(this).val() || "").trim();
        saveSettings();
    });

    $("#npc-pov-memory-image-workflow").on("change", function () {
        getSettings().imageWorkflow = String($(this).val() || "").trim();
        saveSettings();
    });

    $("#npc-pov-memory-image-seed-mode").on("change", function () {
        getSettings().imageSeedMode = $(this).val() === "random" ? "random" : "character";
        saveSettings();
    });

    $("#npc-pov-memory-image-width").on("change", function () {
        getSettings().imageWidth = clampNumber($(this).val(), 256, 2048, DEFAULT_SETTINGS.imageWidth);
        saveSettings();
        refreshSettingsPanel();
    });

    $("#npc-pov-memory-image-height").on("change", function () {
        getSettings().imageHeight = clampNumber($(this).val(), 256, 2048, DEFAULT_SETTINGS.imageHeight);
        saveSettings();
        refreshSettingsPanel();
    });

    $("#npc-pov-memory-image-steps").on("change", function () {
        getSettings().imageSteps = clampNumber($(this).val(), 1, 60, DEFAULT_SETTINGS.imageSteps);
        saveSettings();
        refreshSettingsPanel();
    });

    $("#npc-pov-memory-image-style").on("change", function () {
        getSettings().imageStyleSuffix = String($(this).val() || "").trim();
        saveSettings();
    });

    $("#npc-pov-memory-filter-meta").on("change", function () {
        getSettings().filterMetaForNpcs = Boolean($(this).prop("checked"));
        saveSettings();
    });

    $("#npc-pov-memory-treat-unmarked").on("change", function () {
        getSettings().treatUnmarkedAsNpc = Boolean($(this).prop("checked"));
        saveSettings();
    });

    $("#npc-pov-memory-character-select").on("change", function () {
        const id = Number($(this).val());
        selectedSettingsCharacterId = Number.isInteger(id) ? id : null;
        refreshSettingsPanel();
    });

    $("#npc-pov-memory-role").on("change", async function () {
        await setGmscreenRoleForCurrent(String($(this).val() || ""));
    });

    $("#npc-pov-memory-interval").on("change", function () {
        getSettings().updateInterval = clampNumber($(this).val(), 1, 1000, DEFAULT_SETTINGS.updateInterval);
        saveSettings();
        refreshSettingsPanel();
    });

    $("#npc-pov-memory-max-messages").on("change", function () {
        getSettings().maxMessagesPerUpdate = clampNumber(
            $(this).val(),
            1,
            500,
            DEFAULT_SETTINGS.maxMessagesPerUpdate,
        );
        saveSettings();
        refreshSettingsPanel();
    });

    $("#npc-pov-memory-max-words").on("change", function () {
        getSettings().maxMemoryWords = clampNumber($(this).val(), 50, 2000, DEFAULT_SETTINGS.maxMemoryWords);
        saveSettings();
        refreshSettingsPanel();
    });

    $("#npc-pov-memory-response-length").on("change", function () {
        getSettings().responseLength = clampNumber($(this).val(), 100, 4000, DEFAULT_SETTINGS.responseLength);
        saveSettings();
        refreshSettingsPanel();
    });

    $("#npc-pov-memory-update-now").on("click", async function () {
        const button = $(this);
        const characterId = getSettingsCharacterId();
        if (characterId === null) {
            toastr.warning("No NPC is currently selected.");
            return;
        }

        button.prop("disabled", true);
        try {
            const updated = await maybeUpdateMemory(characterId, { force: true });
            setInjectedMemory(characterId);
            toastr[updated ? "success" : "info"](updated ? "NPC memory updated." : "Nothing new to summarize.");
        } catch (error) {
            console.error("[NPC POV Memory] Update failed", error);
            toastr.error(String(error), "NPC memory update failed");
        } finally {
            button.prop("disabled", false);
        }
    });

    $("#npc-pov-memory-save-private").on("click", async function () {
        const button = $(this);
        button.prop("disabled", true);
        try {
            await savePrivateFieldsForCurrent();
        } catch (error) {
            console.error("[NPC POV Memory] Private notes save failed", error);
            toastr.error(String(error), "NPC private notes save failed");
        } finally {
            button.prop("disabled", false);
        }
    });

    $("#npc-pov-memory-forget-relationship").on("click", async function () {
        if (confirm("Forget this NPC's relationship memory for the current user persona?")) {
            await forgetRelationshipForCurrent();
        }
    });

    $("#npc-pov-memory-forget-all").on("click", async function () {
        if (confirm("Forget all NPC POV memory stored on the current character card?")) {
            await forgetAllForCurrent();
        }
    });
}

function ensureGroupSpeakerBar() {
    const settings = getSettings();
    const strategyOptions = getGroupActivationStrategyOptions(settings.focusClearStrategy);
    $("#npc-pov-memory-focus-clear-strategy").html(strategyOptions);

    if ($("#npc-pov-memory-speaker-bar").length) {
        return;
    }

    const bar = $(`
        <div id="npc-pov-memory-speaker-bar" class="npc-pov-memory-speaker-bar">
            <div class="npc-pov-memory-speaker-list"></div>
        </div>
    `);
    const target = $("#nonQRFormItems");
    if (target.length) {
        target.before(bar);
    } else {
        $("#send_form").prepend(bar);
    }

    bar.on("click", ".npc-pov-memory-speaker-trigger", async function (event) {
        const characterId = Number($(this).attr("data-character-id"));
        if (Number.isInteger(characterId)) {
            if (event.shiftKey) {
                await toggleFocusedSpeaker(characterId);
            } else {
                await triggerGroupSpeaker(characterId);
            }
        }
    });

    bar.on("contextmenu", ".npc-pov-memory-speaker-trigger", function (event) {
        const characterId = Number($(this).attr("data-character-id"));
        if (Number.isInteger(characterId)) {
            event.preventDefault();
            event.stopPropagation();
            openNpcContextMenu(characterId, event.clientX, event.clientY);
        }
    });
}

function getGroupActivationStrategyOptions(selectedValue) {
    const options = [
        [group_activation_strategy.POOLED, "Pooled order"],
        [group_activation_strategy.NATURAL, "Natural order"],
        [group_activation_strategy.MANUAL, "Manual"],
    ];

    return options
        .map(([value, label]) => `<option value="${value}"${Number(selectedValue) === value ? " selected" : ""}>${label}</option>`)
        .join("");
}

async function setCurrentGroupActivationStrategy(strategy) {
    const context = getContext();
    const groupId = context.groupId || selected_group;
    const group = getGroupById(groupId);
    if (!group) {
        return;
    }

    group.activation_strategy = Number(strategy);
    await editGroup(group.id, false, false);
}

function focusedSpeakerIsCurrent(context = getContext()) {
    return Boolean(
        focusedSpeakerCharacterId !== null
        && focusedSpeakerGroupId
        && context.groupId === focusedSpeakerGroupId
        && getGroupMemberCharacterIds(context).includes(focusedSpeakerCharacterId)
    );
}

async function setFocusedSpeaker(characterId) {
    const context = getContext();
    const member = getGroupMemberCharacters(context).find(item => item.id === characterId);
    if (!context.groupId || !member) {
        toastr.warning("That NPC is not in the current group.");
        refreshGroupSpeakerBar();
        return;
    }

    if (member.disabled) {
        toastr.warning(`${member.character?.name || "That NPC"} is disabled in this group.`);
        refreshGroupSpeakerBar();
        return;
    }

    focusedSpeakerCharacterId = characterId;
    focusedSpeakerGroupId = context.groupId;
    selectedSettingsCharacterId = characterId;
    pendingFocusedReply = false;
    await setCurrentGroupActivationStrategy(group_activation_strategy.MANUAL);
    refreshSettingsPanel();
    refreshGroupSpeakerBar();
    toastr.info(`Focused speaker: ${member.character?.name || "selected NPC"}.`);
}

async function clearFocusedSpeaker() {
    if (focusedSpeakerCharacterId === null) {
        return;
    }

    focusedSpeakerCharacterId = null;
    focusedSpeakerGroupId = null;
    pendingFocusedReply = false;
    await setCurrentGroupActivationStrategy(getSettings().focusClearStrategy);
    refreshSettingsPanel();
    refreshGroupSpeakerBar();
    toastr.info("Focused speaker cleared.");
}

async function toggleFocusedSpeaker(characterId) {
    if (focusedSpeakerIsCurrent() && focusedSpeakerCharacterId === characterId) {
        await clearFocusedSpeaker();
        return;
    }

    await setFocusedSpeaker(characterId);
}

function getCharacterAvatarUrl(character) {
    if (character?.avatar && character.avatar !== "none") {
        return getThumbnailUrl("avatar", character.avatar);
    }

    return default_avatar;
}

function refreshGroupSpeakerBar() {
    ensureGroupSpeakerBar();

    const settings = getSettings();
    const context = getContext();
    const bar = $("#npc-pov-memory-speaker-bar");
    const list = bar.find(".npc-pov-memory-speaker-list");
    const members = getGroupMemberCharacters(context);

    list.empty();

    if (!settings.showGroupSpeakerButtons || !context.groupId || !members.length) {
        bar.hide();
        return;
    }

    for (const member of members) {
        const character = member.character;
        if (!character) {
            continue;
        }

        const name = character.name || `NPC ${member.id + 1}`;
        const isFocused = focusedSpeakerIsCurrent(context) && focusedSpeakerCharacterId === member.id;
        const disabled = member.disabled || isGroupGenerationRunning;
        const title = isGroupGenerationRunning
            ? "Wait for the current group reply to finish"
            : member.disabled
                ? `${name} is disabled in this group`
                : isFocused
                    ? `Click for one reply from ${name}. Shift-click to clear focus.`
                    : `Click for one reply from ${name}. Shift-click to focus.`;
        const button = $("<button>", {
            type: "button",
            class: "npc-pov-memory-speaker-trigger",
            "data-character-id": String(member.id),
            title,
            "aria-label": title,
        });

        button.prop("disabled", disabled);
        button.toggleClass("npc-pov-memory-speaker-disabled", member.disabled);
        button.toggleClass("npc-pov-memory-speaker-focused", isFocused);
        button.append($("<img>", {
            src: getCharacterAvatarUrl(character),
            alt: "",
            loading: "lazy",
        }));
        button.append($("<span>").text(name));

        list.append($("<div>", { class: "npc-pov-memory-speaker-item" }).append(button));
    }

    bar.toggle(Boolean(list.children().length));
}

async function triggerGroupSpeaker(characterId) {
    const context = getContext();
    const member = getGroupMemberCharacters(context).find(item => item.id === characterId);
    if (!context.groupId || !member) {
        toastr.warning("That NPC is not in the current group.");
        refreshGroupSpeakerBar();
        return;
    }

    const character = member.character;
    if (member.disabled) {
        toastr.warning(`${character?.name || "That NPC"} is disabled in this group.`);
        refreshGroupSpeakerBar();
        return;
    }

    if (isGroupGenerationRunning) {
        toastr.info("Wait for the current group reply to finish.");
        refreshGroupSpeakerBar();
        return;
    }

    selectedSettingsCharacterId = characterId;
    refreshSettingsPanel();
    isGroupGenerationRunning = true;
    refreshGroupSpeakerBar();

    try {
        await Generate("normal", { force_chid: characterId });
    } catch (error) {
        console.error("[NPC POV Memory] Forced group reply failed", error);
        toastr.error(String(error), "NPC reply failed");
    } finally {
        isGroupGenerationRunning = false;
        refreshGroupSpeakerBar();
    }
}

async function maybeTriggerFocusedSpeaker(messageId) {
    const context = getContext();
    if (isHandlingFocusedReply || isGroupGenerationRunning || !focusedSpeakerIsCurrent(context)) {
        return false;
    }

    const message = context.chat?.[messageId];
    if (!message?.is_user) {
        return;
    }

    isHandlingFocusedReply = true;
    try {
        await triggerGroupSpeaker(focusedSpeakerCharacterId);
    } finally {
        isHandlingFocusedReply = false;
    }

    return true;
}

function queueFocusedSpeakerReply(messageId) {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message?.is_user || !focusedSpeakerIsCurrent(context)) {
        return;
    }

    pendingFocusedReply = true;
}

async function runPendingFocusedSpeakerReply() {
    if (!pendingFocusedReply || isHandlingFocusedReply || isGroupGenerationRunning) {
        return;
    }

    pendingFocusedReply = false;
    const context = getContext();
    const lastMessageId = (context.chat || []).length - 1;
    await maybeTriggerFocusedSpeaker(lastMessageId);
}

function refreshCharacterSelector(context, selectedCharacterId) {
    const selector = $("#npc-pov-memory-character-select");
    if (!selector.length) {
        return;
    }

    const groupMemberIds = getGroupMemberCharacterIds(context);
    const optionIds = groupMemberIds.length
        ? groupMemberIds
        : context.characters?.map((_, id) => id).filter(id => id === selectedCharacterId) || [];

    selector.empty();

    if (!optionIds.length) {
        selector.append($("<option>").val("").text("No NPC selected"));
        selector.prop("disabled", true);
        $(".npc-pov-memory-character-picker").hide();
        return;
    }

    for (const id of optionIds) {
        const character = getCharacterById(id, context);
        if (!character) {
            continue;
        }

        selector.append($("<option>").val(String(id)).text(character.name || `NPC ${id + 1}`));
    }

    selector.val(String(selectedCharacterId));
    selector.prop("disabled", optionIds.length <= 1);
    $(".npc-pov-memory-character-picker").toggle(optionIds.length > 1);
}

function refreshSettingsPanel() {
    const settings = getSettings();
    const context = getContext();
    const characterId = getSettingsCharacterId(context);
    const character = getCharacterById(characterId, context);
    const persona = getPersona();

    $("#npc-pov-memory-enabled").prop("checked", settings.enabled);
    $("#npc-pov-memory-inject").prop("checked", settings.injectMemory);
    $("#npc-pov-memory-auto").prop("checked", settings.autoUpdate);
    $("#npc-pov-memory-include-secrets").prop("checked", settings.includeSecrets);
    $("#npc-pov-memory-show-speaker-buttons").prop("checked", settings.showGroupSpeakerButtons);
    $("#npc-pov-memory-focus-clear-strategy").val(String(settings.focusClearStrategy));
    $("#npc-pov-memory-include-goals").prop("checked", settings.includeGoals);
    $("#npc-pov-memory-images-enabled").prop("checked", settings.imagesEnabled);
    $("#npc-pov-memory-images-auto")
        .prop("checked", settings.imagesAuto)
        .prop("disabled", !settings.imagesEnabled);
    $("#npc-pov-memory-image-url").val(settings.imageComfyUrl);
    $("#npc-pov-memory-image-workflow").val(settings.imageWorkflow);
    $("#npc-pov-memory-image-seed-mode").val(settings.imageSeedMode);
    $("#npc-pov-memory-image-width").val(settings.imageWidth);
    $("#npc-pov-memory-image-height").val(settings.imageHeight);
    $("#npc-pov-memory-image-steps").val(settings.imageSteps);
    if (!$("#npc-pov-memory-image-style").is(":focus")) {
        $("#npc-pov-memory-image-style").val(settings.imageStyleSuffix);
    }
    $(".npc-pov-memory-image-settings").toggle(Boolean(settings.imagesEnabled));
    $("#npc-pov-memory-track-appearance").prop("checked", settings.trackAppearance);
    $("#npc-pov-memory-include-appearance")
        .prop("checked", settings.includeAppearance)
        .prop("disabled", !settings.trackAppearance);
    // The appearance editor is only meaningful while tracking is on.
    $(".npc-pov-memory-appearance-editor").toggle(Boolean(settings.trackAppearance));
    $("#npc-pov-memory-filter-meta").prop("checked", settings.filterMetaForNpcs);
    $("#npc-pov-memory-treat-unmarked").prop("checked", settings.treatUnmarkedAsNpc);
    $("#npc-pov-memory-interval").val(settings.updateInterval);
    $("#npc-pov-memory-max-messages").val(settings.maxMessagesPerUpdate);
    $("#npc-pov-memory-max-words").val(settings.maxMemoryWords);
    $("#npc-pov-memory-response-length").val(settings.responseLength);
    refreshCharacterSelector(context, characterId);
    refreshGroupSpeakerBar();

    if (!character) {
        $(".npc-pov-memory-current-target").text("Current target: none");
        $(".npc-pov-memory-preview").text("Open a character or group chat to view stored NPC memory.");
        $("#npc-pov-memory-secrets").val("");
        $("#npc-pov-memory-goals").val("");
        $("#npc-pov-memory-appearance").val("");
        $("#npc-pov-memory-role").val("");
        return;
    }

    const rawRole = character?.data?.extensions?.gmscreen_role;
    $("#npc-pov-memory-role").val(rawRole === "gm" || rawRole === "npc" ? rawRole : "");

    const store = readStore(character);
    const relationship = store.relationships[persona.key]?.text || "";
    const autobiography = store.autobiography.text || "";
    const secrets = store.secrets.text || "";
    const goals = store.goals.text || "";
    const preview = [
        autobiography ? `Autobiography: ${autobiography}` : "Autobiography: empty",
        relationship ? `Relationship with ${persona.name}: ${relationship}` : `Relationship with ${persona.name}: empty`,
    ].join("\n\n");

    $(".npc-pov-memory-current-target").text(`Viewing: ${character.name} / ${persona.name}`);
    $(".npc-pov-memory-preview").text(preview);

    if (!$("#npc-pov-memory-secrets").is(":focus")) {
        $("#npc-pov-memory-secrets").val(secrets);
    }

    if (!$("#npc-pov-memory-goals").is(":focus")) {
        $("#npc-pov-memory-goals").val(goals);
    }

    if (!$("#npc-pov-memory-appearance").is(":focus")) {
        $("#npc-pov-memory-appearance").val(store.appearance.text || "");
    }
}

async function onCharacterMessageRendered(messageId) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoUpdate) {
        return;
    }

    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message || message.is_user || message.is_system) {
        return;
    }

    const characterId = findCharacterIdForMessage(message, context);
    if (characterId === null) {
        return;
    }

    try {
        const updated = await maybeUpdateMemory(characterId);
        if (updated) {
            setInjectedMemory(characterId);
        }
    } catch (error) {
        console.error("[NPC POV Memory] Automatic update failed", error);
    }
}

function onGroupMemberDrafted(characterId) {
    const id = Number(characterId);
    if (Number.isInteger(id)) {
        lastDraftCharacterId = id;
        setInjectedMemory(id);
        refreshSettingsPanel();
    }
}

function registerEvents() {
    const context = getContext();
    const source = context.eventSource;
    const events = context.eventTypes || context.event_types;

    if (!source || !events) {
        console.warn("[NPC POV Memory] SillyTavern event source is not available.");
        return;
    }

    source.on(events.CHAT_CHANGED, () => {
        lastDraftCharacterId = null;
        selectedSettingsCharacterId = null;
        if (getContext().groupId) {
            clearInjectedMemory();
        } else {
            setInjectedMemory();
        }
        refreshSettingsPanel();
        refreshGroupSpeakerBar();
    });

    source.on(events.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    source.on(events.CHARACTER_MESSAGE_RENDERED, onMessageForImage);
    if (events.MESSAGE_SENT) {
        source.on(events.MESSAGE_SENT, queueFocusedSpeakerReply);
    }

    if (events.GROUP_MEMBER_DRAFTED) {
        source.on(events.GROUP_MEMBER_DRAFTED, onGroupMemberDrafted);
    }

    if (events.GROUP_WRAPPER_STARTED) {
        source.on(events.GROUP_WRAPPER_STARTED, () => {
            isGroupGenerationRunning = true;
            refreshGroupSpeakerBar();
        });
    }

    if (events.GROUP_WRAPPER_FINISHED) {
        source.on(events.GROUP_WRAPPER_FINISHED, async () => {
            isGroupGenerationRunning = false;
            lastDraftCharacterId = null;
            clearInjectedMemory();
            refreshSettingsPanel();
            refreshGroupSpeakerBar();
            await runPendingFocusedSpeakerReply();
        });
    }

    if (events.GROUP_UPDATED) {
        source.on(events.GROUP_UPDATED, () => {
            refreshSettingsPanel();
            refreshGroupSpeakerBar();
        });
    }

    for (const eventName of [events.MESSAGE_DELETED, events.MESSAGE_UPDATED, events.MESSAGE_SWIPED]) {
        if (eventName) {
            source.on(eventName, () => {
                setInjectedMemory();
                refreshSettingsPanel();
            });
        }
    }
}

export async function init() {
    getSettings();
    createSettingsPanel();
    ensureGroupSpeakerBar();
    registerEvents();
    refreshGroupSpeakerBar();
    setInjectedMemory();
    console.log("[NPC POV Memory] Extension loaded");
}

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

jQuery(async () => {
    try {
        await init();
    } catch (error) {
        console.error("[NPC POV Memory] Failed to initialize", error);
        toastr.error(String(error), "NPC POV Memory failed to initialize");
    }
});

// ============================================================
// NPC manager: portrait-row context menu, group membership,
// bulk history rewrite, persisted bracket strip, portrait swap.
// All reachable via right-click on a speaker-bar portrait.
// ============================================================

const BULK_SNAPSHOT_CAP = 10;
let bulkSnapshots = [];
let bulkCancelRequested = false;
let isBulkRunning = false;

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// ---- group membership ----

function getCurrentGroupOrWarn() {
    const context = getContext();
    const group = getGroupById(context.groupId || selected_group);
    if (!group || !Array.isArray(group.members)) {
        toastr.warning("No group chat is currently open.");
        return null;
    }
    return group;
}

function getNonMemberCharacters(context = getContext()) {
    const group = getGroupById(context.groupId || selected_group);
    const members = new Set(group?.members || []);
    const out = [];
    for (let id = 0; id < (context.characters?.length || 0); id++) {
        const character = context.characters[id];
        if (character?.avatar && !members.has(character.avatar)) {
            out.push({ id, character });
        }
    }
    out.sort((a, b) => String(a.character.name || "").localeCompare(String(b.character.name || "")));
    return out;
}

async function addCharacterToCurrentGroup(characterId) {
    const group = getCurrentGroupOrWarn();
    const character = getCharacterById(characterId);
    if (!group || !character?.avatar) {
        return;
    }
    if (group.members.includes(character.avatar)) {
        toastr.info(`${character.name} is already in this group.`);
        return;
    }

    group.members.push(character.avatar);
    await editGroup(group.id, false, false);
    refreshSettingsPanel();
    toastr.success(`Added ${character.name} to the group.`);
}

async function removeCharacterFromCurrentGroup(characterId) {
    const group = getCurrentGroupOrWarn();
    const character = getCharacterById(characterId);
    if (!group || !character?.avatar) {
        return;
    }
    if (!group.members.includes(character.avatar)) {
        toastr.info(`${character.name} is not in this group.`);
        return;
    }

    group.members = group.members.filter(avatar => avatar !== character.avatar);
    if (focusedSpeakerCharacterId === Number(characterId)) {
        focusedSpeakerCharacterId = null;
        focusedSpeakerGroupId = null;
    }
    await editGroup(group.id, false, false);
    refreshSettingsPanel();
    toastr.success(`Removed ${character.name} from the group.`);
}

// Set gmscreen_role on every current group member in one pass.
// value: "npc" | "gm" | "" (clear). exceptCharacterId is skipped (typically
// the GM card you right-clicked).
async function bulkSetGroupRoles(value, exceptCharacterId = null) {
    const context = getContext();
    const members = getGroupMemberCharacters(context);
    if (!members.length) {
        toastr.warning("No group chat is currently open.");
        return;
    }

    const roleValue = value === "gm" || value === "npc" ? value : undefined;
    let changed = 0;
    for (const member of members) {
        if (exceptCharacterId !== null && member.id === Number(exceptCharacterId)) {
            continue;
        }
        await context.writeExtensionField(member.id, "gmscreen_role", roleValue);
        changed++;
    }

    refreshSettingsPanel();
    toastr.success(
        roleValue
            ? `Set ${changed} group member${changed === 1 ? "" : "s"} to ${roleValue.toUpperCase()}.`
            : `Cleared the role on ${changed} group member${changed === 1 ? "" : "s"}.`,
    );
}

// ---- memory summary popup ----

function showMemorySummary(characterId) {
    const character = getCharacterById(characterId);
    if (!character) {
        return;
    }
    const persona = getPersona();
    const store = readStore(character);
    const relationship = store.relationships[persona.key]?.text || "";
    const role = gmscreenRole(character);

    const section = (title, text) => `
        <div class="npc-pov-memory-summary-section">
            <div class="npc-pov-memory-summary-title">${escapeHtml(title)}</div>
            <div class="npc-pov-memory-summary-text">${escapeHtml(text || "(empty)")}</div>
        </div>`;

    const html = `
        <div class="npc-pov-memory-summary">
            <h3>${escapeHtml(character.name)}${role ? ` <small>(${role.toUpperCase()})</small>` : ""}</h3>
            ${section("Autobiography", store.autobiography.text)}
            ${section(`Relationship with ${persona.name}`, relationship)}
            ${getSettings().trackAppearance ? section("Appearance", store.appearance.text) : ""}
            ${section("Secrets and hidden knowledge", store.secrets.text)}
            ${section("Private goals", store.goals.text)}
        </div>`;

    return callGenericPopup(html, POPUP_TYPE.TEXT, "", { wide: true, allowVerticalScrolling: true });
}

// ---- bulk engine: snapshots, undo, apply ----

function snapshotChatForUndo() {
    const context = getContext();
    bulkSnapshots.push(clone(context.chat || []));
    if (bulkSnapshots.length > BULK_SNAPSHOT_CAP) {
        bulkSnapshots.shift();
    }
}

async function undoLastBulkChange() {
    const snapshot = bulkSnapshots.pop();
    if (!snapshot) {
        toastr.info("No bulk change to undo.");
        return;
    }
    const context = getContext();
    context.chat.length = 0;
    for (const message of snapshot) {
        context.chat.push(message);
    }
    await context.saveChat();
    if (typeof context.reloadCurrentChat === "function") {
        await context.reloadCurrentChat();
    }
    toastr.success("Reverted the last bulk change.");
}

function writeMessageText(message, newText) {
    message.mes = newText;
    if (message.swipe_id !== undefined
        && Array.isArray(message.swipes)
        && message.swipes[message.swipe_id] !== undefined) {
        message.swipes[message.swipe_id] = newText;
    }
}

// Apply a list of {index, newText, remove} changes (indices refer to the chat
// as it was when planned). Splices removals from highest index down so earlier
// indices stay valid, saves, and re-renders.
async function applyBulkChanges(changes) {
    if (!changes.length) {
        return;
    }
    const context = getContext();
    const chat = context.chat;
    const sorted = [...changes].sort((a, b) => b.index - a.index);
    let removed = 0;

    for (const change of sorted) {
        const message = chat[change.index];
        if (!message) {
            continue;
        }
        if (change.remove) {
            chat.splice(change.index, 1);
            removed++;
        } else {
            writeMessageText(message, change.newText);
        }
    }

    await context.saveChat();

    if (removed > 0 && typeof context.reloadCurrentChat === "function") {
        await context.reloadCurrentChat();
    } else {
        for (const change of sorted) {
            if (!change.remove && chat[change.index]) {
                updateMessageBlock(change.index, chat[change.index]);
            }
        }
    }
}

// ---- bulk rewrite ----

async function generateRewrittenMessage(systemPrompt, prompt) {
    const context = getContext();
    const settings = getSettings();
    const responseLength = clampNumber(settings.responseLength, 100, 4000, DEFAULT_SETTINGS.responseLength);

    if (typeof context.generateRaw === "function") {
        return await context.generateRaw({ prompt, systemPrompt, responseLength });
    }
    if (typeof context.generateQuietPrompt === "function") {
        return await context.generateQuietPrompt({ quietPrompt: `${systemPrompt}\n\n${prompt}`, responseLength });
    }
    throw new Error("No quiet generation API is available in this SillyTavern build.");
}

async function runBulkRewrite({ scope, instruction }) {
    if (isBulkRunning) {
        toastr.warning("A bulk operation is already running.");
        return;
    }
    const context = getContext();
    const chat = context.chat || [];
    const indices = resolveRewriteScope(chat, scope);
    if (!indices.length) {
        toastr.info("No messages matched that scope.");
        return;
    }

    const persona = getPersona();
    const startLength = chat.length;
    snapshotChatForUndo();
    isBulkRunning = true;
    bulkCancelRequested = false;

    let progressToast = null;
    const showProgress = (done, total) => {
        if (progressToast) {
            toastr.clear(progressToast);
        }
        progressToast = toastr.info(
            `Rewriting ${done}/${total}… click to cancel`,
            "Bulk rewrite",
            { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, onclick: () => { bulkCancelRequested = true; } },
        );
    };

    const changes = [];
    let done = 0;
    try {
        showProgress(0, indices.length);
        // Highest index first so planned indices survive any removals on apply.
        for (const index of [...indices].sort((a, b) => b - a)) {
            if (bulkCancelRequested) {
                break;
            }
            const message = chat[index];
            const original = String(message?.mes ?? "");
            if (!original.trim()) {
                done++;
                showProgress(done, indices.length);
                continue;
            }

            const { system, prompt } = buildRewritePrompt({
                messageText: original,
                instruction,
                userName: persona.name,
            });

            try {
                const raw = await generateRewrittenMessage(system, prompt);
                const cleaned = cleanRewriteOutput(removeReasoningFromString(String(raw ?? "")));
                if (cleaned !== original) {
                    changes.push({ index, newText: cleaned, remove: cleaned === "" });
                }
            } catch (error) {
                console.error(`[NPC POV Memory] Rewrite failed for message ${index}`, error);
            }

            done++;
            showProgress(done, indices.length);
        }

        // If the chat changed while we were generating (new messages, chat
        // switch), the planned indices are stale; applying them would corrupt
        // the wrong messages.
        if (getContext().chat !== chat || chat.length !== startLength) {
            toastr.error("The chat changed while rewriting; no edits were applied.", "Bulk rewrite");
            return;
        }

        await applyBulkChanges(changes);

        const removed = changes.filter(change => change.remove).length;
        const edited = changes.length - removed;
        toastr.success(
            `${bulkCancelRequested ? "Cancelled. " : ""}Processed ${done}/${indices.length}: ${edited} edited, ${removed} removed.`,
            "Bulk rewrite",
        );
    } finally {
        if (progressToast) {
            toastr.clear(progressToast);
        }
        isBulkRunning = false;
        bulkCancelRequested = false;
    }
}

async function openRewriteDialog() {
    const persona = getPersona();
    const content = $(`
        <div class="npc-pov-memory-rewrite-dialog">
            <h3>Rewrite chat history</h3>
            <label>
                <span>Instruction (leave empty to remove places where the AI speaks or acts for ${escapeHtml(persona.name)})</span>
                <textarea id="npc-pov-rw-instruction" class="text_pole" rows="3"
                    placeholder="e.g. Stop making the villain sympathetic"></textarea>
            </label>
            <div class="npc-pov-memory-rewrite-grid">
                <label>
                    <span>Scope</span>
                    <select id="npc-pov-rw-scope" class="text_pole">
                        <option value="lastN" selected>Last N messages</option>
                        <option value="all">Entire chat</option>
                    </select>
                </label>
                <label>
                    <span>N</span>
                    <input id="npc-pov-rw-n" class="text_pole" type="number" min="1" max="500" value="10">
                </label>
                <label>
                    <span>Apply to</span>
                    <select id="npc-pov-rw-filter" class="text_pole">
                        <option value="ai" selected>AI messages only</option>
                        <option value="user">My messages only</option>
                        <option value="all">All messages</option>
                    </select>
                </label>
            </div>
            <small>Each message is rewritten with its own model call. A snapshot is taken first; use "Undo last bulk change" to revert.</small>
        </div>
    `);

    const result = await callGenericPopup(content.get(0), POPUP_TYPE.CONFIRM, "", {
        okButton: "Rewrite",
        cancelButton: "Cancel",
        wide: true,
    });

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const mode = String(content.find("#npc-pov-rw-scope").val() || "lastN");
    const scope = {
        mode,
        n: clampNumber(content.find("#npc-pov-rw-n").val(), 1, 500, 10),
        filter: String(content.find("#npc-pov-rw-filter").val() || "ai"),
    };
    const instruction = String(content.find("#npc-pov-rw-instruction").val() || "");

    await runBulkRewrite({ scope, instruction });
}

// ---- persisted bracket strip ----

async function runPersistBracketStrip() {
    const context = getContext();
    const changes = planBracketStrip(context.chat || []);
    if (!changes.length) {
        toastr.info("No GM/meta bracket tags found in this chat.");
        return;
    }

    const removed = changes.filter(change => change.remove).length;
    const confirmed = await callGenericPopup(
        `Strip GM/meta bracket tags from ${changes.length} message${changes.length === 1 ? "" : "s"}?`
        + (removed ? ` ${removed} tag-only message${removed === 1 ? "" : "s"} will be deleted.` : "")
        + " A snapshot is taken first.",
        POPUP_TYPE.CONFIRM,
    );
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    // Re-plan after the confirm dialog: the chat may have changed while it
    // was open, and stale indices would hit the wrong messages.
    const freshChanges = planBracketStrip(getContext().chat || []);
    if (!freshChanges.length) {
        toastr.info("No GM/meta bracket tags found in this chat.");
        return;
    }
    const freshRemoved = freshChanges.filter(change => change.remove).length;

    snapshotChatForUndo();
    await applyBulkChanges(freshChanges);
    toastr.success(`Stripped brackets from ${freshChanges.length - freshRemoved} messages, removed ${freshRemoved}.`);
}

// ---- portrait from chat image ----

async function setPortraitFromChatImage(characterId, imageUrl) {
    const character = getCharacterById(characterId);
    if (!character?.avatar) {
        return;
    }

    const confirmed = await callGenericPopup(
        `Replace ${escapeHtml(character.name)}'s portrait with this image? This changes the card everywhere, not just this chat.`,
        POPUP_TYPE.CONFIRM,
    );
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    try {
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
            throw new Error(`Could not load image (${imageResponse.status})`);
        }
        const blob = await imageResponse.blob();

        const formData = new FormData();
        formData.append("avatar", blob, "avatar.png");
        formData.append("avatar_url", character.avatar);

        const uploadResponse = await fetch("/api/characters/edit-avatar", {
            method: "POST",
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
        });
        if (!uploadResponse.ok) {
            throw new Error(await uploadResponse.text());
        }

        // Bust caches and refresh every visible copy of this avatar.
        const thumbnailUrl = getThumbnailUrl("avatar", character.avatar);
        await fetch(thumbnailUrl, { method: "GET", cache: "reload" });
        await fetch(`/characters/${character.avatar}`, { method: "GET", cache: "reload" });
        $(`img[src^="${thumbnailUrl}"]`).each(function () {
            const src = this.src;
            this.src = "";
            this.src = src;
        });

        refreshGroupSpeakerBar();
        toastr.success(`Updated ${character.name}'s portrait.`);
    } catch (error) {
        console.error("[NPC POV Memory] Portrait update failed", error);
        toastr.error(String(error), "Portrait update failed");
    }
}

// ---- context menu ----

function closeNpcContextMenu() {
    $("#npc-pov-memory-ctx").remove();
    $(document).off(".npcPovCtx");
}

function renderMenuItems(menu, items) {
    const list = menu.find(".npc-pov-memory-ctx-list");
    list.empty();
    for (const item of items) {
        if (item.separator) {
            list.append($("<div>", { class: "npc-pov-memory-ctx-separator" }));
            continue;
        }
        if (item.header) {
            list.append($("<div>", { class: "npc-pov-memory-ctx-header" }).text(item.header));
            continue;
        }
        if (item.html) {
            list.append(item.html);
            continue;
        }

        const row = $("<div>", { class: "npc-pov-memory-ctx-item" });
        if (item.disabled) {
            row.addClass("npc-pov-memory-ctx-disabled");
        }
        row.append($("<span>", { class: "npc-pov-memory-ctx-label" }).text(item.label));
        if (item.checked) {
            row.append($("<i>", { class: "fa-solid fa-check" }));
        }
        if (item.submenu) {
            row.append($("<i>", { class: "fa-solid fa-chevron-right" }));
        }

        row.on("click", async function (event) {
            event.stopPropagation();
            if (item.disabled) {
                return;
            }
            if (item.submenu) {
                renderMenuItems(menu, item.submenu());
                return;
            }
            closeNpcContextMenu();
            try {
                await item.action?.();
            } catch (error) {
                console.error("[NPC POV Memory] Menu action failed", error);
                toastr.error(String(error));
            }
        });

        list.append(row);
    }

    // Keep the menu inside the viewport after content changes.
    const rect = menu.get(0).getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
        menu.css("top", Math.max(8, window.innerHeight - rect.height - 8));
    }
    if (rect.right > window.innerWidth) {
        menu.css("left", Math.max(8, window.innerWidth - rect.width - 8));
    }
}

function buildPortraitSubmenu(characterId, backItems) {
    return () => {
        const context = getContext();
        const images = collectChatImages(context.chat || []);
        const items = [
            { label: "← Back", submenu: () => backItems() },
            { separator: true },
        ];

        if (!images.length) {
            items.push({ label: "No images in this chat", disabled: true });
            return items;
        }

        for (const image of images.slice(-24).reverse()) {
            const thumb = $("<div>", {
                class: "npc-pov-memory-ctx-item npc-pov-memory-ctx-image",
                title: `Message #${image.messageIndex}${image.name ? ` (${image.name})` : ""}`,
            });
            thumb.append($("<img>", { src: image.url, loading: "lazy" }));
            thumb.append($("<span>").text(`#${image.messageIndex}${image.name ? ` · ${image.name}` : ""}`));
            thumb.on("click", async function (event) {
                event.stopPropagation();
                closeNpcContextMenu();
                await setPortraitFromChatImage(characterId, image.url);
            });
            items.push({ html: thumb });
        }
        return items;
    };
}

function buildAddMemberSubmenu(backItems) {
    return () => {
        const nonMembers = getNonMemberCharacters();
        const items = [
            { label: "← Back", submenu: () => backItems() },
            { separator: true },
        ];

        if (!nonMembers.length) {
            items.push({ label: "Every character is already in this group", disabled: true });
            return items;
        }

        const filterInput = $("<input>", {
            class: "text_pole npc-pov-memory-ctx-filter",
            type: "search",
            placeholder: `Filter ${nonMembers.length} characters…`,
        });
        filterInput.on("click", event => event.stopPropagation());
        filterInput.on("input", function () {
            const query = String($(this).val() || "").toLowerCase();
            $(this).closest(".npc-pov-memory-ctx-list").find(".npc-pov-memory-ctx-add-row").each(function () {
                $(this).toggle($(this).attr("data-name").includes(query));
            });
        });
        items.push({ html: filterInput });

        for (const entry of nonMembers) {
            const name = entry.character.name || `NPC ${entry.id + 1}`;
            const row = $("<div>", {
                class: "npc-pov-memory-ctx-item npc-pov-memory-ctx-add-row",
                "data-name": name.toLowerCase(),
            });
            row.append($("<img>", { src: getCharacterAvatarUrl(entry.character), loading: "lazy" }));
            row.append($("<span>", { class: "npc-pov-memory-ctx-label" }).text(name));
            row.on("click", async function (event) {
                event.stopPropagation();
                closeNpcContextMenu();
                await addCharacterToCurrentGroup(entry.id);
            });
            items.push({ html: row });
        }
        return items;
    };
}

function buildNpcMenuItems(characterId) {
    const context = getContext();
    const character = getCharacterById(characterId, context);
    const persona = getPersona();
    const rawRole = character?.data?.extensions?.gmscreen_role;
    const role = rawRole === "gm" || rawRole === "npc" ? rawRole : "";
    const isFocused = focusedSpeakerIsCurrent(context) && focusedSpeakerCharacterId === Number(characterId);

    const rootItems = () => buildNpcMenuItems(characterId);

    return [
        { header: character?.name || "NPC" },
        {
            label: isFocused ? "Clear focused speaker" : "Focus this speaker",
            action: () => toggleFocusedSpeaker(Number(characterId)),
        },
        {
            label: "Generate image",
            disabled: !getSettings().imagesEnabled,
            action: () => generateImageFor(characterId),
        },
        {
            label: "Set portrait from chat image",
            submenu: buildPortraitSubmenu(characterId, rootItems),
        },
        {
            label: `Card role${role ? ` (${role.toUpperCase()})` : ""}`,
            submenu: () => [
                { label: "← Back", submenu: rootItems },
                { separator: true },
                { label: "Default (unset)", checked: role === "", action: () => setGmscreenRoleFor(characterId, "") },
                { label: "GM / narrator", checked: role === "gm", action: () => setGmscreenRoleFor(characterId, "gm") },
                { label: "NPC", checked: role === "npc", action: () => setGmscreenRoleFor(characterId, "npc") },
            ],
        },
        {
            label: "Bulk roles (group)",
            submenu: () => [
                { label: "← Back", submenu: rootItems },
                { separator: true },
                {
                    label: `Everyone except ${character?.name || "this card"} → NPC`,
                    action: () => bulkSetGroupRoles("npc", Number(characterId)),
                },
                { label: "Everyone → NPC", action: () => bulkSetGroupRoles("npc") },
                { label: "Clear everyone's role", action: () => bulkSetGroupRoles("") },
            ],
        },
        { label: "View memory summary", action: () => showMemorySummary(characterId) },
        {
            label: "Forget memory",
            submenu: () => [
                { label: "← Back", submenu: rootItems },
                { separator: true },
                {
                    label: `Forget relationship with ${persona.name}`,
                    action: async () => {
                        const ok = await callGenericPopup(
                            `Forget ${escapeHtml(character?.name || "this NPC")}'s relationship memory for ${escapeHtml(persona.name)}?`,
                            POPUP_TYPE.CONFIRM,
                        );
                        if (ok === POPUP_RESULT.AFFIRMATIVE) {
                            await forgetRelationshipFor(characterId);
                        }
                    },
                },
                {
                    label: "Forget all memory",
                    action: async () => {
                        const ok = await callGenericPopup(
                            `Forget ALL NPC POV memory stored on ${escapeHtml(character?.name || "this card")}?`,
                            POPUP_TYPE.CONFIRM,
                        );
                        if (ok === POPUP_RESULT.AFFIRMATIVE) {
                            await forgetAllFor(characterId);
                        }
                    },
                },
            ],
        },
        { label: "Remove from group", action: () => removeCharacterFromCurrentGroup(characterId) },
        { separator: true },
        { label: "Add character to group", submenu: buildAddMemberSubmenu(rootItems) },
        { label: "Rewrite history…", disabled: isBulkRunning, action: () => openRewriteDialog() },
        { label: "Strip GM brackets from history", disabled: isBulkRunning, action: () => runPersistBracketStrip() },
        { label: "Undo last bulk change", disabled: !bulkSnapshots.length, action: () => undoLastBulkChange() },
    ];
}

function openNpcContextMenu(characterId, x, y) {
    closeNpcContextMenu();

    const menu = $("<div>", { id: "npc-pov-memory-ctx" });
    menu.append($("<div>", { class: "npc-pov-memory-ctx-list" }));
    menu.css({ left: x, top: y });
    $(document.body).append(menu);

    renderMenuItems(menu, buildNpcMenuItems(characterId));

    $(document).on("mousedown.npcPovCtx", function (event) {
        if (!menu.get(0).contains(event.target)) {
            closeNpcContextMenu();
        }
    });
    $(document).on("keydown.npcPovCtx", function (event) {
        if (event.key === "Escape") {
            closeNpcContextMenu();
        }
    });
}

// ============================================================
// Image generation (raw narration + stored appearance)
//
// Deliberately does NOT run the message through a tagger LLM. Krea 2's
// encoder reads prose directly, and it is no better or worse than a tagger
// at inventing framing and lighting the transcript never stated, so the
// extra hop only adds latency and a place to lose detail. What the tagger
// cannot supply and this can: the character's stored appearance, which is
// stable across renders and changes only when the story changes it.
// ============================================================

/** Resolve the message this render should illustrate. */
function findIllustratableMessage(context, messageIndex) {
    const chat = context.chat || [];
    if (Number.isInteger(messageIndex) && chat[messageIndex]) {
        return chat[messageIndex];
    }
    return [...chat].reverse().find(message => message && !message.is_user && !message.is_system) || null;
}

/**
 * Work out who should be in frame: the subject, plus any other group member
 * named in the narration. Returns [{ name, text }] for composeImagePrompt,
 * with characters that have no stored appearance included as empty entries
 * (composeImagePrompt drops them).
 */
function collectAppearances(subjectId, narration, context) {
    const entries = [];
    const seen = new Set();

    const push = (characterId) => {
        const character = getCharacterById(characterId, context);
        if (!character || seen.has(character.avatar)) {
            return;
        }
        seen.add(character.avatar);
        entries.push({
            name: character.name || "",
            text: readStore(character).appearance.text || "",
        });
    };

    push(subjectId);

    const members = getGroupMemberCharacters(context);
    if (members.length) {
        const names = members.map(member => member.character?.name).filter(Boolean);
        const mentioned = findMentionedCharacters(narration, names);
        for (const name of mentioned) {
            const member = members.find(item => item.character?.name === name);
            if (member) {
                push(member.id);
            }
        }
    }

    return entries;
}

/** Build the prose prompt for one render, or "" if there is nothing to draw. */
function buildImagePromptFor(characterId, message, context = getContext()) {
    const settings = getSettings();
    // Meta/GM bracket tags are instructions, not things a camera can see.
    const narration = stripDialogue(stripStandaloneBrackets(String(message?.mes ?? "")));
    if (!narration) {
        return "";
    }

    return composeImagePrompt({
        appearances: collectAppearances(characterId, narration, context),
        narration,
        styleSuffix: settings.imageStyleSuffix,
    });
}

/**
 * Attach a finished image to a message.
 *
 * The message is located by identity rather than by index, because the user
 * may have sent several more messages while the render was queued. Writes
 * extra.media[], which is the current format; the legacy extra.image field is
 * migrated away and silently dropped by SillyTavern.
 */
function attachImageToMessage(message, url, prompt) {
    const context = getContext();
    const index = context.chat.indexOf(message);
    if (index === -1) {
        return; // message was deleted, or the chat was switched
    }

    if (!message.extra) {
        message.extra = {};
    }
    if (!Array.isArray(message.extra.media)) {
        message.extra.media = [];
    }
    message.extra.media.push({
        url,
        type: MEDIA_TYPE.IMAGE,
        title: prompt,
        source: MEDIA_SOURCE.GENERATED,
    });
    message.extra.media_display = MEDIA_DISPLAY.GALLERY;
    message.extra.media_index = message.extra.media.length - 1;
    message.extra.title = prompt;

    const element = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (element) {
        appendMediaToMessage(message, $(element));
    }
    context.saveChat();
}

/**
 * Generate an illustration of `characterId` in the scene described by a
 * message. Never awaited by callers that must stay responsive; the render
 * itself is serialised by comfy.js's queue.
 */
async function generateImageFor(characterId, { messageIndex = null, silent = false } = {}) {
    const settings = getSettings();
    if (!settings.imagesEnabled) {
        if (!silent) {
            toastr.warning("Image generation is turned off in NPC POV Memory settings.");
        }
        return;
    }

    const context = getContext();
    const character = getCharacterById(characterId, context);
    const message = findIllustratableMessage(context, messageIndex);
    if (!character || !message) {
        if (!silent) {
            toastr.warning("Nothing to illustrate yet.");
        }
        return;
    }

    const prompt = buildImagePromptFor(characterId, message, context);
    if (!prompt) {
        if (!silent) {
            toastr.info("That message has no visual narration to draw.");
        }
        return;
    }

    const seed = settings.imageSeedMode === "character"
        ? stableSeedFrom(character.avatar || character.name || "")
        : Math.floor(Math.random() * 2 ** 32);

    const queued = getQueueDepth();
    if (!silent) {
        toastr.info(
            queued ? `Queued behind ${queued} render${queued === 1 ? "" : "s"}.` : "Generating…",
            `Image: ${character.name}`,
        );
    }
    console.debug(`[NPC POV Memory] image prompt for ${character.name}:`, prompt);

    try {
        const result = await enqueueRender(() => renderImage({
            comfyUrl: settings.imageComfyUrl,
            workflow: settings.imageWorkflow,
            prompt,
            seed,
            steps: clampNumber(settings.imageSteps, 1, 60, DEFAULT_SETTINGS.imageSteps),
            width: clampNumber(settings.imageWidth, 256, 2048, DEFAULT_SETTINGS.imageWidth),
            height: clampNumber(settings.imageHeight, 256, 2048, DEFAULT_SETTINGS.imageHeight),
        }));

        const url = await saveBase64AsFile(
            result.data,
            character.name || "image",
            humanizedDateTime(),
            result.format,
        );
        attachImageToMessage(message, url, prompt);
    } catch (error) {
        console.error("[NPC POV Memory] Image generation failed", error);
        toastr.error(String(error.message ?? error), "Image generation failed");
    }
}

/** Auto-generate after a character message, when enabled. */
function onMessageForImage(messageId) {
    const settings = getSettings();
    if (!settings.imagesEnabled || !settings.imagesAuto) {
        return;
    }

    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message || message.is_user || message.is_system) {
        return;
    }

    const characterId = findCharacterIdForMessage(message, context);
    if (characterId === null) {
        return;
    }

    // Not awaited: the event handler returns immediately and chat stays usable.
    generateImageFor(characterId, { messageIndex: Number(messageId), silent: true });
}
