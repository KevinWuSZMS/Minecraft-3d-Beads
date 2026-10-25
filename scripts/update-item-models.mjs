// Targeted migration: preserve existing block/entity geometry and corrected
// source UVs while updating item metadata from the untouched vanilla JSON.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {IN_HAND_MODELS,resolveItemModel} from '../public/src/item-models.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=async relative=>JSON.parse((await fs.readFile(path.join(root,relative),'utf8')).replace(/^\uFEFF/,''));
const write=async(relative,value)=>{const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value)+'\n')};
const catalog=await read('public/data/catalog.json'),entities=await read('public/data/entities.json');
const items=catalog.entries.filter(entry=>entry.kind==='item');
const displays=new Map();
async function inheritedDisplay(key){
  key=key.replace(/^minecraft:/,'');
  if(key.startsWith('builtin/'))return {};
  if(displays.has(key))return displays.get(key);
  const source=await read('public/minecraft/models/'+key+'.json');
  const display={...(source.parent?await inheritedDisplay(source.parent):{}),...(source.display||{})};
  displays.set(key,display);return display;
}
const itemModels={};
for(const entry of items){
  const id=entry.id.replace('minecraft:','');
  if(IN_HAND_MODELS[id]){entry.handheldModel=IN_HAND_MODELS[id];entry.handheldModelSource='Java 1.21.1 ItemRenderer.getModel'}
  if(!entry.model)continue;
  const model=await read('public'+entry.model);
  const display=await inheritedDisplay('item/'+id);
  if(Object.keys(display).length)model.display=display;
  await write('public'+entry.model,model);
  if(['barrier','light','structure_void'].includes(id)){
    entry.status='generated';entry.renderType='generated';
    entry.note='使用原版手持物品图标；对应放置方块本身不可见。';
  }
  const handSource=entry.handheldModel?await read('public'+entry.handheldModel):model;
  if(handSource.renderType==='special'&&entities.specialModels?.[id]?.elements?.length)itemModels[id]=id;
}
entities.itemModels=itemModels;
catalog.coverage.item=Object.fromEntries([...new Set(items.map(entry=>entry.status))].map(status=>[status,items.filter(entry=>entry.status===status).length]));
await write('public/data/catalog.json',catalog);
await write('public/data/entities.json',entities);
const importReport=await read('public/minecraft/import-report.json');
importReport.coverage.item=catalog.coverage.item;
importReport.invisibleEntries=catalog.entries.filter(entry=>entry.status==='invisible').map(entry=>entry.key);
await write('public/minecraft/import-report.json',importReport);
const entityReport=await read('docs/entity-coverage.json');entityReport.itemModels=itemModels;
await write('docs/entity-coverage.json',entityReport);
const routes={},entries=[],errors=[];
for(const entry of items){
  try{const result=await resolveItemModel(entry,entities,url=>read('public'+url));routes[result.itemRoute]=(routes[result.itemRoute]||0)+1;entries.push({key:entry.key,route:result.itemRoute,source:result.model.itemModelSource,specialLayer:result.model.sourceLayer||null})}
  catch(error){const route=error.code==='ITEM_INVISIBLE'?'invisible':'unavailable';routes[route]=(routes[route]||0)+1;entries.push({key:entry.key,route,note:error.message});if(route==='unavailable')errors.push(entry.key+': '+error.message)}
}
const report={version:'Java 1.21.1',registeredItems:items.length,routes,customItemMappings:Object.keys(itemModels).length,
  sourceEvidence:['ItemRenderer.getModel chooses trident_in_hand and spyglass_in_hand.','ItemRenderer.render only substitutes inventory sprites for GUI/GROUND/FIXED.','BlockEntityWithoutLevelRenderer.renderByItem handles skulls, banners, beds, conduit, chests, decorated pots, shulker boxes, shield and trident.'],
  limits:['默认未使用、未拉弓、未阻挡姿态；组件、染色、纹样和自定义玩家头颅不是全部变种。','手持 display 保留为 itemDisplay 元数据，未写入体素几何，避免改变豆格和图纸。','此项验证检查所有物品的原版模型路由，不代表全部图纸经过实物装配。'],entries,errors};
await write('docs/item-model-coverage.json',report);
console.log(JSON.stringify({registeredItems:items.length,routes,customItemMappings:Object.keys(itemModels).length,errors},null,2));
if(errors.length)process.exitCode=1;
