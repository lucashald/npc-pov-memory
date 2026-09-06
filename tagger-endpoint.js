// OpenAI-compatible endpoint helpers, independent of SillyTavern.
export function taggerEndpointUrls(value) {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Use an HTTP or HTTPS endpoint URL.");
    }
    const path = url.pathname.replace(/\/+$/, "");
    const base = /\/chat\/completions$/.test(path)
        ? path.replace(/\/chat\/completions$/, "")
        : path || "/v1";
    url.hash = "";
    url.pathname = `${base}/models`;
    const models = url.href;
    url.pathname = `${base}/chat/completions`;
    return { models, completions: url.href };
}

export async function fetchTaggerModels(url, { signal } = {}) {
    const response = await fetch(taggerEndpointUrls(url).models, { signal });
    if (!response.ok) {
        throw new Error(`Model list returned HTTP ${response.status}.`);
    }
    const body = await response.json();
    if (!Array.isArray(body?.data)) {
        throw new Error("Expected a model list with a data array.");
    }
    return [...new Set(body.data.map(item => item?.id)
        .filter(id => typeof id === "string" && id.trim()))].sort();
}
