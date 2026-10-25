export const colorModeNames = {
  detail: '细节优先', accurate: '原色近似', legacy: '旧版配色',
};

export function createColorControls({onPaletteChange, onPreviewChange}) {
  const element = document.createElement('div');
  element.className = 'color-controls';
  element.innerHTML = `
    <div class="color-controls-main">
      <label class="palette-mode-label">配色
        <select id="color-mode" aria-label="配色方式">
          <option value="detail">细节优先（推荐）</option>
          <option value="accurate">原色近似</option>
          <option value="legacy">旧版配色 · 对照</option>
        </select>
      </label>
      <div class="color-preview-switch" role="group" aria-label="预览效果">
        <button type="button" data-color-preview="accurate" aria-pressed="true">原色检查</button>
        <button type="button" data-color-preview="physical" aria-pressed="false">实物效果</button>
      </div>
    </div>
    <div class="color-controls-details">
      <label class="mix-label" title="在同一个原版像素内部组合豆色，不跨像素扩散">
        <input id="mix-pixels" type="checkbox" disabled> 2×2 像素内混色
      </label>
      <span id="color-mode-help">保留相邻像素的深浅差 · 混色需选择 2×2 豆</span>
    </div>`;
  document.querySelector('.model-toolbar').after(element);
  const selector = element.querySelector('#color-mode');
  const mixture = element.querySelector('#mix-pixels');
  const help = element.querySelector('#color-mode-help');
  selector.addEventListener('change', () => {
    if (selector.value === 'legacy') mixture.checked = false;
    onPaletteChange({colorMode: selector.value, mix2x2: mixture.checked});
  });
  mixture.addEventListener('change', () => onPaletteChange({colorMode: selector.value, mix2x2: mixture.checked}));
  element.querySelectorAll('[data-color-preview]').forEach(button => {
    button.addEventListener('click', () => onPreviewChange(button.dataset.colorPreview));
  });
  return {
    sync({colorMode = 'detail', mix2x2 = false, scale = 1, previewMode = 'accurate'}) {
      selector.value = colorMode;
      mixture.disabled = scale !== 2 || colorMode === 'legacy';
      mixture.checked = !mixture.disabled && mix2x2;
      mixture.closest('label').classList.toggle('disabled', mixture.disabled);
      const description = colorMode === 'detail' ? '保留相邻像素的深浅差' : colorMode === 'accurate' ? '按人眼色差选择最近的豆色' : '使用之前的逐像素配色，方便对照';
      help.textContent = description + (mixture.checked ? ' · 仅在每个像素内部混色' : scale !== 2 ? ' · 混色需选择 2×2 豆' : '');
      element.querySelectorAll('[data-color-preview]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.colorPreview === previewMode));
      });
      const tag = document.querySelector('.scene-tag');
      tag.innerHTML = previewMode === 'accurate'
        ? '<i></i> MARD 原色检查 <span>无光照偏色 · 中空豆孔</span>'
        : '<i></i> 拼豆实物效果 <span>中性光照 · 哑光塑料</span>';
    },
  };
}
