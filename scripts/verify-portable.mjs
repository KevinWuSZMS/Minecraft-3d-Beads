/** Portable website audit. Uses Node built-ins only; no npm/Codex dependencies.
 * node scripts/verify-portable.mjs [--root <relocated-project>] [--no-report]
 * Add --require-bundled-node when verifying a distribution with Node included.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const args=process.argv.slice(2),rootArg=args.indexOf('--root');
const root=path.resolve(rootArg>=0?args[rootArg+1]:path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
const publicRoot=path.join(root,'public');
const errors=[],warnings=[],regularFiles=[],links=[];
const slash=value=>value.split(path.sep).join('/');
const sha256=value=>createHash('sha256').update(value).digest('hex');
const inside=(parent,target)=>target===parent||target.startsWith(parent+path.sep);
const publicationExcluded=relative=>/^(?:\.git|\.cache|dist|node_modules)(?:\/|$)/.test(relative)||/^scripts\/import-entities-work(?:\/|$)/.test(relative)||/\.(?:log|tmp)$/.test(relative);
async function walk(directory){
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const absolute=path.join(directory,entry.name),relative=slash(path.relative(root,absolute));
    let stat;try{stat=await fs.lstat(absolute)}catch(error){if(error.code==='ENOENT')continue;throw error}
    if(stat.isSymbolicLink()){
      let real=null;try{real=await fs.realpath(absolute)}catch{}
      const link={path:relative,targetExists:Boolean(real),outsideProject:real?!inside(root,real):null,publicationCandidate:!publicationExcluded(relative)};
      links.push(link);
      if(link.publicationCandidate){if(!real)errors.push({path:relative,issue:'Broken symbolic link'});else if(link.outsideProject)errors.push({path:relative,issue:'Publication depends on a link outside the project'})}
    }else if(stat.isDirectory())await walk(absolute);
    else if(stat.isFile())regularFiles.push({path:relative,bytes:stat.size});
  }
}
await walk(root);
const fileMap=new Map(regularFiles.map(file=>[file.path,file]));
const webFiles=regularFiles.filter(file=>file.path.startsWith('public/'));
const publishFiles=regularFiles.filter(file=>!publicationExcluded(file.path));
const read=relative=>fs.readFile(path.join(root,relative),'utf8');
const checkedResources=new Set(),resourceReferences=[],remoteRuntimeReferences=[],informationalUrls=[];

async function resource(value,owner,{base=publicRoot}={}){
  if(typeof value!=='string'||!value||/^(?:data:|blob:|#)/i.test(value))return;
  if(/^(?:https?:)?\/\//i.test(value)){remoteRuntimeReferences.push({path:owner,url:value});return}
  if(/^(?:file:|[A-Za-z]:[\\/])/.test(value)){errors.push({path:owner,issue:'Runtime resource uses an absolute external filesystem path'});return}
  const clean=value.split(/[?#]/,1)[0];if(!clean)return;
  const absolute=clean.startsWith('/')?path.resolve(publicRoot,'.'+clean):path.resolve(base,clean);
  const relative=slash(path.relative(root,absolute));
  if(!inside(publicRoot,absolute)){errors.push({path:owner,issue:'Runtime resource leaves public/',resource:clean});return}
  resourceReferences.push({owner,resource:relative});
  if(checkedResources.has(relative))return;checkedResources.add(relative);
  try{
    const stat=await fs.stat(absolute);if(!stat.isFile())errors.push({path:owner,issue:'Referenced resource is not a file',resource:relative});
    const real=await fs.realpath(absolute);if(!inside(root,real))errors.push({path:owner,issue:'Referenced resource resolves outside project',resource:relative});
  }catch{errors.push({path:owner,issue:'Missing local resource',resource:relative})}
}
const mandatory=['public/index.html','public/src/app.js','public/src/engine.js','public/src/viewer.js','public/src/boards.js','public/src/texture-faces.js','public/src/item-models.js','public/src/color-matching.js','public/src/style.css','public/data/catalog.json','public/data/entities.json','public/data/palette.json','public/data/paintings.json','public/vendor/three.module.js','public/vendor/three.core.js','public/vendor/OrbitControls.js','scripts/server.mjs'];
for(const file of mandatory)if(!fileMap.has(file))errors.push({path:file,issue:'Missing required website file'});
const html=await read('public/index.html');
let imports={};
for(const match of html.matchAll(/<script\b[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)){
  try{imports={...imports,...JSON.parse(match[1]).imports}}catch{errors.push({path:'public/index.html',issue:'Invalid import map'})}
}
for(const value of Object.values(imports))await resource(value,'public/index.html importmap');
for(const match of html.matchAll(/<(script|link|img|source|video|audio)\b([^>]*)>/gi)){
  const attr=/\b(?:src|href)\s*=\s*(["'])(.*?)\1/i.exec(match[2]);if(attr)await resource(attr[2],'public/index.html');
}
for(const match of html.matchAll(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["']/gi))informationalUrls.push({path:'public/index.html',purpose:'User-clicked documentation link',url:match[1]});
const fileExtension='(?:png|jpe?g|webp|gif|svg|json|css|m?js|woff2?|ttf|otf|mp3|mp4)';
for(const file of webFiles){
  if(/\.(?:js|mjs|css|html)$/i.test(file.path)){
    const source=await read(file.path),directory=path.dirname(path.join(root,file.path));
    for(const match of source.matchAll(new RegExp(`(["'])(/[^"'\\r\\n<>]*?\\.${fileExtension})\\1`,'g')))await resource(match[2],file.path);
    if(/\.(?:css|html)$/i.test(file.path))for(const match of source.matchAll(/\burl\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi))await resource(match[2],file.path,{base:directory});
    if(/\.m?js$/i.test(file.path)){
      const withoutComments=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
      const specs=[...withoutComments.matchAll(/\bfrom\s*(["'])([^"']+)\1/g),...withoutComments.matchAll(/\bimport\s*\(\s*(["'])([^"']+)\1/g),...withoutComments.matchAll(/\bimport\s*(["'])([^"']+)\1/g)];
      for(const match of specs){const value=match[2];if(value.startsWith('.')||value.startsWith('/'))await resource(value,file.path,{base:directory});else if(imports[value])await resource(imports[value],file.path);else if(/^https?:/.test(value))remoteRuntimeReferences.push({path:file.path,url:value});else errors.push({path:file.path,issue:'Unmapped browser module dependency',resource:value})}
      for(const match of withoutComments.matchAll(/(?:\bfetch\s*\(|\bimport\s*\(|\bnew\s+(?:Worker|WebSocket|EventSource)\s*\(|\.src\s*=|\.load\s*\()\s*(["'])(https?:\/\/[^"']+)\1/g))remoteRuntimeReferences.push({path:file.path,url:match[2]});
      if(/(?:file:\/\/|[A-Z]:\\\\(?:Users|Program Files|HMCL))/i.test(withoutComments))errors.push({path:file.path,issue:'Browser code contains an external filesystem dependency'});
    }
  }else if(file.path.endsWith('.json')){
    let data;try{data=JSON.parse((await read(file.path)).replace(/^\uFEFF/,''))}catch{errors.push({path:file.path,issue:'Malformed JSON'});continue}
    const visit=async value=>{
      if(Array.isArray(value)){for(const item of value)await visit(item)}
      else if(value&&typeof value==='object'){for(const item of Object.values(value))await visit(item)}
      else if(typeof value==='string'&&value.startsWith('/')&&new RegExp(`\\.${fileExtension}(?:[?#].*)?$`,'i').test(value))await resource(value,file.path);
    };
    await visit(data);
  }else if(file.path.endsWith('.svg')){
    const source=await read(file.path);
    for(const match of source.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])([^"']+)\1/gi))await resource(match[2],file.path,{base:path.dirname(path.join(root,file.path))});
  }
}
const paintings=JSON.parse(await read('public/data/paintings.json'));
for(const name of paintings)await resource(`/minecraft/textures/painting/${name}.png`,'public/data/paintings.json dynamic item');
for(const file of ['public/minecraft/textures/font/ascii.png','public/minecraft/textures/colormap/grass.png','public/minecraft/textures/colormap/foliage.png'])if(!fileMap.has(file))errors.push({path:file,issue:'Missing required vanilla font/colour-map asset'});
for(const reference of remoteRuntimeReferences)errors.push({path:reference.path,issue:'Website requires a remote runtime resource',url:reference.url});

// Report only filenames, line numbers, and pattern types. Matched values are
// deliberately never written to stdout or the report.
const secretFindings=[],secretPatterns=[
  ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['openai-key',/\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/g],
  ['slack-token',/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['aws-access-id',/\bAKIA[A-Z0-9]{16}\b/g],
  ['credential-assignment',/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)["']?\s*[:=]\s*["']([^"'\r\n]{12,})["']/gi],
];
let scannedSecretFiles=0;
for(const file of regularFiles.filter(file=>/^(references|docs)\//.test(file.path)&&!file.path.endsWith('/portable-assets.json'))){
  if(/\.(?:pfx|p12|jks|keystore)$/i.test(file.path)){secretFindings.push({path:file.path,kind:'credential-container',line:null});continue}
  if(!/\.(?:txt|md|json|svg|html?|m?js|css|ya?ml|toml|ps1|cmd|bat|env|pem|key)$/i.test(file.path))continue;
  scannedSecretFiles++;const source=await read(file.path);
  for(const [kind,pattern]of secretPatterns){pattern.lastIndex=0;for(const match of source.matchAll(pattern)){
    if(kind==='credential-assignment'&&/^(?:example|placeholder|redacted|your[_ -]|<|none|null)/i.test(match[1]))continue;
    secretFindings.push({path:file.path,kind,line:source.slice(0,match.index).split('\n').length});
  }}
}
if(secretFindings.length)warnings.push('Potential credentials found in references/docs; review the listed locations before publication.');
const runtimeBinaries=publishFiles.filter(file=>/(?:^|\/)node(?:\.exe)?$/.test(file.path)).map(file=>({path:file.path,bytes:file.bytes}));
const runtimeArchives=[],vendoredDependencies=[];
async function verifyHash(relative,expectedHash,expectedBytes,owner){
  const absolute=path.resolve(root,relative);
  if(!inside(root,absolute)){errors.push({path:owner,issue:'Manifest resource leaves project'});return false}
  try{
    const actual=await fs.readFile(absolute),actualHash=sha256(actual);
    if(actualHash!==expectedHash||(expectedBytes!==undefined&&actual.length!==expectedBytes)){errors.push({path:relative,issue:'Manifest checksum or size mismatch'});return false}
    return true;
  }catch{errors.push({path:relative,issue:'Missing manifest resource'});return false}
}
if(fileMap.has('runtime/manifest.json')){
  const manifest=JSON.parse(await read('runtime/manifest.json'));
  const checksums=fileMap.has('runtime/SHASUMS256.txt')?await read('runtime/SHASUMS256.txt'):'';
  for(const [platform,bundle] of Object.entries(manifest.archives||{})){
    const relative=`runtime/${bundle.file}`;
    const checksumListed=checksums.split(/\r?\n/).some(line=>line.trim().split(/\s+/).join(' ')===`${bundle.sha256} ${bundle.file}`);
    if(!checksumListed)errors.push({path:relative,issue:'Runtime checksum is not in the copied official checksum list'});
    const verified=await verifyHash(relative,bundle.sha256,bundle.bytes,'runtime/manifest.json');
    runtimeArchives.push({platform,path:relative,nodeVersion:manifest.nodeVersion,bytes:bundle.bytes,sha256:bundle.sha256,verified:verified&&checksumListed});
  }
}
if(args.includes('--require-bundled-node')&&!runtimeBinaries.length&&!runtimeArchives.some(bundle=>bundle.verified))errors.push({path:'runtime/',issue:'No verified bundled Node executable/archive was found'});
if(fileMap.has('vendor/dependencies.json')){
  const manifest=JSON.parse(await read('vendor/dependencies.json'));
  for(const pkg of manifest.packages||[]){
    let valid=0,totalBytes=0;
    for(const file of pkg.files){if(await verifyHash(`vendor/node/${pkg.name}/${file.path}`,file.sha256,file.bytes,'vendor/dependencies.json'))valid++;totalBytes+=file.bytes}
    vendoredDependencies.push({name:pkg.name,version:pkg.version,files:pkg.files.length,verifiedFiles:valid,bytes:totalBytes});
  }
}
let generatedTrimTextures=null;
if(fileMap.has('docs/generated-trim-textures.json')){
  const manifest=JSON.parse(await read('docs/generated-trim-textures.json'));
  let verified=0;
  for(const file of [manifest.atlas,...manifest.inputs,...manifest.outputs])if(await verifyHash(file.path,file.sha256,file.bytes,'docs/generated-trim-textures.json'))verified++;
  generatedTrimTextures={count:manifest.count,manifest:'docs/generated-trim-textures.json',sourceEvidence:manifest.sourceEvidence,algorithm:'Minecraft Java 1.21.1 PalettedPermutations.createPaletteMapping: RGB lookup with integer alpha multiplication',generator:manifest.generator,verifyCommand:manifest.verifyCommand,verifiedSourceAndOutputFiles:verified};
}else errors.push({path:'docs/generated-trim-textures.json',issue:'Missing reproducible dynamic trim texture provenance'});
const bytes=files=>files.reduce((sum,file)=>sum+file.bytes,0);
const totals={directoryRegularFiles:regularFiles.length,directoryRegularBytes:bytes(regularFiles),projectBytesExcludingGit:bytes(regularFiles.filter(file=>!file.path.startsWith('.git/'))),publicationCandidateFiles:publishFiles.length,publicationCandidateBytes:bytes(publishFiles),publicFiles:webFiles.length,publicBytes:bytes(webFiles)};
const groupNames=[...new Set(regularFiles.map(file=>file.path.includes('/')?file.path.split('/')[0]:'(root files)'))].sort();
const groups=groupNames.map(group=>{const files=regularFiles.filter(file=>(file.path.includes('/')?file.path.split('/')[0]:'(root files)')===group);return {directory:group,files:files.length,bytes:bytes(files),publicationBytes:bytes(files.filter(file=>!publicationExcluded(file.path)))}});
const largestPublicationFiles=[...publishFiles].sort((a,b)=>b.bytes-a.bytes).slice(0,20);
const report={schemaVersion:1,generatedAt:new Date().toISOString(),project:path.basename(root),portableWebsite:errors.length===0,
  validation:{method:'Static filesystem/module/URL audit using Node built-ins; every literal public resource and all exported model/data URLs resolve within this project.',checkedLocalResources:checkedResources.size,resourceReferenceOccurrences:resourceReferences.length,remoteRuntimeReferences,informationalUrls,requiredFiles:mandatory.length,symlinkPolicy:'Links are inspected without following them during size enumeration; publication links resolving outside the project fail.'},
  inventory:{...totals,groups,largestPublicationFiles,publicationFilesOver100MiB:publishFiles.filter(file=>file.bytes>=100*1024*1024),links,runtimeBinaries,runtimeArchives,vendoredDependencies,publicationExclusions:['.git/','.cache/','dist/','node_modules/','scripts/import-entities-work/','*.log','*.tmp']},
  runtimeBoundary:{required:['public/ including local model/texture/font assets and Three.js vendor files','scripts/server.mjs plus Node.js (system or bundled)','A browser with WebGL support'],notRequiredForNormalUse:['node_modules','Codex installation or account','Python/JDK/Gradle','The original Minecraft installation','Internet/CDN access'],fonts:'UI uses operating-system fallback fonts (Segoe UI/Microsoft YaHei/PingFang SC/sans-serif), with no remote font requests. Minecraft bitmap fonts are included under public/minecraft/textures/font/.',developmentOnly:[{purpose:'Re-import original game assets',dependencies:['Python 3.10+ (Pillow for thumbnails)','Matching Minecraft Java 1.21.1 resource/source JARs and asset index 17'],externalEnvironment:true},{purpose:'Re-extract entity model layers',dependencies:['Java 21 JDK','Matching merged/source JARs','Gradle dependency cache'],externalEnvironment:true},{purpose:'Offline PNG/SVG model audits and comparison reports',dependencies:['Locally vendored pngjs and sharp, prepared with node scripts/prepare-dependencies.mjs'],externalEnvironment:false},{purpose:'Rebuild browser vendor files from package source',dependencies:['Locally vendored Three.js package, prepared automatically by scripts/build.mjs'],externalEnvironment:false},{purpose:'Regenerate dynamic item trim textures',dependencies:['Locally vendored pngjs','Included vanilla atlas and palette PNGs'],externalEnvironment:false}]},
  provenance:{minecraft:'Imported Minecraft Java 1.21.1 model/texture/lang/font assets remain attributed to Mojang / Microsoft. This package does not include the full game installation.',generatedTrimTextures,mard:'User-provided reference screenshots in references/mard to hex; H01 transparency corrected by user.',three:'Three.js 0.180.0 runtime files vendored locally; MIT license retained in public/vendor/LICENSE.three.'},
  secretScan:{scope:['references/','docs/'],textFilesScanned:scannedSecretFiles,findings:secretFindings,disclosure:'Only locations/types are reported, never matched values.',limits:'Pattern-based text scan; binary images were not OCR-scanned.'},warnings,errors};
if(!args.includes('--no-report')){const target=path.join(root,'docs/portable-assets.json');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,JSON.stringify(report,null,2)+'\n')}
console.log(JSON.stringify({portableWebsite:report.portableWebsite,checkedLocalResources:checkedResources.size,publicMiB:Number((totals.publicBytes/1048576).toFixed(2)),publicationMiB:Number((totals.publicationCandidateBytes/1048576).toFixed(2)),projectMiB:Number((totals.projectBytesExcludingGit/1048576).toFixed(2)),runtimeBinaries:runtimeBinaries.map(file=>file.path),verifiedRuntimeArchives:runtimeArchives.filter(bundle=>bundle.verified).length,vendoredPackages:vendoredDependencies.length,generatedTrimTextures:generatedTrimTextures?.count,externalPublicationLinks:links.filter(link=>link.publicationCandidate&&link.outsideProject).map(link=>link.path),secretFindings,errors,warnings},null,2));
if(errors.length||secretFindings.length)process.exitCode=1;
