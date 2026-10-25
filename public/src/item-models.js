// Java 1.21.1 ItemRenderer.getModel explicitly chooses these two models in
// hand. render() switches them back to item sprites only for GUI/GROUND/FIXED.
export const IN_HAND_MODELS = Object.freeze({
  trident: '/minecraft/models-resolved/item/trident_in_hand.json',
  spyglass: '/minecraft/models-resolved/item/spyglass_in_hand.json',
});

function displayFor(model) {
  const transform = model.display?.thirdperson_righthand || {};
  return {
    context: 'thirdperson_righthand',
    rotation: [...(transform.rotation || [0, 0, 0])],
    translation: [...(transform.translation || [0, 0, 0])],
    scale: [...(transform.scale || [1, 1, 1])],
    sourceModel: model.sourceModel,
  };
}

/**
 * Resolve an item in its default held form, independently of placed blocks
 * and world entities. loadJson(url) returns a parsed local JSON model.
 * itemDisplay is presentation metadata only: do not bake it into voxelization.
 */
export async function resolveItemModel(entry, entities, loadJson) {
  if (entry?.kind !== 'item') throw new TypeError('resolveItemModel 只接受物品目录项。');
  const id = entry.id.replace('minecraft:', '');
  const override = entry.handheldModel || IN_HAND_MODELS[id];
  const sourcePath = override || entry.model;
  if (!sourcePath) throw new Error('此物品没有原版物品模型路径。');
  const source = await loadJson(sourcePath);
  const itemDisplay = displayFor(source);
  const isVisibleJson = Boolean(source.elements?.length || source.layers?.length);
  // Ordinary generated/handheld and block-item JSON always wins. A matching
  // boat, minecart, sign, bell, or other world-model name is not an item alias.
  if (isVisibleJson) {
    const itemRoute = override ? 'handheld-json' : source.elements?.length ? 'item-elements' : 'item-generated';
    return {
      model: {...source, itemDisplay, itemModelSource: sourcePath},
      itemDisplay,
      itemRoute,
      note: override ? '使用原版默认手持模型。' : undefined,
    };
  }
  if (id === 'air') {
    const error = new Error('空气物品没有可见的手持表面，因此没有可制作的拼豆图纸。');
    error.code = 'ITEM_INVISIBLE';
    throw error;
  }
  // Only a genuinely custom-rendered ITEM model reaches this branch. Java's
  // BlockEntityWithoutLevelRenderer also renders beds/chests/skulls in hand.
  const specialKey = entities.itemModels?.[id] || id;
  const geometry = entities.specialModels?.[specialKey];
  if (source.renderType !== 'special' || !geometry?.elements?.length) {
    throw new Error('此物品需要原版专用手持渲染模型，目前没有可用的对应数据。');
  }
  const note = geometry.note || '使用原版专用物品渲染器的默认静态形态。';
  return {
    model: {
      ...geometry,
      display: source.display || {},
      gui_light: source.gui_light,
      overrides: source.overrides || [],
      sourceModel: source.sourceModel,
      itemModelSource: sourcePath,
      itemDisplay,
      itemRenderer: 'BlockEntityWithoutLevelRenderer',
    },
    itemDisplay,
    itemRoute: override ? 'handheld-special' : 'item-special',
    note,
  };
}
