import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const publicRoot=path.join(project,'public');
const errors=[];
const checkedPaths=new Set();
let checkedModels=0;
const check=(condition,message)=>{if(!condition)errors.push(message)};
async function json(file){try{return JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''))}catch(error){errors.push(`${path.relative(project,file)}: ${error.message}`);return null}}
async function resource(url,context){
  if(!url)return;
  check(typeof url==='string'&&url.startsWith('/'),`${context}: invalid local resource ${url}`);
  if(typeof url!=='string'||!url.startsWith('/')||checkedPaths.has(url))return;
  checkedPaths.add(url);
  const target=path.resolve(publicRoot,'.'+url);
  if(!target.startsWith(publicRoot+path.sep)){errors.push(`${context}: resource leaves public directory`);return}
  try{check((await fs.stat(target)).isFile(),`${context}: resource is not a file ${url}`)}catch{errors.push(`${context}: missing ${url}`)}
}
async function model(value,context){
  if(!value){errors.push(`${context}: missing model`);return}
  checkedModels++;
  for(const texture of Object.values(value.textures||{}))await resource(texture,context);
  for(const texture of value.layers||[])await resource(texture,context);
  for(const element of value.elements||[]){
    for(const name of ['from','to'])check(Array.isArray(element[name])&&element[name].length===3&&element[name].every(Number.isFinite),`${context}: invalid element ${name}`);
    if(element.transform)check(element.transform.length===16&&element.transform.every(Number.isFinite),`${context}: invalid transform`);
    for(const face of Object.values(element.faces||{})){await resource(face.texture,context);if(face.uv)check(face.uv.length===4&&face.uv.every(Number.isFinite),`${context}: invalid face UV`)}
    for(const surface of element.surfaces||[]){await resource(surface.texture,context);for(const vertex of surface.vertices||[]){check(vertex.position?.length===3&&vertex.position.every(Number.isFinite),`${context}: invalid surface position`);check(vertex.uv?.length===2&&vertex.uv.every(Number.isFinite),`${context}: invalid surface UV`)}}
  }
  if(value.renderType==='generated')check(value.layers?.length>0,`${context}: generated model without texture layers`);
}

const catalog=await json(path.join(publicRoot,'data/catalog.json'));
if(catalog){
  const keys=new Set(),counts={};
  for(const entry of catalog.entries||[]){
    check(!keys.has(entry.key),`Duplicate catalog key: ${entry.key}`);keys.add(entry.key);
    check(/^minecraft:[a-z0-9_]+$/.test(entry.id),`Invalid registry id: ${entry.id}`);
    check(entry.key===`${entry.kind}/${entry.id?.replace('minecraft:','')}`,`ID/key mismatch: ${entry.key}`);
    check(Boolean(entry.name)&&Boolean(entry.nameEn),`Missing name: ${entry.key}`);
    counts[entry.kind]=(counts[entry.kind]||0)+1;
    for(const field of ['model','texture','thumbnail','blockstates'])await resource(entry[field],entry.key);
    if(entry.model)await model(await json(path.join(publicRoot,entry.model)),entry.key);
  }
  for(const [kind,count]of Object.entries(catalog.counts||{}))check(count===counts[kind],`Count mismatch for ${kind}: ${count} vs ${counts[kind]}`);
  console.log('Catalog:',JSON.stringify(counts),`(${keys.size} unique entries)`);
}
const palette=await json(path.join(publicRoot,'data/palette.json'));
if(palette){
  const colors=palette.colors||[];
  check(colors.length===221,`Expected 221 MARD colors, got ${colors.length}`);
  check(new Set(colors.map(color=>color.code)).size===colors.length,'Duplicate MARD color codes');
  for(const color of colors){check(/^[A-Z]+\d+$/.test(color.code),`Invalid MARD code: ${color.code}`);check(/^#[A-Fa-f0-9]{6}$/.test(color.hex),`Invalid HEX: ${color.code} ${color.hex}`)}
  console.log(`Palette: ${colors.length} colors`);
}
const entities=await json(path.join(publicRoot,'data/entities.json'));
if(entities){
  for(const [name,value]of Object.entries(entities.models||{}))await model(value,`entity/${name}`);
  for(const [name,value]of Object.entries(entities.specialModels||{}))await model(value,`special/${name}`);
  for(const [name,entry]of Object.entries(entities.entities||{}))if(entry.status==='ready')check(Boolean(entities.models?.[entry.model]),`Entity ${name}: missing linked model ${entry.model}`);
  for(const [name,target]of Object.entries(entities.blockEntities||{}))check(Boolean(entities.specialModels?.[target]),`Block entity ${name}: missing linked model ${target}`);
  console.log(`Entity geometry: ${Object.keys(entities.models||{}).length} models, ${Object.keys(entities.specialModels||{}).length} special models`);
}
if(errors.length){console.error(`FAILED: ${errors.length} catalog/resource errors`);for(const error of errors.slice(0,60))console.error(' - '+error);process.exitCode=1}
else console.log(`PASS: ${checkedModels} models; ${checkedPaths.size} local resource references. This check does not validate physical assembly or browser rendering.`);
