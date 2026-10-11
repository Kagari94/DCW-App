const definitions = [
    { type: 'function', function: { name: 'list_outfits',
        description: 'List the selected companion\'s saved outfits and the current outfit. Use before changing clothes to get the exact outfit ID.',
        parameters: { type: 'object', properties: {}, additionalProperties: false } } },
    { type: 'function', function: { name: 'change_outfit',
        description: 'Change the selected companion\'s outfit. Use an ID from list_outfits, only when the user asks or agrees to a change.',
        parameters: { type: 'object', properties: { outfit_id: { type: 'string', description: 'Exact ID from list_outfits.' } },
            required: ['outfit_id'], additionalProperties: false } } },
];
function createOutfitTools({ characters = require('../../lib/characters'), getSettings = require('../../settings').getSettings } = {}) {
    function selected(config) {
        const id = config?.characterId || config?.currentCharacter;
        if (!id || getSettings().currentCharacter !== id) throw new Error('Selected companion changed. Try again.');
        const character = characters.readCharacter(id);
        if (!character || character.legacy) throw new Error('Create a saved companion in the Model tab to use outfits.');
        return character;
    }
    const handlers = {
        list_outfits(_args, config) {
            const character = selected(config);
            return { current_outfit_id: character.activeOutfit,
                outfits: character.outfits.filter(outfit => outfit.available).map(({ id, name }) => ({ id, name })) };
        },
        change_outfit({ outfit_id }, config) {
            const character = selected(config);
            const updated = characters.selectOutfit(character.id, outfit_id);
            return { changed: true, outfit: updated.outfits.find(outfit => outfit.id === updated.activeOutfit).name,
                ui: { window: 'outfits', action: 'change', characterId: character.id } };
        },
    };
    return { definitions, handlers, source: 'Companion' };
}
module.exports = { ...createOutfitTools(), createOutfitTools };
