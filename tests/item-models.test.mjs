import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {IN_HAND_MODELS,resolveItemModel} from '../public/src/item-models.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=async relative=>JSON.parse(await fs.readFile(path.join(root,relative),'utf8'));
const catalog=await read('public/data/catalog.json'),entities=await read('public/data/entities.json');
const entry=id=>catalog.entries.find(value=>value.key==='item/'+id);
const loadJson=url=>read('public'+url);
const resolve=id=>resolveItemModel(entry(id),entities,loadJson);

test('boats, rafts, minecarts, signs and bells use their own held item sprites',async()=>{
  const ids=['oak_boat','mangrove_chest_boat','bamboo_raft','bamboo_chest_raft','minecart','chest_minecart','furnace_minecart','tnt_minecart','hopper_minecart','command_block_minecart','oak_sign','mangrove_hanging_sign','bell'];
  for(const id of ids){
    const {model,itemRoute}=await resolve(id);
    assert.equal(itemRoute,'item-generated',id);
    assert.equal(model.elements.length,0,id);
    assert.equal(model.layers[0],`/minecraft/textures/item/${id}.png`,id);
    assert.equal(model.sourceModel,`minecraft:item/${id}`,id);
    assert.equal(entities.itemModels[id],undefined,`${id} must not alias a placed entity`);
  }
});

test('ordinary item JSON wins even if obsolete world aliases are injected',async()=>{
  const id='mangrove_chest_boat',fake={...entities,itemModels:{...entities.itemModels,[id]:'chest'}};
  const result=await resolveItemModel(entry(id),fake,loadJson);
  assert.equal(result.itemRoute,'item-generated');
  assert.equal(result.model.layers[0],'/minecraft/textures/item/mangrove_chest_boat.png');
  assert.equal(result.model.sourceLayer,undefined);
});

test('handheld weapons and block items preserve JSON geometry and inherited hand display',async()=>{
  const sword=await resolve('diamond_sword');
  assert.equal(sword.itemRoute,'item-generated');
  assert.equal(sword.model.layers[0],'/minecraft/textures/item/diamond_sword.png');
  assert.deepEqual(sword.itemDisplay.rotation,[0,-90,55]);
  const stone=await resolve('stone'),source=await loadJson(entry('stone').model);
  assert.equal(stone.itemRoute,'item-elements');
  assert.deepEqual(stone.model.elements,source.elements,'Display transforms must not modify manufacturing geometry');
  assert.equal(stone.itemDisplay.context,'thirdperson_righthand');
  const enchanting=await resolve('enchanting_table');
  assert.equal(enchanting.itemRoute,'item-elements');
  assert.equal(enchanting.model.elements.length,(await loadJson(entry('enchanting_table').model)).elements.length,'Held enchanting table must not acquire the placed floating book');
});

test('trident and spyglass follow Java ItemRenderer in-hand exceptions',async()=>{
  const trident=await resolve('trident');
  assert.equal(trident.itemRoute,'handheld-special');
  assert.equal(trident.model.itemModelSource,IN_HAND_MODELS.trident);
  assert.equal(trident.model.sourceLayer,'trident#main');
  assert.ok(trident.model.elements.length>0);
  assert.deepEqual(trident.itemDisplay.rotation,[0,60,0]);
  assert.deepEqual(trident.model.display,(await loadJson(IN_HAND_MODELS.trident)).display);
  const spyglass=await resolve('spyglass');
  assert.equal(spyglass.itemRoute,'handheld-json');
  assert.equal(spyglass.model.itemModelSource,IN_HAND_MODELS.spyglass);
  assert.equal(spyglass.model.elements.length,2);
  assert.deepEqual(spyglass.itemDisplay.translation,[0,-2,0]);
});

test('true custom-rendered items retain their dedicated geometry and item display',async()=>{
  for(const id of ['shield','chest','ender_chest','white_bed','red_banner','skeleton_skull','decorated_pot','conduit','white_shulker_box']){
    const source=await loadJson(entry(id).model),{model,itemRoute}=await resolve(id);
    assert.equal(source.renderType,'special',id);
    assert.equal(itemRoute,'item-special',id);
    assert.ok(model.elements.length>0,id);
    assert.deepEqual(model.display,source.display||{},id);
    assert.deepEqual(model.elements,entities.specialModels[entities.itemModels[id]].elements,'Item display remains metadata');
    assert.equal(model.itemRenderer,'BlockEntityWithoutLevelRenderer');
  }
});

test('invisible blocks still have visible held item icons; only air has no item surface',async()=>{
  for(const id of ['barrier','light','structure_void']){
    const result=await resolve(id);
    assert.equal(result.itemRoute,'item-generated');
    assert.equal(entry(id).status,'generated');
    assert.ok(result.model.layers.length>0);
  }
  await assert.rejects(()=>resolve('air'),error=>error.code==='ITEM_INVISIBLE');
});

test('all 1333 registered items resolve to source-backed held models or explicit air',async()=>{
  const items=catalog.entries.filter(value=>value.kind==='item');
  assert.equal(items.length,1333);
  let visible=0,invisible=0;
  for(const value of items){
    try{
      const result=await resolveItemModel(value,entities,loadJson);
      assert.ok(result.model.elements?.length||result.model.layers?.length,value.key);
      assert.ok(result.model.itemModelSource.includes('/item/'),value.key);
      if(result.itemRoute.endsWith('special'))assert.equal(entities.itemModels[value.id.replace('minecraft:','')],value.id.replace('minecraft:',''));
      visible++;
    }catch(error){if(error.code!=='ITEM_INVISIBLE')throw error;assert.equal(value.key,'item/air');invisible++}
  }
  assert.equal(visible,1332);assert.equal(invisible,1);
  assert.equal(Object.keys(entities.itemModels).length,63,'Only true custom item renderers belong in itemModels');
});
