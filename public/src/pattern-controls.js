export const patternModeNames={shell:'立体拼插',faces:'完整纹理面',item:'手持物品'};

export function createPatternControls(onChange){
  const element=document.createElement('div');
  element.className='pattern-controls';
  element.innerHTML=`<label id="pattern-mode-label">方块图纸
    <select id="pattern-mode" aria-label="方块图纸模式">
      <option value="shell">立体拼插</option><option value="faces">完整纹理面</option>
    </select></label>
    <label class="clear-bead-label"><input id="fill-transparent" type="checkbox"> 透明区域填 H01</label>
    <span id="pattern-help"></span>`;
  document.querySelector('.color-controls').after(element);
  const mode=element.querySelector('#pattern-mode');
  const fill=element.querySelector('#fill-transparent');
  const changed=()=>onChange({blockPattern:mode.value,fillTransparent:fill.checked});
  mode.addEventListener('change',changed);
  fill.addEventListener('change',changed);
  return {sync({current,blockPattern='shell',fillTransparent=false}){
    mode.value=blockPattern;
    fill.checked=fillTransparent;
    element.querySelector('#pattern-mode-label').hidden=current?.kind!=='block';
    element.querySelector('#pattern-help').textContent=(current?.kind==='block'&&blockPattern==='faces'
      ?'相同纹理合并 · 保留完整像素，不留插孔'
      :current?.kind==='item'?'使用原版手持物品形态':'拼插边缘保留凸齿与空槽')
      +(fillTransparent?' · H01 为透明豆，图案背景也会填充':' · H01 为透明豆，白色使用 H02');
  }};
}
