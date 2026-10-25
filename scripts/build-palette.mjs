import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Manually transcribed from the nine user-supplied screenshots in references/mard to hex.
// HEX is the source of truth for opaque colors; H01's white HEX is only a
// display placeholder for the transparent bead, as clarified by the user.
// Do not sample the photographed color patches.
const sections = {
  A: 'FAF5CD FCFED6 FCFF92 F7EC5C F0D83A FDA951 FA8C4F FBDA4D F79D5F F47E38 FEDB99 FDA276 FEC667 F75842 FBF65E FEFF97 FDE173 FCBF80 FD7E77 F9D666 FAE393 EDF878 E4C8BA F3F6A9 FDF785 FFC734',
  B: 'DFF13B 64F343 A1F586 5FDF34 39E158 64E0A4 3EAE7C 1D9B54 2A5037 9AD1BA 627032 1A6E3D C8E87D ABE84F 305335 C0ED9C 9EB33E E6ED4F 26B78E CBECCF 18616A 0A4241 343B1A E8FAA6 4E846D 907C35 D0E0AF 9EE5BB C6DF5F E3FBB1 B4E691 92AD60',
  C: 'F0FEE4 ABF8FE A2E0F7 44CDFB 06AADF 54A7E9 3977CA 0F52BD 3349C3 3CBCE3 2ADED3 1E334E CDE7FE D5FCF7 21C5C4 1858A2 02D1F3 213244 18869D 1A70A9 BCDDFC 6BB1BB C8E2FD 7EC5F9 A9E8E0 42ADCF D0DEF9 BDCEE8 364A89',
  D: 'ACB7EF 868DD3 3554AF 162D7B B34EC6 B37BDC 8758A9 E3D2FE D5B9F4 301A49 BEB9E2 DC99CE B5038D 862993 2F1F8C E2E4F0 C7D3F9 9A64B8 D8C2D9 9A35AD 940595 38389A EADBF8 768AE1 4950C2 D6C6EB',
  E: 'F6D4CB FCC1DD F6BDE8 E8649E F0569F EB4172 C53674 FDDBE9 E376C7 D13B95 F7DAD4 F693BF B5026A FAD4BF F5C9CA FBF4EC F7E3EC F9C8DB F6BBD1 D7C6CE C09DA4 B38C9F 937D8A DEBEE5',
  F: 'FE9381 F63D4B EE4E3E FB2A40 E10328 913635 911932 BB0126 E0677A 874628 592323 F3536B F45C45 FCADB2 D50527 F8C0A9 E89B7D D07F4A BE454A C69495 F2B8C6 F7C3D0 ED806C E09DAF E84854',
  G: 'FFE4D3 FCC6AC F1C4A5 DCB387 E7B34E E3A014 985C3A 713D2F E4B685 DA8C42 DAC898 FEC993 B2714B 8B684C F6F8E3 F2D8C1 77544E FFE3D5 DD7D41 A5452F B38561',
  H: 'FFFFFF FBFBFB B4B4B4 878787 464648 2C2C2C 010101 E7D6DC EFEDEE EBEBEB CDCDCD FDF6EE F4EDF1 CED7D4 9AA6A6 1B1213 F0EEEF FCFFF6 F2EEE5 96A09F F8FBE6 CACAD2 9B9C94',
  M: 'BBC6B6 909994 697E81 E0D4BC D1CCAF B0AA86 B0A796 AE8082 A68862 C4B3BB 9D7693 644B51 C79266 C27563 747D7A',
};

const expectedCounts = { A: 26, B: 32, C: 29, D: 26, E: 24, F: 25, G: 21, H: 23, M: 15 };
const colors = Object.entries(sections).flatMap(([group, hexes]) => {
  const values = hexes.split(' ');
  if (values.length !== expectedCounts[group]) throw new Error(`Wrong ${group} count`);
  return values.map((hex, index) => {
    const color = { code: `${group}${String(index + 1).padStart(2, '0')}`, hex: `#${hex}`, group };
    if (color.code === 'H01') Object.assign(color, {
      name: '透明', transparent: true, finish: '透明豆',
      hexNote: 'HEX 仅为显示占位值，不代表白色；不参与不透明颜色匹配。',
    });
    if (color.code === 'H02') Object.assign(color, { name: '白色', transparent: false });
    return color;
  });
});
if (colors.length !== 221 || new Set(colors.map(c => c.code)).size !== 221) throw new Error('Palette must contain 221 unique codes');
if (colors.some(c => !/^#[0-9A-F]{6}$/.test(c.hex))) throw new Error('Invalid HEX value');

const palette = {
  name: 'MARD 221',
  source: '用户参考截图',
  sourceDirectory: 'references/mard to hex',
  transcription: '按截图 HEX 栏逐项录入；色号统一补零至两位；保留原分区 A–H、M。按用户校正，H01 为透明豆（HEX 仅作显示占位），H02 为白色。',
  groups: Object.entries(expectedCounts).map(([id, count]) => ({ id, count })),
  colors,
};
const destination = new URL('../public/data/palette.json', import.meta.url);
await mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
await writeFile(destination, `${JSON.stringify(palette, null, 2)}\n`, 'utf8');
console.log(`Wrote ${colors.length} colors to ${fileURLToPath(destination)}`);
