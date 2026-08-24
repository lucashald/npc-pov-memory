// ComfyUI client for the image-generation feature.
//
// Requests go through SillyTavern's own Stable Diffusion proxy endpoints
// rather than to ComfyUI directly, which avoids CORS and reuses the workflow
// files already stored under the user's comfyWorkflows directory.
//
// Everything is funnelled through a single-flight queue: one render at a time.
// A single 8GB card thrashes VRAM when several generations overlap, so
// concurrency here makes every job slower rather than finishing any sooner.

import { getRequestHeaders } from "../../../../script.js";

let queueTail = Promise.resolve();
let queueDepth = 0;

/** How many renders are queued or running, for UI feedback. */
export function getQueueDepth() {
    return queueDepth;
}

/**
 * Run `task` after every previously queued task has settled.
 * Failures do not break the chain.
 */
export function enqueueRender(task) {
    queueDepth++;
    const run = queueTail.then(task, task);
    queueTail = run.then(
        () => { queueDepth--; },
        () => { queueDepth--; },
    );
    return run;
}

/**
 * Fetch a workflow file by name.
 *
 * The endpoint returns the file as a JSON-encoded string, so .json() already
 * yields the raw workflow text. Parsing it again would produce an object and
 * break the %placeholder% substitution below.
 */
export async function loadWorkflow(name) {
    const response = await fetch("/api/sd/comfy/workflow", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ file_name: name }),
    });
    if (!response.ok) {
        throw new Error(`Could not load ComfyUI workflow "${name}".`);
    }
    return response.json();
}

/**
 * Substitute the %placeholders% a workflow declares.
 *
 * Only tokens actually present in the file are replaced, so a workflow
 * without %negative_prompt% (Krea2_Turbo.json, for one) is left alone
 * rather than silently gaining an unused field.
 */
export function applyWorkflowSubstitutions(workflowText, values) {
    let text = String(workflowText);
    for (const [key, value] of Object.entries(values)) {
        const token = `"%${key}%"`;
        if (text.includes(token)) {
            text = text.replaceAll(token, typeof value === "string" ? JSON.stringify(value) : String(value));
        }
    }
    return text;
}

/**
 * Render one image. Resolves to { format, data } where data is base64.
 * Callers should wrap this in enqueueRender().
 */
export async function renderImage({ comfyUrl, workflow, prompt, seed, steps, width, height }) {
    const workflowText = applyWorkflowSubstitutions(await loadWorkflow(workflow), {
        prompt,
        negative_prompt: "",
        seed,
        steps,
        width,
        height,
    });

    // The proxy forwards `prompt` to ComfyUI verbatim, so it has to be the
    // complete request body: the workflow wrapped in a "prompt" key.
    const response = await fetch("/api/sd/comfy/generate", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({
            url: comfyUrl,
            prompt: `{"prompt": ${workflowText}}`,
        }),
    });

    if (!response.ok) {
        throw new Error(`ComfyUI error: ${await response.text()}`);
    }
    return response.json();
}
