// Apply an optional model override to the request, never to the saved workflow.
export function applyComfyModel(workflowText, model = "") {
    if (!model) return workflowText;
    const workflow = JSON.parse(workflowText);
    const family = name => /krea[-_ ]?2/i.test(name) ? "Krea 2" : /anima/i.test(name) ? "Anima" : null;
    const selectedFamily = family(model);
    for (const node of Object.values(workflow)) {
        const expected = node?.class_type === "CLIPLoader" && node.inputs?.type === "krea2"
            ? "Krea 2" : family(node?.inputs?.unet_name || node?.inputs?.ckpt_name || "");
        if (expected && selectedFamily && expected !== selectedFamily) {
            throw new Error(`Cannot use a ${selectedFamily} model in this ${expected} workflow. Select a matching workflow or Use workflow model.`);
        }
    }
    if (workflowText.includes('"%model%"')) {
        return workflowText.replaceAll('"%model%"', JSON.stringify(model));
    }
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
