param(
  [string]$MinecraftArtifacts = (Join-Path $PSScriptRoot '../../neoforge-1.21.1/build/moddev/artifacts'),
  [string]$GradleCache = (Join-Path $env:USERPROFILE '.gradle/caches/modules-2/files-2.1')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$project = Split-Path $PSScriptRoot
$work = Join-Path $PSScriptRoot 'import-entities-work'
New-Item -ItemType Directory -Force -Path $work,(Join-Path $project 'public/data') | Out-Null
$sources = Get-ChildItem -LiteralPath $MinecraftArtifacts -Filter '*-sources.jar' | Select-Object -First 1
$merged = Get-ChildItem -LiteralPath $MinecraftArtifacts -Filter '*merged.jar' | Select-Object -First 1
if (!$sources -or !$merged) { throw 'Minecraft 1.21.1 sources and merged artifacts are required.' }
$zip = [IO.Compression.ZipFile]::OpenRead($sources.FullName)
function Read-Source([string]$name) {
  $e=$zip.GetEntry($name)
  if (!$e) { return '' }
  $reader=[IO.StreamReader]::new($e.Open())
  try { return $reader.ReadToEnd() } finally {$reader.Dispose()}
}
$definitions=Read-Source 'net/minecraft/client/model/geom/LayerDefinitions.java'
$layers=Read-Source 'net/minecraft/client/model/geom/ModelLayers.java'
$variables=@{}
foreach($m in [regex]::Matches($definitions,'LayerDefinition (layerdefinition\d*) = ([^;]+);')) { $variables[$m.Groups[1].Value]=$m.Groups[2].Value }
$names=@{}
foreach($m in [regex]::Matches($layers,'ModelLayerLocation (\w+) = (register\w*)\("([^"]+)"(?:, "([^"]+)")?\);')) {
  $suffix=$m.Groups[4].Value
  if($m.Groups[2].Value -eq 'registerInnerArmor'){$suffix='inner_armor'}
  if($m.Groups[2].Value -eq 'registerOuterArmor'){$suffix='outer_armor'}
  if(!$suffix){$suffix='main'}
  $names[$m.Groups[1].Value]=$m.Groups[3].Value + '#' + $suffix
}
$calls=[Collections.Generic.List[string]]::new()
foreach($m in [regex]::Matches($definitions,'builder\.put\(ModelLayers\.(\w+), ([^;]+)\);')) {
  $expr=$m.Groups[2].Value
  if($variables.ContainsKey($expr)){$expr=$variables[$expr]}
  $key=$names[$m.Groups[1].Value]
  $calls.Add(('capture("{0}", () -> {1});' -f $key,$expr))
}
$calls.Add('capture("boat/oak#main", () -> BoatModel.createBodyModel());')
$calls.Add('capture("chest_boat/oak#main", () -> ChestBoatModel.createBodyModel());')
$calls.Add('capture("boat/bamboo#main", () -> RaftModel.createBodyModel());')
$calls.Add('capture("chest_boat/bamboo#main", () -> ChestRaftModel.createBodyModel());')
$calls.Add('capture("sign/oak#main", () -> SignRenderer.createSignLayer());')
$calls.Add('capture("hanging_sign/oak#main", () -> HangingSignRenderer.createHangingSignLayer());')
$imports=([regex]::Matches($definitions,'(?m)^import net\.minecraft\.[^;]+;') | ForEach-Object Value) -join "`n"
$methods=[Collections.Generic.List[string]]::new()
foreach($renderer in @('EnderDragonRenderer','EndCrystalRenderer')) {
  $source=Read-Source ('net/minecraft/client/renderer/entity/'+$renderer+'.java')
  $signature='public static LayerDefinition createBodyLayer()'
  $start=$source.IndexOf($signature)
  $brace=$source.IndexOf('{',$start)
  $depth=1;$cursor=$brace+1
  while($depth -gt 0 -and $cursor -lt $source.Length) {if($source[$cursor] -eq '{'){$depth++};if($source[$cursor] -eq '}'){$depth--};$cursor++}
  $methods.Add($source.Substring($start,$cursor-$start).Replace('createBodyLayer()',('create'+$renderer+'Layer()')))
  for($i=0;$i -lt $calls.Count;$i++){$calls[$i]=$calls[$i].Replace(($renderer+'.createBodyLayer()'),('create'+$renderer+'Layer()'))}
}
$template=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'import-entities-template.java') -Raw
$generated=$template.Replace('/*IMPORTS*/',$imports).Replace('/*CALLS*/',($calls -join "`n")).Replace('/*METHODS*/',($methods -join "`n"))
[IO.File]::WriteAllText((Join-Path $work 'ExportEntityModels.java'),$generated,[Text.UTF8Encoding]::new($false))
$jars=Get-ChildItem -LiteralPath $GradleCache -Recurse -Filter '*.jar' | Where-Object {$_.Name -notmatch 'sources|javadoc|native|test'} | Sort-Object FullName -Descending | ForEach-Object FullName
$libraryFile=Get-ChildItem -LiteralPath (Join-Path $MinecraftArtifacts '../../tmp/neoformruntime') -Recurse -Filter 'libraries.txt' -ErrorAction SilentlyContinue | Where-Object {$_.Directory.Name -match 'decompile'} | Select-Object -First 1
$preferred=@()
if($libraryFile){$preferred=@(Get-Content -LiteralPath $libraryFile.FullName | ForEach-Object {$_ -replace '^-e=',''} | Where-Object {Test-Path -LiteralPath $_})}
$classpath=(@($work,$merged.FullName)+$preferred+@($jars)) -join [IO.Path]::PathSeparator
$compileArgs='-encoding UTF-8 -proc:none -implicit:none -sourcepath "'+(Join-Path $work 'empty').Replace('\','/')+'" -classpath "'+$classpath.Replace('\','/')+'" -d "'+$work.Replace('\','/')+'" "'+(Join-Path $work 'ExportEntityModels.java').Replace('\','/')+'"'
[IO.File]::WriteAllText((Join-Path $work 'compile.args'),$compileArgs,[Text.UTF8Encoding]::new($false))
& javac ('@'+(Join-Path $work 'compile.args'))
if($LASTEXITCODE -ne 0){throw 'Entity extractor compilation failed.'}
$rawPath=Join-Path $work 'layers.json'
$runArgs='-Djava.awt.headless=true -classpath "'+$classpath.Replace('\','/')+'" ExportEntityModels "'+$rawPath.Replace('\','/')+'"'
[IO.File]::WriteAllText((Join-Path $work 'run.args'),$runArgs,[Text.UTF8Encoding]::new($false))
& java ('@'+(Join-Path $work 'run.args'))
if($LASTEXITCODE -ne 0){throw 'Entity extractor failed.'}
# Renderer source strings are retained only as factual texture/registry metadata.
$metadata=[ordered]@{renderers=@{};registeredEntities=@()}
foreach($entry in $zip.Entries){
  if($entry.FullName -match '^net/minecraft/client/renderer/entity/[^/]+Renderer.java$'){
    $text=Read-Source $entry.FullName
    $textures=@([regex]::Matches($text,'"(textures/[^"\s]+\.png)"') | ForEach-Object {$_.Groups[1].Value} | Select-Object -Unique)
    $modelLayers=@([regex]::Matches($text,'ModelLayers\.(\w+)') | ForEach-Object {$names[$_.Groups[1].Value]} | Where-Object {$_} | Select-Object -Unique)
    $metadata.renderers[[IO.Path]::GetFileNameWithoutExtension($entry.FullName)]=@{textures=$textures;layers=$modelLayers}
  }
}
$types=Read-Source 'net/minecraft/world/entity/EntityType.java'
$metadata.registeredEntities=@([regex]::Matches($types,'\bregister\(\s*"([a-z0-9_]+)"') | ForEach-Object {$_.Groups[1].Value} | Select-Object -Unique)
$zip.Dispose()
$metadata | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $work 'metadata.json') -Encoding utf8
& node (Join-Path $PSScriptRoot 'import-entities.mjs')
if($LASTEXITCODE -ne 0){throw 'Entity metadata generation failed.'}



