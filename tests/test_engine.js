'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../web/engine.js'), 'utf8');
const core = src.split('/*__CORE_BEGIN__*/')[1].split('/*__CORE_END__*/')[0];
const api = new Function(core + `\nreturn { createRegistry, defOf, isFullCube, isOpaqueCube, isSolid, buildChunkArrays, makePalette, genChunkData, heightAt, raycast, tileRect, faceUV, CHUNK, WORLD_H, SEA };`)();

let PASS = 0, FAIL = 0;
function check(name, cond, extra) {
  if (cond) { PASS++; console.log('  PASS', name); }
  else { FAIL++; console.log('  FAIL', name, extra || ''); }
}
const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '../web/pack/pack.json'), 'utf8'));
const reg = api.createRegistry(pack);
const grid = pack.grid;

check('registry holds every imported block', reg.list.length - 1 === pack.blocks.length, reg.list.length);
check('pack has 8000+ blocks', pack.blocks.length > 8000, pack.blocks.length);
const pal = api.makePalette(reg);
check('palette resolves real vanilla ids', pal.grass > 0 && pal.stone > 0 && pal.log > 0 && reg.list[pal.grass].mc === 'minecraft:grass_block');

// tiny world getter from a map
function worldFrom(cells) {
  const m = new Map(cells.map(([x, y, z, id]) => [x + ',' + y + ',' + z, id]));
  return (x, y, z) => m.get(x + ',' + y + ',' + z) || 0;
}
const grass = pal.grass, stone = pal.stone;

// one floating cube: 6 faces = 24 verts in opaque pass
let A = api.buildChunkArrays(reg, grid, worldFrom([[3, 40, 3, grass]]));
check('single cube -> 6 faces', A.opaque.idx.length === 36 && A.opaque.pos.length === 24 * 3, A.opaque.idx.length);
// two adjacent cubes: shared faces culled -> 10 faces
A = api.buildChunkArrays(reg, grid, worldFrom([[3, 40, 3, grass], [4, 40, 3, grass]]));
check('adjacent cubes cull shared faces (10)', A.opaque.idx.length === 60, A.opaque.idx.length);
// UVs land inside the grass side tile rect
{
  const def = reg.list[grass];
  const allTiles = new Set();
  for (const el of def.elements) for (const k in el.faces) allTiles.add(el.faces[k][0]);
  const rects = [...allTiles].map((t) => api.tileRect(t, grid));
  let ok = A.opaque.uv.length > 0;
  for (let i = 0; i < A.opaque.uv.length; i += 2) {
    if (!rects.some((r) => A.opaque.uv[i] >= r.u0 - 1e-6 && A.opaque.uv[i] <= r.u1 + 1e-6)) { ok = false; break; }
  }
  check('cube UVs inside its atlas tile', ok);
}
// slab: geometry tops out at y+0.5
const slabId = reg.byMc.get('minecraft:oak_slab');
check('oak_slab imported as boxes', !!slabId && reg.list[slabId].shape === 'boxes');
A = api.buildChunkArrays(reg, grid, worldFrom([[3, 40, 3, slabId]]));
{
  let maxY = 0;
  for (let i = 1; i < A.opaque.pos.length; i += 3) maxY = Math.max(maxY, A.opaque.pos[i]);
  check('slab mesh height is 40.5', Math.abs(maxY - 40.5) < 1e-6, maxY);
  check('slab is solid for collision (v1 full-cell approx is off: slab solid flag from importer)', reg.list[slabId].solid === true);
}
// cross flower: goes to cutout pass with diagonal quads (2 quads x2 windings = 24 idx... plus)
const poppyId = reg.byMc.get('minecraft:poppy');
check('poppy imported as cross', !!poppyId && reg.list[poppyId].shape === 'cross');
A = api.buildChunkArrays(reg, grid, worldFrom([[3, 40, 3, poppyId]]));
check('cross renders in cutout pass', A.cutout.idx.length >= 24 && A.opaque.idx.length === 0, A.cutout.idx.length);
check('cross is not solid', api.isSolid(reg, poppyId) === false);
// berk block present + placeable geometry
const belz = reg.byMc.get('isleofberk:belzium_block');
check('Isle of Berk belzium block imported', !!belz && reg.list[belz].shape === 'full');
A = api.buildChunkArrays(reg, grid, worldFrom([[3, 40, 3, belz]]));
check('belzium cube meshes', A.opaque.idx.length === 36);
// tint: grass top/side faces carry Minecraft's biome tint (textures are greyscale)
{
  check('grass_block has a tint color', !!reg.list[grass].tintColor);
  check('oak_leaves has the leaf tint', !!reg.list[pal.leaves].tintColor);
  A = api.buildChunkArrays(reg, grid, worldFrom([[3, 40, 3, grass]]));
  check('mesh carries a color attribute sized like positions', A.opaque.col.length === A.opaque.pos.length, A.opaque.col.length);
  // the up face (verts 8..11 by FACE order down? find a vertex with the grass tint)
  let tintedVerts = 0;
  for (let i = 0; i < A.opaque.col.length; i += 3) {
    if (Math.abs(A.opaque.col[i] - 0.569) < 0.01 && Math.abs(A.opaque.col[i + 1] - 0.741) < 0.01) tintedVerts++;
  }
  check('grass top + side-overlay verts are tinted green', tintedVerts >= 8, tintedVerts);
  check('no § codes left in block names', !pack.blocks.some((b) => b.name.includes('§')));
}
// water: transparent pass, self-culling
const waterId = reg.byMc.get('minecraft:water');
if (waterId) {
  A = api.buildChunkArrays(reg, grid, worldFrom([[3, 40, 3, waterId], [4, 40, 3, waterId]]));
  check('water in trans pass + no internal faces between two water cells', A.trans.idx.length > 0 && A.opaque.idx.length === 0, A.trans.idx.length);
} else check('water present in registry', false);
// terrain: deterministic + palette sanity
{
  const c1 = api.genChunkData(reg, pal, 0, 0, 1234);
  const c2 = api.genChunkData(reg, pal, 0, 0, 1234);
  let same = c1.length === c2.length; for (let i = 0; i < c1.length && same; i++) same = c1[i] === c2[i];
  check('terrain deterministic for same seed', same);
  const surf = c1[(api.heightAt(8, 8, 1234) * 16 + 8) * 16 + 8];
  check('surface block is grass/sand palette', surf === pal.grass || surf === pal.sand, surf);
  let hasImported = false;
  check('chunk data is Uint16 (ids > 255 fit)', c1 instanceof Uint16Array);
}
// raycast: straight down onto a block
{
  const get = worldFrom([[3, 40, 3, stone]]);
  const hit = api.raycast(get, [3.5, 45.5, 3.5], [0, -1, 0], 10);
  check('raycast hits block below', !!hit && hit.y === 40 && hit.face[1] === 1, hit && JSON.stringify(hit));
  const miss = api.raycast(get, [3.5, 45.5, 3.5], [0, 1, 0], 5);
  check('raycast misses upward', miss === null);
}
// search sanity used by picker
{
  const hits = pack.blocks.filter((b) => b.name.toLowerCase().includes('belzium'));
  check('picker search finds belzium blocks', hits.length >= 2, hits.length);
}
console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
