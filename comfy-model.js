// Apply an optional model override to the request, never to the saved workflow.
export function applyComfyModel(workflowText, model = "") {
    if (!model) return workflowText;
    if (workflowText.includes('"%model%"')) {
        return workflowText.replaceAll('"%model%"', JSON.stringify(model));
    }
    const workflow = JSON.parse(workflowText);
    const targets = [];
    for (const node of Object.values(workflow)) {
        for (const field of ["ckpt_name", "unet_name"]) {
            if (typeof node?.inputs?.[field] === "string") targets.push({ node, field });
        }
    }
    if (targets.length !== 1) {
        throw new Error('This workflow needs a "%model%" placeholder on the intended model loader, or select "Use workflow model".');
    }
    targets[0].node.inputs[targets[0].field] = model;
    return JSON.stringify(workflow);
}
