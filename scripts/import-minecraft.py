"""Import an installed Java 1.21.1 client without launching Minecraft.

Python 3.10+; Pillow is used only for first-frame item thumbnails. Original
textures, models, and blockstates are copied unchanged. The catalog comes from
the vanilla registry declarations in the matching local mapped sources.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import re
import zipfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACTS = ROOT.parent / 'neoforge-1.21.1/build/moddev/artifacts'
DEFAULT_ASSETS = ROOT.parents[1] / '.minecraft/assets'


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


def asset_name(value):
    return value.removeprefix('minecraft:')


def parse_registry(source, type_pattern):
    declarations = re.findall(r'public static final ' + type_pattern + r'\s+(\w+)\s*=\s*(.*?);', source, re.S)
    result = []
    for constant, initializer in declarations:
        explicit = re.match(r'register(?:Item|Block)?\(\s*"([^\"]+)"', initializer)
        block_reference = re.match(r'registerBlock\(\s*Blocks\.(\w+)', initializer)
        identifier = explicit.group(1) if explicit else block_reference.group(1).lower() if block_reference else constant.lower()
        result.append((identifier, initializer))
    if len({item[0] for item in result}) != len(result):
        raise ValueError('Duplicate registry IDs')
    return result


def state_score(key):
    preferred = {'facing': 'north', 'axis': 'y', 'half': 'bottom', 'type': 'bottom', 'shape': 'straight', 'hinge': 'left', 'face': 'floor', 'part': 'foot', 'attachment': 'floor', 'tilt': 'none', 'thickness': 'tip', 'vertical_direction': 'up'}
    score = 0
    for pair in key.split(','):
        if '=' not in pair:
            continue
        prop, value = pair.split('=', 1)
        score += 8 if preferred.get(prop) == value else 0
        score += 3 if value in ('false', '0', 'none', 'single') else 0
    return score


def matching(when, state):
    if not when:
        return True
    if 'OR' in when:
        return any(matching(item, state) for item in when['OR'])
    if 'AND' in when:
        return all(matching(item, state) for item in when['AND'])
    return all(str(state.get(key, 'false')) in str(value).split('|') for key, value in when.items())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', type=Path, default=DEFAULT_ARTIFACTS)
    parser.add_argument('--assets', type=Path, default=DEFAULT_ASSETS)
    parser.add_argument('--resources', type=Path)
    parser.add_argument('--sources', type=Path)
    args = parser.parse_args()
    resources_path = args.resources or next(args.artifacts.glob('*client-extra*resources.jar'))
    sources_path = args.sources or next(args.artifacts.glob('*-sources.jar'))
    output = ROOT / 'public/minecraft'
    resources = zipfile.ZipFile(resources_path)
    sources = zipfile.ZipFile(sources_path)
    prefix = 'assets/minecraft/'
    raw_models = {}
    blockstates = {}
    count_files = 0
    for name in resources.namelist():
        if not name.startswith(prefix):
            continue
        relative = name[len(prefix):]
        if not relative.startswith(('textures/', 'models/', 'blockstates/', 'lang/')) or name.endswith('/'):
            continue
        data = resources.read(name)
        path = output / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        count_files += 1
        if relative.startswith('models/') and relative.endswith('.json'):
            raw_models[relative[7:-5]] = json.loads(data)
        if relative.startswith('blockstates/') and relative.endswith('.json'):
            blockstates[relative[12:-5]] = json.loads(data)
    english = json.loads(resources.read(prefix + 'lang/en_us.json'))
    chinese = {}
    language_source = None
    # 1.21.1 uses asset index 17. Never silently substitute another version.
    index_file = args.assets / 'indexes/17.json'
    if index_file.exists():
        index = json.loads(index_file.read_text(encoding='utf-8'))
        zh = index.get('objects', {}).get('minecraft/lang/zh_cn.json')
        if zh:
            language_file = args.assets / 'objects' / zh['hash'][:2] / zh['hash']
            if language_file.exists():
                language_bytes = language_file.read_bytes()
                if hashlib.sha1(language_bytes).hexdigest() != zh['hash']:
                    raise ValueError('Chinese language asset failed SHA-1 verification')
                chinese = json.loads(language_bytes)
                language_source = zh['hash']
                (output / 'lang/zh_cn.json').write_bytes(language_bytes)
    if not chinese:
        raise FileNotFoundError('Matching Minecraft asset index 17 Chinese translation unavailable; use --assets')

    registry_sources = {
        'block': ('net/minecraft/world/level/block/Blocks.java', 'Block'),
        'item': ('net/minecraft/world/item/Items.java', 'Item'),
        'entity': ('net/minecraft/world/entity/EntityType.java', r'EntityType<[^;]+?>'),
    }
    registries = {kind: parse_registry(sources.read(path).decode(), pattern) for kind, (path, pattern) in registry_sources.items()}
    block_ids = {identifier for identifier, _ in registries['block']}
    item_ids = {identifier for identifier, _ in registries['item']}
    cache = {}
    failures = []

    def resolve(key, chain=()):
        key = asset_name(key)
        if key in cache:
            return copy.deepcopy(cache[key])
        if key in chain:
            raise ValueError('Model parent cycle: ' + key)
        if key.startswith('builtin/'):
            return {'textures': {}, 'elements': [], 'renderType': 'generated' if key.endswith('generated') else 'special'}
        raw = raw_models.get(key)
        if raw is None:
            failures.append({'model': key, 'reason': 'missing parent'})
            return {'textures': {}, 'elements': [], 'renderType': 'special'}
        result = resolve(raw['parent'], chain + (key,)) if raw.get('parent') else {'textures': {}, 'elements': []}
        result['textures'].update(raw.get('textures', {}))
        if 'elements' in raw:
            result['elements'] = copy.deepcopy(raw['elements'])
        if 'display' in raw:
            result['display'] = {**result.get('display', {}), **copy.deepcopy(raw['display'])}
        for field in ('gui_light', 'ambientocclusion', 'overrides'):
            if field in raw:
                result[field] = copy.deepcopy(raw[field])
        result['sourceModel'] = 'minecraft:' + key
        if result['elements']:
            result['renderType'] = 'elements'
        else:
            result.setdefault('renderType', 'special')
        cache[key] = copy.deepcopy(result)
        return result

    def finish_model(model):
        model = copy.deepcopy(model)
        textures = model.get('textures', {})

        def texture_path(value):
            visited = set()
            # BlockModel accepts a texture dictionary key with or without '#'
            # (the official heavy_core model uses the latter form).
            while isinstance(value, str) and (value.startswith('#') or value in textures):
                if value in visited:
                    return None
                visited.add(value)
                value = textures.get(value[1:] if value.startswith('#') else value)
            return '/minecraft/textures/' + asset_name(value) + '.png' if value else None

        for element in model.get('elements', []):
            for face in element.get('faces', {}).values():
                face['texture'] = texture_path(face.get('texture'))
        model['layers'] = [texture_path(textures[key]) for key in sorted(textures) if re.fullmatch(r'layer\d+', key)]
        model['textures'] = {key: texture_path(value) for key, value in textures.items()}
        return model

    # Keep every inherited model and original blockstate variant, not only the
    # selected catalog view. This also makes adding a variant chooser lossless.
    for key in raw_models:
        write_json(output / 'models-resolved' / (key + '.json'), finish_model(resolve(key)))

    try:
        from PIL import Image, ImageChops
    except ImportError:
        Image = None
    tint_by_item = {}
    for identifier, initializer in registries['item']:
        egg = re.search(r'new SpawnEggItem\(\s*EntityType\.\w+\s*,\s*(\d+)\s*,\s*(\d+)', initializer)
        if egg:
            tint_by_item[identifier] = {0: int(egg.group(1)), 1: int(egg.group(2))}
    for identifier in ('leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots', 'leather_horse_armor'):
        tint_by_item[identifier] = {0: -6265536 & 0xFFFFFF}
    tint_by_item['firework_star'] = {1: -7697782 & 0xFFFFFF}
    tint_by_item['wolf_armor'] = {1: 0}
    potion_source = sources.read('net/minecraft/world/item/alchemy/PotionContents.java').decode()
    potion_default = re.search(r'getColorOptional\(effects\)\.orElse\((-?\d+)\)', potion_source)
    for identifier in ('potion', 'splash_potion', 'lingering_potion', 'tipped_arrow'):
        tint_by_item[identifier] = {0: int(potion_default.group(1)) & 0xFFFFFF}
    map_source = sources.read('net/minecraft/world/item/component/MapItemColor.java').decode()
    map_default = re.search(r'DEFAULT = new MapItemColor\((\d+)\)', map_source)
    tint_by_item['filled_map'] = {1: int(map_default.group(1))}
    foliage_source = sources.read('net/minecraft/world/level/FoliageColor.java').decode()
    grass_source = sources.read('net/minecraft/world/level/GrassColor.java').decode()
    foliage = {}
    for method, value in re.findall(r'public static int (get\w+Color)\(\)\s*\{\s*return (-?\d+);', foliage_source):
        foliage[method] = int(value) & 0xFFFFFF
    grass_default_match = re.search(r'public static int getDefaultColor\(\)\s*\{\s*return (-?\d+);', grass_source)
    grass_default = int(grass_default_match.group(1)) & 0xFFFFFF if grass_default_match else 0x7CBD6B
    if Image and not grass_default_match:
        # GrassColor.getDefaultColor() calls get(0.5, 1.0); humidity *= temperature.
        red, green, blue = Image.open(output / 'textures/colormap/grass.png').convert('RGB').getpixel((127, 127))
        grass_default = (red << 16) | (green << 8) | blue

    def get_tints(identifier, kind):
        if identifier in tint_by_item:
            return tint_by_item[identifier]
        if identifier in ('grass_block', 'short_grass', 'fern', 'potted_fern', 'tall_grass', 'large_fern'):
            return {0: grass_default}
        if identifier == 'pink_petals':
            return {1: grass_default}
        if identifier == 'spruce_leaves':
            return {0: foliage.get('getEvergreenColor', 0x619961)}
        if identifier == 'birch_leaves':
            return {0: foliage.get('getBirchColor', 0x80A755)}
        if identifier == 'mangrove_leaves' and kind == 'item':
            return {0: foliage.get('getMangroveColor', 0x92C648)}
        if identifier.endswith('_leaves') and identifier not in ('azalea_leaves', 'flowering_azalea_leaves', 'cherry_leaves') or identifier == 'vine':
            return {0: foliage.get('getDefaultColor', 0x48B518)}
        if identifier == 'lily_pad':
            return {0: -9321636 & 0xFFFFFF}
        if identifier in ('attached_melon_stem', 'attached_pumpkin_stem'):
            return {0: -2046180 & 0xFFFFFF}
        if identifier in ('melon_stem', 'pumpkin_stem'):
            return {0: 0x00FF00}
        if identifier == 'redstone_wire':
            return {0: 0x4C0000}
        return {}

    def thumbnail(model, key, tints):
        layers = model.get('layers', [])
        if not Image or not layers:
            return None
        image = None
        for i, layer in enumerate(layers):
            if not layer:
                continue
            file = ROOT / 'public' / layer.lstrip('/')
            if not file.exists():
                continue
            layer_image = Image.open(file).convert('RGBA')
            # Animated textures are strips; use exactly the first frame.
            if layer_image.height > layer_image.width:
                layer_image = layer_image.crop((0, 0, layer_image.width, layer_image.width))
            if i in tints:
                color = tints[i]
                tint = Image.new('RGBA', layer_image.size, ((color >> 16) & 255, (color >> 8) & 255, color & 255, 255))
                layer_image = ImageChops.multiply(layer_image, tint)
            if image is None:
                image = layer_image
            else:
                image.alpha_composite(layer_image.resize(image.size, Image.Resampling.NEAREST))
        if image is None:
            return None
        path = output / 'thumbnails' / (key + '.png')
        path.parent.mkdir(parents=True, exist_ok=True)
        image.save(path)
        return '/minecraft/thumbnails/' + key + '.png'

    entries = []
    invisible = {'air', 'cave_air', 'void_air', 'structure_void', 'barrier', 'light'}
    for kind, items in registries.items():
        for identifier, initializer in items:
            translation_key = kind + '.minecraft.' + identifier
            if kind == 'item' and translation_key not in english:
                translation_key = 'block.minecraft.' + identifier
            if identifier.endswith('_wall_banner') and translation_key not in english:
                translation_key = 'block.minecraft.' + identifier.replace('_wall_banner', '_banner')
            entry = {
                'id': 'minecraft:' + identifier,
                'key': kind + '/' + identifier,
                'kind': kind,
                'name': chinese.get(translation_key, english.get(translation_key, identifier)),
                'nameEn': english.get(translation_key, identifier.replace('_', ' ').title()),
                'translationKey': translation_key,
                'model': None,
                'texture': None,
                'status': 'special',
                'renderType': 'special',
            }
            if kind == 'block':
                entry['hasItem'] = identifier in item_ids
            if kind == 'item':
                entry['isBlockItem'] = identifier in block_ids
            if kind == 'entity':
                entry['geometrySource'] = 'Java model layers; public/data/entities.json'
                entries.append(entry)
                continue
            key = kind + '/' + identifier
            model = None
            if kind == 'item' and key in raw_models:
                model = resolve(key)
            if kind == 'block' and identifier in blockstates:
                state_json = blockstates[identifier]
                entry['blockstates'] = '/minecraft/blockstates/' + identifier + '.json'
                if 'variants' in state_json:
                    variants = state_json['variants']
                    state_key = max(variants, key=state_score)
                    variant = variants[state_key]
                    if isinstance(variant, list):
                        variant = variant[0]
                    model = resolve(variant['model'])
                    model['blockstateRotation'] = {'x': variant.get('x', 0), 'y': variant.get('y', 0), 'uvlock': variant.get('uvlock', False)}
                    entry['defaultState'] = state_key
                    entry['variantCount'] = len(variants)
                elif 'multipart' in state_json:
                    # An isolated block, disconnected from all neighbours.
                    state = {'up': 'true', 'down': 'false', 'north': 'false', 'east': 'false', 'south': 'false', 'west': 'false', 'waterlogged': 'false', 'power': '0'}
                    applications = []
                    for part in state_json['multipart']:
                        if matching(part.get('when'), state):
                            application = part['apply']
                            applications.append(application[0] if isinstance(application, list) else application)
                    if not applications:
                        application = state_json['multipart'][0]['apply']
                        applications = [application[0] if isinstance(application, list) else application]
                    model = {'elements': [], 'textures': {}, 'renderType': 'elements', 'sourceModel': 'minecraft:blockstates/' + identifier}
                    for application in applications:
                        part_model = finish_model(resolve(application['model']))
                        for element in part_model.get('elements', []):
                            element['blockstateRotation'] = {'x': application.get('x', 0), 'y': application.get('y', 0), 'uvlock': application.get('uvlock', False)}
                            model['elements'].append(element)
                        model['textures'].update(part_model.get('textures', {}))
                    model['_finished'] = True
                    entry['defaultState'] = ','.join(key + '=' + value for key, value in state.items())
                    entry['multipartCount'] = len(state_json['multipart'])
            if model is None and key in raw_models:
                model = resolve(key)
            if model is not None:
                model = model if model.pop('_finished', False) else finish_model(model)
                tints = get_tints(identifier, kind)
                model['tints'] = {str(index): '#' + format(color, '06X') for index, color in tints.items()}
                model['tintContext'] = 'Vanilla inventory defaults; biome-dependent colours use default inventory colour.'
                for element in model.get('elements', []):
                    for face in element.get('faces', {}).values():
                        if face.get('tintindex') in tints:
                            face['tint'] = '#' + format(tints[face['tintindex']], '06X')
                model_path = '/minecraft/catalog-models/' + key + '.json'
                write_json(ROOT / 'public' / model_path.lstrip('/'), model)
                entry['model'] = model_path
                entry['renderType'] = model.get('renderType', 'special')
                entry['status'] = 'model' if entry['renderType'] == 'elements' else entry['renderType']
                entry['texture'] = model.get('layers', [None])[0] if model.get('layers') else next((value for value in model.get('textures', {}).values() if value), None)
                entry['thumbnail'] = thumbnail(model, key, tints) or entry['texture']
                if model.get('overrides'):
                    entry['overrideCount'] = len(model['overrides'])
                entry['elementCount'] = len(model.get('elements', []))
            if kind == 'item' and identifier in ('trident', 'spyglass'):
                entry['handheldModel'] = '/minecraft/models-resolved/item/' + identifier + '_in_hand.json'
                entry['handheldModelSource'] = 'Java 1.21.1 ItemRenderer.getModel'
            if identifier in invisible and (kind != 'item' or identifier == 'air'):
                entry['status'] = 'invisible'
                entry['renderType'] = 'invisible'
                entry['note'] = '原版无可见实体表面；辅助图标不代表可拼插模型。'
            elif kind == 'item' and identifier in ('barrier', 'light', 'structure_void'):
                entry['note'] = '使用原版手持物品图标；对应放置方块本身不可见。'
            elif entry['status'] == 'special':
                entry['note'] = '由原版专用渲染器生成，需对应实体模型层。'
            entries.append(entry)

    counts = dict(Counter(entry['kind'] for entry in entries))
    coverage = {kind: dict(Counter(entry['status'] for entry in entries if entry['kind'] == kind)) for kind in registries}
    catalog = {
        'version': 'Java 1.21.1',
        'schemaVersion': 1,
        'source': '本机 Minecraft 1.21.1 原版资源及对应映射源码；不启动游戏导入',
        'sourceSha256': hashlib.sha256(resources_path.read_bytes()).hexdigest(),
        'languageAssetSha1': language_source,
        'counts': counts,
        'coverage': coverage,
        'notes': ['目录包括所有注册的方块、物品和实体类型；同名方块和物品为不同注册项。', '方块选择一个默认展示状态；全部原始状态和模型保留。', '实体和方块实体几何由 Java 静态模型层单独导入。', '动态组件、染色、药水、附魔和实体皮肤的全部组合不等于独立注册项。'],
        'entries': entries,
    }
    write_json(ROOT / 'public/data/catalog.json', catalog)
    report = {'version': catalog['version'], 'counts': counts, 'coverage': coverage, 'resourceFiles': count_files, 'resolvedModelFiles': len(raw_models), 'missingParents': failures, 'specialEntries': [entry['key'] for entry in entries if entry['status'] == 'special'], 'invisibleEntries': [entry['key'] for entry in entries if entry['status'] == 'invisible']}
    write_json(output / 'import-report.json', report)
    print(json.dumps({key: value for key, value in report.items() if key not in ('specialEntries',)}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
