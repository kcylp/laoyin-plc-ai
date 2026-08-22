'use strict';

function normalizeSelectedModels(models) {
    const seen = new Set();
    const normalized = [];

    for (const model of Array.isArray(models) ? models : []) {
        const id = String(model && model.id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const rawContextLength = model.context_length ?? model.contextLength ?? null;
        const parsedContextLength = Number(rawContextLength);
        normalized.push({
            id,
            label: String(model.label || id),
            context_length: Number.isFinite(parsedContextLength) && parsedContextLength > 0
                ? Math.trunc(parsedContextLength)
                : null,
            enabled: 1,
        });
    }

    return normalized;
}

function getWorkbenchModelId(providerId, models) {
    const pid = String(providerId == null ? '' : providerId).trim();
    const firstModelId = String(models && models[0] && models[0].id || '').trim();
    if (!pid || !firstModelId) return null;
    return `db${pid}/${firstModelId}`;
}

function prioritizeSelectedModels(models, preferredModelId) {
    const normalized = normalizeSelectedModels(models);
    const preferred = String(preferredModelId == null ? '' : preferredModelId).trim();
    if (!preferred) return normalized;

    const index = normalized.findIndex(model => model.id === preferred);
    if (index <= 0) return normalized;
    return [normalized[index], ...normalized.slice(0, index), ...normalized.slice(index + 1)];
}

function getInitialModelId(models, selectedIds, savedModelId) {
    const available = (Array.isArray(models) ? models : [])
        .map(model => String(model && (model.id || model.model_id) || '').trim())
        .filter(Boolean);
    if (!available.length) return null;

    const saved = String(savedModelId == null ? '' : savedModelId).trim();
    if (saved && available.includes(saved)) return saved;

    const selected = new Set((Array.isArray(selectedIds) ? selectedIds : [])
        .map(id => String(id == null ? '' : id).trim())
        .filter(Boolean));
    return available.find(id => selected.has(id)) || available[0];
}

const aiModelsApi = {
    normalizeSelectedModels,
    getWorkbenchModelId,
    prioritizeSelectedModels,
    getInitialModelId,
};

if (typeof module !== 'undefined' && module.exports) module.exports = aiModelsApi;
if (typeof window !== 'undefined') window.AiModels = aiModelsApi;
