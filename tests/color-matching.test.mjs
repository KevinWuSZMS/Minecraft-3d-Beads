import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rgbToLab, deltaE2000, makeMatcher, createTextureMapper } from '../public/src/color-matching.js';

const palette = JSON.parse(fs.readFileSync(new URL('../public/data/palette.json', import.meta.url))).colors;
const fixture = (width, height, pixels) => ({ width, height, data: Uint8ClampedArray.from(pixels.flat()) });
const rgb = hex => hex.match(/[a-f0-9]{2}/gi).map(c => parseInt(c, 16));

test('CIEDE2000 agrees with published Sharma hue-wrap, neutral and large-distance fixtures', () => {
  // All 34 rows from the author's public implementation-verification dataset:
  // https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/dataNprograms/ciede2000testdata.txt
  const data = [
    [50,2.6772,-79.7751,50,0,-82.7485,2.0425],
    [50,3.1571,-77.2803,50,0,-82.7485,2.8615],
    [50,2.8361,-74.0200,50,0,-82.7485,3.4412],
    [50,-1.3802,-84.2814,50,0,-82.7485,1],
    [50,-1.1848,-84.8006,50,0,-82.7485,1],
    [50,-.9009,-85.5211,50,0,-82.7485,1],
    [50,0,0,50,-1,2,2.3669],
    [50,-1,2,50,0,0,2.3669],
    [50,2.49,-.001,50,-2.49,.0009,7.1792],
    [50,2.49,-.001,50,-2.49,.001,7.1792],
    [50,2.49,-.001,50,-2.49,.0011,7.2195],
    [50,2.49,-.001,50,-2.49,.0012,7.2195],
    [50,-.001,2.49,50,.0009,-2.49,4.8045],
    [50,-.001,2.49,50,.001,-2.49,4.8045],
    [50,-.001,2.49,50,.0011,-2.49,4.7461],
    [50,2.5,0,50,0,-2.5,4.3065],
    [50,2.5,0,73,25,-18,27.1492],
    [50,2.5,0,61,-5,29,22.8977],
    [50,2.5,0,56,-27,-3,31.9030],
    [50,2.5,0,58,24,15,19.4535],
    [50,2.5,0,50,3.1736,.5854,1],
    [50,2.5,0,50,3.2972,0,1],
    [50,2.5,0,50,1.8634,.5757,1],
    [50,2.5,0,50,3.2592,.3350,1],
    [60.2574,-34.0099,36.2677,60.4626,-34.1751,39.4387,1.2644],
    [63.0109,-31.0961,-5.8663,62.8187,-29.7946,-4.0864,1.2630],
    [61.2901,3.7196,-5.3901,61.4292,2.2480,-4.9620,1.8731],
    [35.0831,-44.1164,3.7933,35.0232,-40.0716,1.5901,1.8645],
    [22.7233,20.0904,-46.6940,23.0331,14.9730,-42.5619,2.0373],
    [36.4612,47.8580,18.3852,36.2715,50.5065,21.2231,1.4146],
    [90.8027,-2.0831,1.4410,91.1528,-1.6435,.0447,1.4441],
    [90.9257,-.5406,-.9208,88.6381,-.8985,-.7239,1.5381],
    [6.7747,-.2908,-2.4247,5.8714,-.0985,-2.2286,.6377],
    [2.0776,.0795,-1.135,.9033,-.0636,-.5514,.9082],
  ];
  for (const [i, row] of data.entries()) {
    const a = row.slice(0, 3), b = row.slice(3, 6);
    assert.ok(Math.abs(deltaE2000(a, b) - row[6]) < 0.000051, `reference ${i}: ${deltaE2000(a, b)}`);
    assert.ok(Math.abs(deltaE2000(a, b) - deltaE2000(b, a)) < 1e-10);
    assert.equal(deltaE2000(a, a), 0);
  }
});

test('exact palette colors and D65 neutral conversion stay exact', () => {
  const match = makeMatcher(palette);
  for (const color of palette.filter(color => !color.transparent)) assert.ok(deltaE2000(rgbToLab(rgb(color.hex)), rgbToLab(rgb(match(rgb(color.hex)).hex))) < 1e-7);
  const white = rgbToLab([255,255,255]);
  assert.ok(Math.abs(white[0] - 100) < 0.00001);
  assert.ok(Math.abs(white[1]) < 0.0001 && Math.abs(white[2]) < 0.0001);
  assert.deepEqual(rgbToLab([0,0,0]), [0,0,0]);
});

test('H01 is transparent, while opaque white always uses H02 in every color mode', () => {
  assert.equal(palette.find(color => color.code === 'H01').transparent, true);
  assert.equal(palette.find(color => color.code === 'H01').hex, '#FFFFFF');
  assert.equal(palette.find(color => color.code === 'H02').name, '白色');
  for (const metric of ['ciede2000', 'legacy', 'cie76']) {
    const match = makeMatcher(palette, { metric });
    assert.equal(match([255,255,255]).code, 'H02');
    for (const color of palette) assert.notEqual(match(rgb(color.hex)).code, 'H01');
  }
  const white = fixture(1,1,[[255,255,255,255]]);
  for (const mode of ['accurate', 'detail', 'legacy']) for (const mix2x2 of [false, true]) {
    const mapper = createTextureMapper(white,palette,{mode,mix2x2,fillTransparent:true});
    for(let sx=0;sx<2;sx++)for(let sy=0;sy<2;sy++)assert.equal(mapper.sample(0,0,sx,sy).code,'H02');
  }
});

test('optional H01 fill affects only alpha-zero samples within the face and never changes color optimization', () => {
  const tex = fixture(5,1,[[100,80,60,255],[250,0,250,0],[160,120,80,1],[160,120,80,128],[255,255,255,0]]);
  const h01 = palette.find(color=>color.code==='H01');
  for (const mode of ['accurate','detail','legacy']) for (const mix2x2 of [false,true]) {
    const options={mode,mix2x2,region:[0,0,4,1]};
    const empty=createTextureMapper(tex,palette,options);
    const filled=createTextureMapper(tex,palette,{...options,fillTransparent:true});
    assert.notStrictEqual(empty,filled);
    assert.strictEqual(filled,createTextureMapper(tex,palette,{...options,fillTransparent:true}));
    assert.equal(empty.sample(1,0),null);
    assert.equal(filled.sample(4,0),null);
    assert.equal(filled.sample(-1,0),null);
    assert.equal(filled.sample(NaN,0),null);
    for(let sx=0;sx<2;sx++)for(let sy=0;sy<2;sy++) {
      assert.strictEqual(filled.sample(1,0,sx,sy),h01);
      for (const x of [0,2,3]) assert.strictEqual(filled.sample(x,0,sx,sy),empty.sample(x,0,sx,sy));
      assert.strictEqual(filled.sample(2,0,sx,sy),filled.sample(3,0,sx,sy));
    }
    assert.equal(filled.stats.sourceEdges,0);
    assert.equal(filled.stats.sourceColors,2);
    for(const key of ['sourceColors','sourceEdges','collapsedEdges','changedMappings','mixedSourceColors','averageDeltaE2000','pixels'])
      assert.equal(filled.stats[key],empty.stats[key],key);
    assert.equal(filled.stats.transparentPixels,1);
    assert.equal(filled.stats.filledTransparentPixels,1);
    assert.equal(empty.stats.filledTransparentPixels,0);
    assert.equal(filled.stats.paletteColors,empty.stats.paletteColors+1);
  }
  const clear = fixture(1,1,[[255,0,255,0]]);
  const filled=createTextureMapper(clear,palette,{fillTransparent:true,mix2x2:true});
  assert.strictEqual(filled.sample(0,0),h01);
  assert.equal(filled.stats.sourceColors,0);
  assert.equal(filled.stats.pixels,0);
  assert.equal(filled.stats.paletteColors,1);
  assert.equal(filled.stats.averageDeltaE2000,0);
  assert.throws(()=>createTextureMapper(clear,[{code:'WHITE',hex:'#FFFFFF'}],{fillTransparent:true}),/H01/);
});

test('face region and transparent pixels never contribute cross-atlas neighbours or mixed beads', () => {
  const tex = fixture(4, 1, [[100,80,60,255], [160,120,80,255], [255,255,255,0], [0,255,0,255]]);
  const face = createTextureMapper(tex, palette, { region:[0,0,2,1], mode:'detail', mix2x2:true });
  const whole = createTextureMapper(tex, palette, { mode:'detail', mix2x2:true });
  assert.equal(face.stats.sourceColors, 2);
  assert.equal(face.sample(2,0,0,0), null);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) assert.equal(whole.sample(2,0,x,y), null);
  const tex2 = fixture(2,1,[[100,80,60,255],[160,120,80,255]]);
  const isolated = createTextureMapper(tex2,palette,{mode:'detail',mix2x2:true});
  for(let x=0;x<2;x++)for(let sx=0;sx<2;sx++)for(let sy=0;sy<2;sy++)assert.equal(face.sample(x,0,sx,sy).code,isolated.sample(x,0,sx,sy).code);
});

test('zero-width UV regions retain the one referenced texel', () => {
  const tex=fixture(2,1,[[10,20,30,255],[100,120,150,255]]);
  const mapper=createTextureMapper(tex,palette,{region:[2,0,2,1]});
  assert.deepEqual(mapper.stats.region,[1,0,2,1]);
  assert.ok(mapper.sample(1,0));
});

test('detail mode is deterministic, globally consistent per source color and bounded in extra color error', () => {
  const pixels=Array.from({length:64},(_,i)=>[...(i%2?[131,131,131]:[113,113,113]),255]);
  const tex=fixture(8,8,pixels);
  const colors=[{code:'D',hex:'#646464'},{code:'M',hex:'#7A7A7A'},{code:'L',hex:'#969696'}];
  const accurate=createTextureMapper(tex,colors,{mode:'accurate'});
  const detail=createTextureMapper(tex,colors,{mode:'detail'});
  assert.ok(detail.stats.boundaryCollapseRate < accurate.stats.boundaryCollapseRate);
  for(let y=0;y<8;y++)for(let x=0;x<8;x++) {
    assert.equal(detail.sample(x,y).code,detail.sample(x%2,0).code);
    const source=pixels[y*8+x].slice(0,3),base=accurate.sample(x,y),chosen=detail.sample(x,y);
    assert.ok(deltaE2000(rgbToLab(source),rgbToLab(rgb(chosen.hex)))<=deltaE2000(rgbToLab(source),rgbToLab(rgb(base.hex)))+5.500001);
  }
  assert.strictEqual(detail,createTextureMapper(tex,colors,{mode:'detail'}));
});

test('optional 2x2 mixing uses real opaque palette beads and improves linear-light average without leaking to neighbours', () => {
  // A transparent bead with an exactly matching placeholder HEX must not
  // become a nearest-color choice or enter any two-color mixture.
  const colors=[{code:'A',hex:'#647A64'},{code:'H01',hex:'#728A72',transparent:true},{code:'B',hex:'#7E967E'},{code:'BLACK',hex:'#000000'}];
  const tex=fixture(2,1,[[114,138,114,255],[0,0,0,255]]);
  const solid=createTextureMapper(tex,colors,{mode:'accurate'});
  const mixed=createTextureMapper(tex,colors,{mode:'accurate',mix2x2:true});
  assert.ok(mixed.stats.mixedSourceColors>0);
  assert.ok(mixed.stats.averageDeltaE2000<solid.stats.averageDeltaE2000);
  const seen=new Set();
  for(let sx=0;sx<2;sx++)for(let sy=0;sy<2;sy++) {
    const color=mixed.sample(0,0,sx,sy);seen.add(color.code);
    assert.ok(colors.includes(color));
    assert.notEqual(color.code,'H01');
    assert.equal(mixed.sample(1,0,sx,sy).code,'BLACK');
    assert.equal(mixed.sample(0,0,sx+2,sy+2).code,color.code);
  }
  assert.equal(seen.size,2);
  assert.notStrictEqual(mixed,solid);
});

test('cache separates mode, tint and palette', () => {
  const tex=fixture(1,1,[[120,120,120,255]]);
  const plain=createTextureMapper(tex,palette,{mode:'accurate'});
  const tinted=createTextureMapper(tex,palette,{mode:'accurate',tint:[0,1,0]});
  const other=createTextureMapper(tex,[{code:'ONLY',hex:'#FFFFFF'}],{mode:'accurate'});
  assert.notEqual(plain.sample(0,0).code,tinted.sample(0,0).code);
  assert.equal(other.sample(0,0).code,'ONLY');
});
