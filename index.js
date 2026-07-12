import { extension_settings, getContext } from "../../../extensions.js";
import {
    Generate,
    default_avatar,
    extension_prompt_roles,
    extension_prompt_types,
    getThumbnailUrl,
} from "../../../../script.js";
import { removeReasoningFromString } from "../../../reasoning.js";
import {
    editGroup,
    group_activation_strategy,
    groups,
    selected_group,
} from "../../../group-chats.js";
import { gmscreenRole, stripStandaloneBrackets } from "./gmscreen.js";

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
        relationships: {},
    };
}

function normalizeStore(rawStore) {
    const store = Object.assign(makeEmptyStore(), rawStore || {});
    store.autobiography = Object.assign(makeEmptyStore().autobiography, store.autobiography || {});
    store.autobiography.lastMessageIndexByChat = store.autobiography.lastMessageIndexByChat || {};
    store.secrets = Object.assign(makeEmptyStore().secrets, store.secrets || {});
    store.goals = Object.assign(makeEmptyStore().goals, store.goals || {});
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

function buildUpdateSystemPrompt(characterName, personaName, maxWords) {
    return [
        "You maintain private memory for one NPC in a SillyTavern roleplay.",
        `NPC: ${characterName}`,
        `Current user persona: ${personaName}`,
        "",
        "Update four private memory fields from the new transcript.",
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
        "- If the new scene appears separate from earlier memories, say that it seems to be a separate encounter or later time.",
        `- Keep each field concise, no more than about ${maxWords} words.`,
        "",
        "Return JSON only, with exactly these keys:",
        "{\"autobiography\":\"...\",\"relationship\":\"...\",\"secrets\":\"...\",\"goals\":\"...\"}",
    ].join("\n");
}

function buildUpdateUserPrompt(character, persona, store, relationship, messages) {
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
        "New transcript:",
        formatTranscript(messages, persona.name),
    ].join("\n");
}

function parseJsonResponse(text) {
    const cleaned = removeReasoningFromString(String(text || "")).trim();
    const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced
        ? fenced[1].trim()
        : cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1);

    if (!candidate) {
        throw new Error("The model did not return a JSON object.");
    }

    const parsed = JSON.parse(candidate);
    return {
        autobiography: String(parsed.autobiography || "").trim(),
        relationship: String(parsed.relationship || "").trim(),
        secrets: String(parsed.secrets || "").trim(),
        goals: String(parsed.goals || "").trim(),
    };
}

async function generateMemoryUpdate(systemPrompt, userPrompt) {
    const context = getContext();
    const settings = getSettings();
    const responseLength = clampNumber(settings.responseLength, 100, 4000, DEFAULT_SETTINGS.responseLength);

    if (typeof context.generateRaw === "function") {
        const raw = await context.generateRaw({
            prompt: userPrompt,
            systemPrompt,
            responseLength,
        });
        return parseJsonResponse(raw);
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
    const systemPrompt = buildUpdateSystemPrompt(character.name, persona.name, maxWords);
    const userPrompt = buildUpdateUserPrompt(character, persona, store, relationship, summaryMessages);

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
    const context = getContext();
    const characterId = getSettingsCharacterId(context);
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
    const context = getContext();
    const characterId = getSettingsCharacterId(context);
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
    store.secrets.updatedAt = updatedAt;
    store.goals.updatedAt = updatedAt;

    return writeStore(characterId, store).then(() => {
        setInjectedMemory(characterId);
        refreshSettingsPanel();
        toastr.success(`Saved private notes for ${character.name}.`);
    });
}

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
