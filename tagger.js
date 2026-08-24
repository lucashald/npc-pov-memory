// Tagger client: run the {system, user} pair from buildTaggerPrompt through an
// LLM and return the raw reply text. Two sources:
//
//   "endpoint" - a separate OpenAI-compatible server via fetch(). Does not
//                touch SillyTavern's generation lock, so the chat stays usable
//                while the tagger and then the image both run.
//   "main"     - the active chat model via generateQuietPrompt(). Simpler to
//                configure, but queues behind chat replies.
//
// Cleaning is the caller's job (cleanTaggerOutput), so this module stays a thin
// transport and is easy to reason about.

import { generateQuietPrompt } from "../../../../script.js";

/** Salvage tags from a reasoning-only reply (empty content, filled reasoning). */
function pickContent(message) {
    const content = String(message?.content ?? "").trim();
    if (content) {
        return content;
    }
    return String(message?.reasoning_content ?? "").trim();
}

export async function runTagger({ source, url, model, maxTokens, temperature, system, user }) {
    if (source === "main") {
        const reply = await generateQuietPrompt({
            quietPrompt: `${system}\n\n${user}`,
            skipWIAN: true,
            responseLength: maxTokens,
            removeReasoning: true,
        });
        return String(reply ?? "");
    }

    if (!url) {
        throw new Error("No tagger endpoint URL is set.");
    }

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: model || undefined,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
            temperature: typeof temperature === "number" ? temperature : 0.4,
            max_tokens: maxTokens,
            // Honoured by some servers, ignored by others; harmless either way.
            chat_template_kwargs: { enable_thinking: false },
        }),
    });

    if (!response.ok) {
        throw new Error(`Tagger returned HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    return pickContent(data?.choices?.[0]?.message);
}
