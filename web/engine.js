'use strict';
/* Berk Engine (web) — a brand-new voxel engine written for one job:
 * playing the Claws of Berk content pack in a browser.
 *
 * It is NOT Minecraft and contains no Mojang/Forge code. The pack's
 * blocks arrive as data (models -> boxes, textures -> one atlas) via
 * importer/import_pack2.py, and this engine renders that data:
 * full cubes, shaped boxes (slabs, stairs, doors...), and cross
 * plants, with break/place, terrain, and a searchable block picker.
 *
 * Split like its sibling engines: CORE (pure logic, Node-testable)
 * between __CORE_BEGIN__/__CORE_END__, then the GAME (DOM + THREE).
 */

/*__CORE_BEGIN__*/

function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function hash3(ix, iy, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 2246822519) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function valueNoise2(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  const ux = smooth(fx), uz = smooth(fz);
  return (a + (b - a) * ux) * (1 - uz) + (c + (d - c) * ux) * uz;
}
function fbm2(x, z, seed, oct) {
  let v = 0, amp = 0.5, f = 1, tot = 0;
  for (let i = 0; i < oct; i++) { v += amp * valueNoise2(x * f, z * f, (seed + i * 101) | 0); tot += amp; amp *= 0.5; f *= 2.03; }
  return v / tot;
}

const CHUNK = 16, WORLD_H = 80, SEA = 30;

/* ---------------- registry ---------------- */
const GRASS_TINT = [0.569, 0.741, 0.349], LEAF_TINT = [0.467, 0.671, 0.184], WATER_TINT = [0.247, 0.463, 0.894];
function createRegistry(pack) {
  const list = [null];
  const byMc = new Map();
  (pack.blocks || []).forEach((b, i) => {
    const id = i + 1;
    list[id] = Object.assign({ id }, b);
    byMc.set(b.mc, id);
  });
  // Minecraft tints some textures in code (grass/leaves/water are stored
  // near-greyscale). Faces whose model sets tintindex carry flag [2]; a few
  // blocks (water, grass plants) are tinted without model flags.
  for (const d of list) {
    if (!d) continue;
    let flagged = false;
    for (const el of d.elements || []) for (const k in el.faces) if (el.faces[k][2]) flagged = true;
    const ruleAll = d.mc === 'minecraft:water' || (d.shape === 'cross' && /grass|fern/.test(d.mc || ''));
    if (!flagged && !ruleAll) continue;
    d.tintColor = d.mc === 'minecraft:water' ? WATER_TINT
      : /leaves|vine/.test(d.mc || '') ? LEAF_TINT : GRASS_TINT;
    if (ruleAll) d.tintAll = true;
  }
  return { list, byMc, pack };
}
function defOf(reg, id) { return reg.list[id] || null; }
function isFullCube(reg, id) { const d = defOf(reg, id); return !!d && d.shape === 'full'; }
function isOpaqueCube(reg, id) { const d = defOf(reg, id); return !!d && d.shape === 'full' && d.alpha === 'opaque'; }
function isSolid(reg, id) { const d = defOf(reg, id); return !!d && !!d.solid; }

/* ---------------- atlas UV ---------------- */
// Face uv from the pack is in 0..16 texture space (v measured from the TOP
// of the texture, Minecraft style). Atlas tiles sit in a grid; THREE UVs
// have origin bottom-left with flipY textures, handled in tileRect.
function tileRect(tile, grid) {
  const col = tile % grid, row = Math.floor(tile / grid);
  const e = 0.02 / grid; // tiny inset against bleeding
  return { u0: col / grid + e, u1: (col + 1) / grid - e, vTop: 1 - row / grid - e, vBot: 1 - (row + 1) / grid + e };
}
function faceUV(rect, uv) {
  // uv = [u1, v1, u2, v2] in 0..16 -> returns function (fu, fv) with
  // fu, fv in 0..1 across the face's own uv rect.
  return (fu, fv) => [
    rect.u0 + ((uv[0] + fu * (uv[2] - uv[0])) / 16) * (rect.u1 - rect.u0),
    rect.vTop - ((uv[1] + fv * (uv[3] - uv[1])) / 16) * (rect.vTop - rect.vBot),
  ];
}

/* ---------------- meshing ---------------- */
// Face corner templates for a box [f,t] (16ths). Corners CCW from outside.
const FACE_GEO = {
  up:    { n: [0, 1, 0],  c: (f, t) => [[f[0], t[1], f[2]], [f[0], t[1], t[2]], [t[0], t[1], t[2]], [t[0], t[1], f[2]]], a: 0, b: 2, bFlip: false },
  down:  { n: [0, -1, 0], c: (f, t) => [[f[0], f[1], f[2]], [t[0], f[1], f[2]], [t[0], f[1], t[2]], [f[0], f[1], t[2]]], a: 0, b: 2, bFlip: true },
  east:  { n: [1, 0, 0],  c: (f, t) => [[t[0], f[1], t[2]], [t[0], f[1], f[2]], [t[0], t[1], f[2]], [t[0], t[1], t[2]]], a: 2, b: 1, bFlip: true },
  west:  { n: [-1, 0, 0], c: (f, t) => [[f[0], f[1], f[2]], [f[0], f[1], t[2]], [f[0], t[1], t[2]], [f[0], t[1], f[2]]], a: 2, b: 1, bFlip: true },
  south: { n: [0, 0, 1],  c: (f, t) => [[f[0], f[1], t[2]], [t[0], f[1], t[2]], [t[0], t[1], t[2]], [f[0], t[1], t[2]]], a: 0, b: 1, bFlip: true },
  north: { n: [0, 0, -1], c: (f, t) => [[t[0], f[1], f[2]], [f[0], f[1], f[2]], [f[0], t[1], f[2]], [t[0], t[1], f[2]]], a: 0, b: 1, bFlip: true },
};
const DIR_VEC = { up: [0, 1, 0], down: [0, -1, 0], east: [1, 0, 0], west: [-1, 0, 0], south: [0, 0, 1], north: [0, 0, -1] };

const WHITE3 = [1, 1, 1];
function pushQuad(A, corners, normal, uvFn, uvPts, color) {
  const base = A.pos.length / 3;
  const c = color || WHITE3;
  for (let k = 0; k < 4; k++) {
    A.pos.push(corners[k][0], corners[k][1], corners[k][2]);
    A.nor.push(normal[0], normal[1], normal[2]);
    A.col.push(c[0], c[1], c[2]);
    const uv = uvFn(uvPts[k][0], uvPts[k][1]);
    A.uv.push(uv[0], uv[1]);
  }
  A.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
function faceColor(d, faceArr) {
  if (!d.tintColor) return WHITE3;
  return (faceArr && faceArr[2]) || d.tintAll ? d.tintColor : WHITE3;
}

// Build geometry arrays for a chunk. get(x,y,z) -> block id in world coords
// relative to the chunk origin (may query outside for neighbours).
function buildChunkArrays(reg, grid, get) {
  const P = { opaque: { pos: [], nor: [], uv: [], idx: [], col: [] },
              cutout: { pos: [], nor: [], uv: [], idx: [], col: [] },
              trans: { pos: [], nor: [], uv: [], idx: [], col: [] } };
  const passOf = (d) => d.alpha === 'transparent' ? P.trans : d.alpha === 'cutout' ? P.cutout : P.opaque;
  for (let y = 0; y < WORLD_H; y++) for (let z = 0; z < CHUNK; z++) for (let x = 0; x < CHUNK; x++) {
    const id = get(x, y, z);
    if (!id) continue;
    const d = defOf(reg, id);
    if (!d) continue;
    const A = passOf(d);
    if (d.shape === 'cross') {
      const rect = tileRect(d.tile, grid);
      const uvFn = faceUV(rect, [0, 0, 16, 16]);
      const inset = 0.02;
      const quads = [
        [[x + inset, y, z + inset], [x + 1 - inset, y, z + 1 - inset], [x + 1 - inset, y + 1, z + 1 - inset], [x + inset, y + 1, z + inset]],
        [[x + 1 - inset, y, z + inset], [x + inset, y, z + 1 - inset], [x + inset, y + 1, z + 1 - inset], [x + 1 - inset, y + 1, z + inset]],
      ];
      for (const q of quads) {
        pushQuad(A, q, [0, 1, 0], uvFn, [[0, 1], [1, 1], [1, 0], [0, 0]], faceColor(d, null));
        const base = A.pos.length / 3 - 4; // reverse winding twin (double-sided)
        A.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
      continue;
    }
    const full = d.shape === 'full';
    // Candidate faces per direction@plane: when a block stacks an overlay
    // element on the same plane (grass sides), the TINTED face wins — that
    // overlay is what you actually see in Minecraft.
    const cands = new Map();
    for (const el of d.elements || []) {
      const f = el.f, t = el.t;
      for (const dir in el.faces) {
        if (!FACE_GEO[dir]) continue;
        const plane = dir === 'up' ? t[1] : dir === 'down' ? f[1] : dir === 'east' ? t[0] : dir === 'west' ? f[0] : dir === 'south' ? t[2] : f[2];
        const ekey = dir + '@' + plane;
        const prev = cands.get(ekey);
        const tinted = !!(el.faces[dir][2]);
        if (!prev || (tinted && !prev.tinted)) cands.set(ekey, { el, dir, tinted });
      }
    }
    for (const { el, dir } of cands.values()) {
      const f = el.f, t = el.t;
      {
        const g = FACE_GEO[dir];
        const faceArr = el.faces[dir];
        const [tile, uv] = faceArr;
        const vec = DIR_VEC[dir];
        const nb = get(x + vec[0], y + vec[1], z + vec[2]);
        if (full) {
          if (isOpaqueCube(reg, nb)) continue;
          if (nb === id && d.alpha === 'transparent') continue;
        } else {
          // shaped blocks: only cull boundary faces hidden by a full opaque neighbour
          const onBoundary = (dir === 'up' && t[1] >= 16) || (dir === 'down' && f[1] <= 0) ||
            (dir === 'east' && t[0] >= 16) || (dir === 'west' && f[0] <= 0) ||
            (dir === 'south' && t[2] >= 16) || (dir === 'north' && f[2] <= 0);
          if (onBoundary && isOpaqueCube(reg, nb)) continue;
          if (nb === id && d.alpha === 'transparent') continue;
        }
        const rect = tileRect(tile, grid);
        const uvFn = faceUV(rect, uv);
        const corners = g.c(f, t).map((p) => [x + p[0] / 16, y + p[1] / 16, z + p[2] / 16]);
        const aMin = f[g.a], aMax = t[g.a], bMin = f[g.b], bMax = t[g.b];
        const uvPts = g.c(f, t).map((p) => {
          const fu = aMax === aMin ? 0 : (p[g.a] - aMin) / (aMax - aMin);
          let fv = bMax === bMin ? 0 : (p[g.b] - bMin) / (bMax - bMin);
          if (g.bFlip) fv = 1 - fv;
          return [fu, fv];
        });
        pushQuad(A, corners, g.n, uvFn, uvPts, faceColor(d, faceArr));
      }
    }
  }
  return P;
}

/* ---------------- terrain ---------------- */
function makePalette(reg) {
  const pick = (mc, fallbackName) => {
    if (reg.byMc.has(mc)) return reg.byMc.get(mc);
    const hit = reg.list.find((b) => b && b.name && b.name.toLowerCase().includes(fallbackName));
    return hit ? hit.id : 1;
  };
  return {
    grass: pick('minecraft:grass_block', 'grass block'),
    dirt: pick('minecraft:dirt', 'dirt'),
    stone: pick('minecraft:stone', 'stone'),
    sand: pick('minecraft:sand', 'sand'),
    log: pick('minecraft:oak_log', 'log'),
    leaves: pick('minecraft:oak_leaves', 'leaves'),
    water: reg.byMc.get('minecraft:water') || 0,
    bedrock: pick('minecraft:bedrock', 'bedrock'),
  };
}
function heightAt(wx, wz, seed) {
  const n = fbm2(wx * 0.016, wz * 0.016, seed, 4);
  const d = fbm2(wx * 0.055 + 1000, wz * 0.055 - 1000, seed ^ 0x9e37, 2);
  return Math.floor(34 + (n - 0.5) * 26 + (d - 0.5) * 6); // ~18..50
}
function genChunkData(reg, pal, cx, cz, seed) {
  const data = new Uint16Array(CHUNK * WORLD_H * CHUNK);
  const at = (x, y, z) => (y * CHUNK + z) * CHUNK + x;
  const set = (x, y, z, id) => { if (x >= 0 && x < CHUNK && z >= 0 && z < CHUNK && y >= 0 && y < WORLD_H) data[at(x, y, z)] = id; };
  const get = (x, y, z) => (x < 0 || x >= CHUNK || z < 0 || z >= CHUNK || y < 0 || y >= WORLD_H) ? 0 : data[at(x, y, z)];
  for (let lx = 0; lx < CHUNK; lx++) for (let lz = 0; lz < CHUNK; lz++) {
    const wx = cx * CHUNK + lx, wz = cz * CHUNK + lz;
    const h = heightAt(wx, wz, seed);
    const beach = h <= SEA + 1;
    for (let y = 0; y <= h; y++) {
      let id;
      if (y === 0) id = pal.bedrock;
      else if (y < h - 2) id = pal.stone;
      else if (y < h) id = beach ? pal.sand : pal.dirt;
      else id = beach ? pal.sand : pal.grass;
      set(lx, y, lz, id);
    }
    if (pal.water) for (let y = h + 1; y <= SEA; y++) set(lx, y, lz, pal.water);
  }
  for (let lx = 0; lx < CHUNK; lx++) for (let lz = 0; lz < CHUNK; lz++) {
    const wx = cx * CHUNK + lx, wz = cz * CHUNK + lz;
    if (hash2(wx, wz, seed ^ 0x51ab) > 0.010) continue;
    const h = heightAt(wx, wz, seed);
    if (h <= SEA + 1 || h + 9 >= WORLD_H) continue;
    const trunkH = 4 + Math.floor(hash2(wx ^ 0x123, wz ^ 0x456, seed) * 2);
    for (let i = 1; i <= trunkH; i++) set(lx, h + i, lz, pal.log);
    for (let dy = trunkH - 2; dy <= trunkH + 1; dy++) {
      const rad = dy <= trunkH - 1 ? 2 : 1;
      for (let dx = -rad; dx <= rad; dx++) for (let dz = -rad; dz <= rad; dz++) {
        if (dx === 0 && dz === 0 && dy < trunkH) continue;
        if (Math.abs(dx) === rad && Math.abs(dz) === rad && hash3(wx + dx, h + dy, wz + dz, seed ^ 0x77) < 0.6) continue;
        if (get(lx + dx, h + dy, lz + dz) === 0) set(lx + dx, h + dy, lz + dz, pal.leaves);
      }
    }
    if (get(lx, h + trunkH + 2, lz) === 0) set(lx, h + trunkH + 2, lz, pal.leaves);
  }
  return data;
}

/* ---------------- voxel raycast (Amanatides & Woo) ---------------- */
function raycast(get, origin, dir, maxDist) {
  let x = Math.floor(origin[0]), y = Math.floor(origin[1]), z = Math.floor(origin[2]);
  const step = [Math.sign(dir[0]), Math.sign(dir[1]), Math.sign(dir[2])];
  const tDelta = [step[0] ? Math.abs(1 / dir[0]) : Infinity, step[1] ? Math.abs(1 / dir[1]) : Infinity, step[2] ? Math.abs(1 / dir[2]) : Infinity];
  const frac = [origin[0] - x, origin[1] - y, origin[2] - z];
  const tMax = [
    step[0] > 0 ? (1 - frac[0]) * tDelta[0] : step[0] < 0 ? frac[0] * tDelta[0] : Infinity,
    step[1] > 0 ? (1 - frac[1]) * tDelta[1] : step[1] < 0 ? frac[1] * tDelta[1] : Infinity,
    step[2] > 0 ? (1 - frac[2]) * tDelta[2] : step[2] < 0 ? frac[2] * tDelta[2] : Infinity,
  ];
  let face = [0, 0, 0], t = 0;
  for (let i = 0; i < 256; i++) {
    const id = get(x, y, z);
    if (id) return { x, y, z, id, face, dist: t };
    if (tMax[0] < tMax[1] && tMax[0] < tMax[2]) { x += step[0]; t = tMax[0]; tMax[0] += tDelta[0]; face = [-step[0], 0, 0]; }
    else if (tMax[1] < tMax[2]) { y += step[1]; t = tMax[1]; tMax[1] += tDelta[1]; face = [0, -step[1], 0]; }
    else { z += step[2]; t = tMax[2]; tMax[2] += tDelta[2]; face = [0, 0, -step[2]]; }
    if (t > maxDist) return null;
  }
  return null;
}

/* ---------------- survival: health / hunger / experience ---------------- */
// Health and food are in half-units like Minecraft (20 = 10 hearts/shanks).
function makeSurvival() {
  return { health: 20, food: 20, sat: 5, xp: 0, level: 0, exh: 0, regenT: 0, starveT: 0 };
}
// Points needed to go from `level` to level+1 (vanilla formula).
function xpNeed(level) { return level < 16 ? 2 * level + 7 : level < 31 ? 5 * level - 38 : 9 * level - 158; }
function addXp(s, points) {
  let ups = 0;
  s.xp += points;
  while (s.xp >= xpNeed(s.level)) { s.xp -= xpNeed(s.level); s.level++; ups++; }
  return ups;
}
function fallDamage(dist) { return dist <= 3.5 ? 0 : Math.floor(dist - 3); }
function hurtSurv(s, dmg) { if (dmg > 0) s.health = Math.max(0, s.health - dmg); return s.health <= 0; }
function eatFood(s, amount, satAmt) {
  s.food = Math.min(20, s.food + amount);
  s.sat = Math.min(s.food, s.sat + (satAmt || 0));
}
// act: {moving, sprinting}. Hunger drains through saturation first; a full
// belly (food >= 18) regenerates health; an empty one starves down to 1 hp.
function tickSurvival(s, dt, act) {
  if (s.health <= 0) return;
  const rate = act.sprinting && act.moving ? 0.16 : act.moving ? 0.05 : 0.014;
  s.exh += rate * dt;
  while (s.exh >= 1) {
    s.exh -= 1;
    if (s.sat > 0) s.sat = Math.max(0, s.sat - 1);
    else if (s.food > 0) s.food--;
  }
  if (s.food >= 18 && s.health < 20) {
    s.regenT += dt;
    if (s.regenT >= 0.6) { s.regenT = 0; s.health++; s.exh += 0.9; }
  } else s.regenT = 0;
  if (s.food <= 0 && s.health > 1) {
    s.starveT += dt;
    if (s.starveT >= 1.2) { s.starveT = 0; s.health--; }
  } else s.starveT = 0;
}

/*__CORE_END__*/

/*__ENT_BEGIN__*/
/* ---------------- entities: molang, animation, geometry, AI ---------------- */
// Tiny safe evaluator for the Molang subset GeckoLib animations use:
// numbers, + - * /, parens, math.sin/cos/abs, query.anim_time. No eval().
function evalMolang(src, t) {
  if (typeof src === 'number') return src;
  if (typeof src !== 'string') return 0;
  let i = 0;
  const s = src.replace(/\s+/g, '');
  function peek() { return s[i]; }
  function eat(ch) { if (s[i] === ch) { i++; return true; } return false; }
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') { const op = s[i++]; const r = factor(); v = op === '*' ? v * r : v / r; }
    return v;
  }
  function factor() {
    if (eat('-')) return -factor();
    if (eat('(')) { const v = expr(); eat(')'); return v; }
    if (s.startsWith('math.sin', i)) { i += 8; eat('('); const v = expr(); eat(')'); return Math.sin(v); }
    if (s.startsWith('math.cos', i)) { i += 8; eat('('); const v = expr(); eat(')'); return Math.cos(v); }
    if (s.startsWith('math.abs', i)) { i += 8; eat('('); const v = expr(); eat(')'); return Math.abs(v); }
    if (s.startsWith('query.anim_time', i)) { i += 15; return t; }
    const m = /^[0-9]*\.?[0-9]+/.exec(s.slice(i));
    if (m) { i += m[0].length; return parseFloat(m[0]); }
    throw new Error('molang: cannot parse ' + src);
  }
  try { const v = expr(); return isFinite(v) ? v : 0; } catch (e) { return 0; }
}
function compVal(v, t) { return typeof v === 'string' ? evalMolang(v, t) : (typeof v === 'number' ? v : 0); }

// Keyframes: [[time, [x,y,z]], ...] sorted. Components may be Molang strings.
function sampleChannel(kfs, t, len, loop) {
  if (!kfs || !kfs.length) return [0, 0, 0];
  if (kfs.length === 1) return kfs[0][1].map((v) => compVal(v, t));
  let tt = t;
  if (len > 0) tt = loop ? ((t % len) + len) % len : Math.min(t, len);
  if (tt <= kfs[0][0]) return kfs[0][1].map((v) => compVal(v, t));
  for (let k = 0; k < kfs.length - 1; k++) {
    const t0 = kfs[k][0], t1 = kfs[k + 1][0];
    if (tt >= t0 && tt <= t1) {
      const f = t1 === t0 ? 0 : (tt - t0) / (t1 - t0);
      return kfs[k][1].map((v, j) => {
        const a = compVal(v, t), b = compVal(kfs[k + 1][1][j], t);
        return a + (b - a) * f;
      });
    }
  }
  return kfs[kfs.length - 1][1].map((v) => compVal(v, t));
}

// Small mat3 helpers for rotated cubes (bedrock cubes may carry a rotation
// about a pivot). Euler XYZ, degrees in.
function rotMat3(rx, ry, rz) {
  const D = Math.PI / 180;
  const cx = Math.cos(rx * D), sx = Math.sin(rx * D);
  const cy = Math.cos(ry * D), sy = Math.sin(ry * D);
  const cz = Math.cos(rz * D), sz = Math.sin(rz * D);
  // R = Rx * Ry * Rz
  return [
    cy * cz, -cy * sz, sy,
    cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy,
    sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy,
  ];
}
function applyMat3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

// Build one bone's render geometry (positions relative to the bone pivot,
// in blocks; uv into the entity atlas; normals per face).
const ENT_FACE = {
  // dir vector, corner template over [f,t], uv axis a, axis b, bFlip, flipU
  north: { n: [0, 0, -1], c: (f, t) => [[t[0], f[1], f[2]], [f[0], f[1], f[2]], [f[0], t[1], f[2]], [t[0], t[1], f[2]]], a: 0, b: 1, bFlip: true, flipU: true },
  south: { n: [0, 0, 1], c: (f, t) => [[f[0], f[1], t[2]], [t[0], f[1], t[2]], [t[0], t[1], t[2]], [f[0], t[1], t[2]]], a: 0, b: 1, bFlip: true, flipU: false },
  east: { n: [1, 0, 0], c: (f, t) => [[t[0], f[1], t[2]], [t[0], f[1], f[2]], [t[0], t[1], f[2]], [t[0], t[1], t[2]]], a: 2, b: 1, bFlip: true, flipU: true },
  west: { n: [-1, 0, 0], c: (f, t) => [[f[0], f[1], f[2]], [f[0], f[1], t[2]], [f[0], t[1], t[2]], [f[0], t[1], f[2]]], a: 2, b: 1, bFlip: true, flipU: false },
  up: { n: [0, 1, 0], c: (f, t) => [[f[0], t[1], f[2]], [f[0], t[1], t[2]], [t[0], t[1], t[2]], [t[0], t[1], f[2]]], a: 0, b: 2, bFlip: false, flipU: false },
  down: { n: [0, -1, 0], c: (f, t) => [[f[0], f[1], f[2]], [t[0], f[1], f[2]], [t[0], f[1], t[2]], [f[0], f[1], t[2]]], a: 0, b: 2, bFlip: true, flipU: false },
};
function buildBoneGeometry(species, bone, atlasSize, rectOverride) {
  const pos = [], nor = [], uv = [], idx = [];
  const [rx, ry, rw, rh] = rectOverride || species.tex_rect;
  const [aw, ah] = atlasSize;
  const bp = bone.pivot;
  for (const cube of bone.cubes) {
    const f = cube.o, t = [cube.o[0] + cube.s[0], cube.o[1] + cube.s[1], cube.o[2] + cube.s[2]];
    let M = null, piv = null;
    if (cube.r && (cube.r[0] || cube.r[1] || cube.r[2])) { M = rotMat3(cube.r[0], cube.r[1], cube.r[2]); piv = cube.p || bp; }
    const xform = (p) => {
      let q = [p[0], p[1], p[2]];
      if (M) { const rel = [q[0] - piv[0], q[1] - piv[1], q[2] - piv[2]]; const rr = applyMat3(M, rel); q = [rr[0] + piv[0], rr[1] + piv[1], rr[2] + piv[2]]; }
      return [(q[0] - bp[0]) / 16, (q[1] - bp[1]) / 16, (q[2] - bp[2]) / 16];
    };
    for (const dir in cube.faces) {
      const g = ENT_FACE[dir];
      if (!g) continue;
      const [fu, fv, fw, fh] = cube.faces[dir];
      const base = pos.length / 3;
      const corners = g.c(f, t);
      const aMin = f[g.a], aMax = t[g.a], bMin = f[g.b], bMax = t[g.b];
      const nrm = M ? applyMat3(M, g.n) : g.n;
      for (let k = 0; k < 4; k++) {
        const world = xform(corners[k]);
        pos.push(world[0], world[1], world[2]);
        nor.push(nrm[0], nrm[1], nrm[2]);
        let fuFrac = aMax === aMin ? 0 : (corners[k][g.a] - aMin) / (aMax - aMin);
        if (g.flipU) fuFrac = 1 - fuFrac;
        let fvFrac = bMax === bMin ? 0 : (corners[k][g.b] - bMin) / (bMax - bMin);
        if (g.bFlip) fvFrac = 1 - fvFrac;
        const U = (rx + fu + fuFrac * fw) / aw;
        const V = 1 - (ry + fv + fvFrac * fh) / ah;
        uv.push(U, V);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return { pos, nor, uv, idx };
}

// ---- dragon AI: a small deterministic state machine (env injected) ----
// states: idle -> walk -> idle -> fly (circle) -> land -> idle; 'ridden' is
// driven by the game, not here. env: { groundH(x,z), rand() }
function createDragon(spId, x, y, z, rand) {
  return {
    sp: spId, pos: [x, y, z], yaw: rand() * Math.PI * 2, targetYaw: 0,
    state: 'idle', timer: 1 + rand() * 3, phase: rand() * 10,
    circleC: [x, z], circleR: 16, circleA: rand() * Math.PI * 2, alt: 0, speed: 0,
    trust: 0, tamed: false, treatCd: 0, skin: 0,
  };
}
// Three treats tame a dragon. Returns true when this treat tames it.
function addTrust(d) {
  d.trust = Math.min(1, Math.round((d.trust + 0.34) * 100) / 100);
  if (d.trust >= 0.99 && !d.tamed) { d.tamed = true; return true; }
  return false;
}
function angLerp(a, b, f) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}
function stepDragon(d, dt, env) {
  d.timer -= dt;
  if (d.treatCd > 0) d.treatCd -= dt;
  const g = env.groundH(d.pos[0], d.pos[2]);
  // tamed dragons come to their rider when called by distance
  if (d.tamed && env.playerPos && (d.state === 'idle' || d.state === 'walk')) {
    const dx = env.playerPos[0] - d.pos[0], dz = env.playerPos[2] - d.pos[2];
    const dist = Math.hypot(dx, dz);
    if (dist > 6) { d.state = 'walk'; d.timer = Math.max(d.timer, 0.6); d.targetYaw = Math.atan2(-dx, -dz); }
    else if (dist < 3.2 && d.state === 'walk') { d.state = 'idle'; d.timer = 1.5; }
  }
  if (d.state === 'idle') {
    d.speed = 0;
    d.pos[1] += (g - d.pos[1]) * Math.min(1, dt * 8);
    if (d.timer <= 0) {
      const r = env.rand();
      if (r < 0.22) { d.state = 'fly'; d.timer = 10 + env.rand() * 10; d.circleC = [d.pos[0], d.pos[2]]; d.circleR = 13 + env.rand() * 9; d.alt = g + 9 + env.rand() * 6; }
      else { d.state = 'walk'; d.timer = 3 + env.rand() * 3; d.targetYaw = d.yaw + (env.rand() - 0.5) * 2.4; }
    }
  } else if (d.state === 'walk') {
    d.yaw = angLerp(d.yaw, d.targetYaw, Math.min(1, dt * 2));
    d.speed = 1.3;
    d.pos[0] += -Math.sin(d.yaw) * d.speed * dt;
    d.pos[2] += -Math.cos(d.yaw) * d.speed * dt;
    d.pos[1] += (g - d.pos[1]) * Math.min(1, dt * 8);
    if (d.timer <= 0) { d.state = 'idle'; d.timer = 2 + env.rand() * 4; }
  } else if (d.state === 'fly') {
    d.circleA += dt * (2.2 / d.circleR) * 2.2;
    const tx = d.circleC[0] + Math.cos(d.circleA) * d.circleR;
    const tz = d.circleC[1] + Math.sin(d.circleA) * d.circleR;
    const dx = tx - d.pos[0], dz = tz - d.pos[2];
    d.targetYaw = Math.atan2(-dx, -dz);
    d.yaw = angLerp(d.yaw, d.targetYaw, Math.min(1, dt * 3));
    d.speed = 4.5;
    d.pos[0] += -Math.sin(d.yaw) * d.speed * dt;
    d.pos[2] += -Math.cos(d.yaw) * d.speed * dt;
    d.pos[1] += (d.alt - d.pos[1]) * Math.min(1, dt * 1.5);
    if (d.timer <= 0) { d.state = 'land'; d.timer = 8; }
  } else if (d.state === 'land') {
    d.speed = 2.2;
    d.pos[0] += -Math.sin(d.yaw) * d.speed * dt;
    d.pos[2] += -Math.cos(d.yaw) * d.speed * dt;
    d.pos[1] += (g - d.pos[1]) * Math.min(1, dt * 1.2);
    if (Math.abs(d.pos[1] - g) < 0.15 || d.timer <= 0) { d.pos[1] = g; d.state = 'idle'; d.timer = 2 + env.rand() * 3; }
  }
  return d;
}
// Saddle point: sit on the Chest bone (present in every IoB dragon).
function saddleOffset(species) {
  const chest = (species.bones || []).find((b) => b.name === 'Chest') || (species.bones || []).find((b) => b.name === 'root');
  if (!chest) return [0, 1.6, 0];
  return [chest.pivot[0] / 16, chest.pivot[1] / 16 + 0.95, chest.pivot[2] / 16];
}
/*__ENT_END__*/


/* ================= GAME (DOM + THREE) ================= */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
if (typeof THREE === 'undefined') { $('title-body').innerHTML = '<h2>Failed to start</h2><p>three.min.js did not load.</p>'; return; }

let PACK = null, REG = null, PAL = null, ATLAS_IMG = null;
let ENT = null, ENT_ATLAS_IMG = null, entTex = null, entMat = null;
let dragons = [], riding = null;
let renderer, scene, camera, matOpaque, matCutout, matTrans, atlasTex;
let world = null, player = null, playing = false, paused = false, pickerOpen = false;
let keys = {}, selSlot = 0, hotbar = [];
const RENDER_DIST = 3;

/* ---------- pack loading ---------- */
async function loadPack() {
  const r = await fetch('pack/pack.json');
  PACK = await r.json();
  REG = createRegistry(PACK);
  PAL = makePalette(REG);
  ATLAS_IMG = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im); im.onerror = rej;
    im.src = 'pack/atlas.png';
  });
  const s = PACK.stats || {};
  $('pack-stats').textContent =
    `${(PACK.blocks.length).toLocaleString()} blocks · ${(PACK.items.length).toLocaleString()} items · ` +
    `${(PACK.tileCount || 0).toLocaleString()} textures — imported from Claws of Berk`;
  // dragons (optional — game still runs if the entity pack is absent)
  try {
    const er = await fetch('pack/entities.json');
    ENT = await er.json();
    ENT_ATLAS_IMG = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = rej;
      im.src = 'pack/entity_atlas.png';
    });
    $('pack-stats').textContent += ` · ${ENT.species.length} dragon species`;
  } catch (e) { ENT = null; }
}

/* ---------- world ---------- */
class World {
  constructor(seed) {
    this.seed = seed; this.chunks = new Map(); this.diffs = new Map();
    this.dirty = new Set();
  }
  key(cx, cz) { return cx + ',' + cz; }
  getBlock(wx, wy, wz) {
    if (wy < 0 || wy >= WORLD_H) return 0;
    const cx = Math.floor(wx / CHUNK), cz = Math.floor(wz / CHUNK);
    const c = this.chunks.get(this.key(cx, cz));
    if (!c) return 0;
    return c.data[(wy * CHUNK + (wz - cz * CHUNK)) * CHUNK + (wx - cx * CHUNK)];
  }
  setBlock(wx, wy, wz, id, record) {
    if (wy < 0 || wy >= WORLD_H) return;
    const cx = Math.floor(wx / CHUNK), cz = Math.floor(wz / CHUNK);
    const c = this.chunks.get(this.key(cx, cz));
    if (!c) return;
    const lx = wx - cx * CHUNK, lz = wz - cz * CHUNK;
    c.data[(wy * CHUNK + lz) * CHUNK + lx] = id;
    if (record !== false) this.diffs.set(wx + ',' + wy + ',' + wz, id);
    this.dirty.add(this.key(cx, cz));
    if (lx === 0) this.dirty.add(this.key(cx - 1, cz));
    if (lx === CHUNK - 1) this.dirty.add(this.key(cx + 1, cz));
    if (lz === 0) this.dirty.add(this.key(cx, cz - 1));
    if (lz === CHUNK - 1) this.dirty.add(this.key(cx, cz + 1));
  }
  ensureChunk(cx, cz) {
    const k = this.key(cx, cz);
    if (this.chunks.has(k)) return;
    const data = genChunkData(REG, PAL, cx, cz, this.seed);
    for (const [dk, id] of this.diffs) {
      const p = dk.split(',').map(Number);
      const dx = p[0] - cx * CHUNK, dz = p[2] - cz * CHUNK;
      if (dx >= 0 && dx < CHUNK && dz >= 0 && dz < CHUNK && p[1] >= 0 && p[1] < WORLD_H)
        data[(p[1] * CHUNK + dz) * CHUNK + dx] = id;
    }
    const group = new THREE.Group();
    group.position.set(cx * CHUNK, 0, cz * CHUNK);
    scene.add(group);
    this.chunks.set(k, { data, group, meshes: [] });
    this.dirty.add(k);
    this.dirty.add(this.key(cx + 1, cz)); this.dirty.add(this.key(cx - 1, cz));
    this.dirty.add(this.key(cx, cz + 1)); this.dirty.add(this.key(cx, cz - 1));
  }
  remesh(k) {
    const c = this.chunks.get(k);
    if (!c) return;
    for (const m of c.meshes) { c.group.remove(m); m.geometry.dispose(); }
    c.meshes.length = 0;
    const [cx, cz] = k.split(',').map(Number);
    const arrays = buildChunkArrays(REG, PACK.grid, (x, y, z) => this.getBlock(cx * CHUNK + x, y, cz * CHUNK + z));
    for (const [name, arr, mat] of [['opaque', arrays.opaque, matOpaque], ['cutout', arrays.cutout, matCutout], ['trans', arrays.trans, matTrans]]) {
      if (!arr.idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(arr.nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uv, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(arr.col, 3));
      geo.setIndex(arr.idx);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      c.group.add(mesh); c.meshes.push(mesh);
    }
  }
  flushDirty(budget) {
    let n = 0;
    for (const k of [...this.dirty]) {
      this.dirty.delete(k); this.remesh(k);
      if (++n >= budget) break;
    }
  }
  unloadFar(pcx, pcz) {
    for (const k of [...this.chunks.keys()]) {
      const [cx, cz] = k.split(',').map(Number);
      if (Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)) > RENDER_DIST + 1) {
        const c = this.chunks.get(k);
        for (const m of c.meshes) { c.group.remove(m); m.geometry.dispose(); }
        scene.remove(c.group);
        this.chunks.delete(k);
      }
    }
  }
}

/* ---------- player ---------- */
function makePlayer() {
  return { pos: new THREE.Vector3(8.5, 50, 8.5), vel: new THREE.Vector3(), yaw: 0, pitch: 0, fly: false, onGround: false, surv: makeSurvival(), fallPeak: 0, dead: false };
}

/* ---------- survival wiring ---------- */
let flashT = 0;
function applyHurt(dmg, cause) {
  if (!player || player.dead || dmg <= 0) return;
  const died = hurtSurv(player.surv, dmg);
  const fl = $('dmgflash');
  fl.style.transition = 'none'; fl.style.opacity = '0.6';
  requestAnimationFrame(() => { fl.style.transition = 'opacity .5s'; fl.style.opacity = '0'; });
  renderSurv();
  if (died) die(cause);
}
function gainXp(points) {
  if (!player || player.dead) return;
  const ups = addXp(player.surv, points);
  if (ups > 0) flashHint(`⭐ Level up! You are now level ${player.surv.level}`);
  renderSurv();
}
function die(cause) {
  player.dead = true;
  $('death-info').textContent = cause || '';
  $('death').classList.remove('hidden');
  if (document.exitPointerLock) document.exitPointerLock();
  saveWorld();
}
function respawn() {
  player.surv = makeSurvival();
  player.dead = false;
  player.fallPeak = 0;
  player.vel.set(0, 0, 0);
  const h = heightAt(8, 8, world.seed);
  player.pos.set(8.5, h + 1.02, 8.5);
  $('death').classList.add('hidden');
  survKey = '';
  renderSurv();
}
let eatCd = 0;
function tryEat() {
  if (!player || player.dead || eatCd > 0) return;
  if (player.surv.food >= 20) { flashHint('You are full — hunger is maxed'); return; }
  eatCd = 1.2;
  eatFood(player.surv, 6, 3);
  flashHint('You eat a dragon treat 🍖 (+3 hunger)');
  renderSurv();
}
let survKey = '';
function renderSurv() {
  if (!player || !player.surv) return;
  const s = player.surv;
  const frac = s.xp / xpNeed(s.level);
  const key = [s.health, s.food, s.level, Math.floor(frac * 182)].join('|');
  if (key === survKey) return;
  survKey = key;
  let hh = '';
  for (let i = 0; i < 10; i++) { const v = s.health - i * 2; hh += `<span class="mcico h${v >= 2 ? 'f' : v === 1 ? 'h' : 'e'}"></span>`; }
  $('hearts').innerHTML = hh;
  let ff = '';
  for (let i = 0; i < 10; i++) { const v = s.food - i * 2; ff += `<span class="mcico f${v >= 2 ? 'f' : v === 1 ? 'h' : 'e'}"></span>`; }
  $('foods').innerHTML = ff;
  $('xpfill').style.width = (frac * 100).toFixed(1) + '%';
  $('xplvl').textContent = s.level > 0 ? String(s.level) : '';
}
const P_HW = 0.3, P_H = 1.8, EYE = 1.62;
function collides(px, py, pz) {
  const minX = Math.floor(px - P_HW), maxX = Math.floor(px + P_HW);
  const minY = Math.floor(py), maxY = Math.floor(py + P_H - 1e-4);
  const minZ = Math.floor(pz - P_HW), maxZ = Math.floor(pz + P_HW);
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++)
    if (isSolid(REG, world.getBlock(x, y, z))) return true;
  return false;
}
function movePlayer(dt) {
  const wasGround = player.onGround;
  const speed = player.fly ? 14 : (keys['shiftdown'] ? 6.5 : 4.4);
  const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
  let mx = 0, mz = 0;
  if (keys['w']) { mx += -sin; mz += -cos; }
  if (keys['s']) { mx += sin; mz += cos; }
  if (keys['a']) { mx += -cos; mz += sin; }
  if (keys['d']) { mx += cos; mz += -sin; }
  const ml = Math.hypot(mx, mz) || 1;
  player.vel.x = (mx / ml) * speed * (mx || mz ? 1 : 0);
  player.vel.z = (mz / ml) * speed * (mx || mz ? 1 : 0);
  if (player.fly) {
    player.vel.y = keys[' '] ? speed : keys['shiftdown'] ? -speed : 0;
  } else {
    player.vel.y -= 26 * dt;
    if (player.vel.y < -48) player.vel.y = -48;
    if (keys[' '] && player.onGround) { player.vel.y = 8.8; player.onGround = false; }
  }
  const p = player.pos;
  // per-axis movement with collision
  p.x += player.vel.x * dt;
  if (collides(p.x, p.y, p.z)) { p.x -= player.vel.x * dt; /* step-free simple stop */ while (!collides(p.x + Math.sign(player.vel.x) * 0.01, p.y, p.z) && Math.abs(player.vel.x) > 0) p.x += Math.sign(player.vel.x) * 0.01; player.vel.x = 0; }
  p.z += player.vel.z * dt;
  if (collides(p.x, p.y, p.z)) { p.z -= player.vel.z * dt; while (!collides(p.x, p.y, p.z + Math.sign(player.vel.z) * 0.01) && Math.abs(player.vel.z) > 0) p.z += Math.sign(player.vel.z) * 0.01; player.vel.z = 0; }
  p.y += player.vel.y * dt;
  player.onGround = false;
  if (collides(p.x, p.y, p.z)) {
    if (player.vel.y < 0) player.onGround = true;
    p.y -= player.vel.y * dt;
    while (!collides(p.x, p.y + Math.sign(player.vel.y) * 0.01, p.z) && Math.abs(player.vel.y) > 0) p.y += Math.sign(player.vel.y) * 0.01;
    player.vel.y = 0;
  }
  if (p.y < 2) { p.y = 2; player.vel.y = 0; player.onGround = true; }
  // fall tracking: remember the highest point of the fall, pay for it on landing
  if (player.onGround) {
    if (!wasGround && !player.fly && !player.dead) {
      const dist = player.fallPeak - p.y;
      const feetId = world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.2), Math.floor(p.z));
      const inWater = feetId && feetId === REG.byMc.get('minecraft:water');
      const dmg = inWater ? 0 : fallDamage(dist);
      if (dmg > 0) applyHurt(dmg, 'You fell from a high place');
    }
    player.fallPeak = p.y;
  } else if (p.y > player.fallPeak) player.fallPeak = p.y;
}

/* ---------- interaction ---------- */
function eyeRay() {
  const dir = new THREE.Vector3(-Math.sin(player.yaw) * Math.cos(player.pitch), Math.sin(player.pitch), -Math.cos(player.yaw) * Math.cos(player.pitch));
  const eye = [player.pos.x, player.pos.y + EYE, player.pos.z];
  return raycast((x, y, z) => world.getBlock(x, y, z), eye, [dir.x, dir.y, dir.z], 7);
}
let highlight = null;
function updateHighlight() {
  const hit = (playing && !pickerOpen) ? eyeRay() : null;
  if (!hit) { if (highlight) highlight.visible = false; return; }
  if (!highlight) {
    highlight = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
      new THREE.LineBasicMaterial({ color: 0x111111 }));
    scene.add(highlight);
  }
  highlight.visible = true;
  highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
}
function breakBlock() {
  const hit = eyeRay();
  if (!hit) return;
  if (hit.y === 0) return; // bedrock floor stays
  world.setBlock(hit.x, hit.y, hit.z, 0);
  gainXp(2); // mining pays experience
}
function placeBlock() {
  const hit = eyeRay();
  if (!hit) return;
  const x = hit.x + hit.face[0], y = hit.y + hit.face[1], z = hit.z + hit.face[2];
  const sel = hotbar[selSlot];
  if (!sel) return;
  // don't place inside the player
  if (isSolid(REG, sel) && x >= Math.floor(player.pos.x - P_HW) && x <= Math.floor(player.pos.x + P_HW) &&
      z >= Math.floor(player.pos.z - P_HW) && z <= Math.floor(player.pos.z + P_HW) &&
      y >= Math.floor(player.pos.y) && y <= Math.floor(player.pos.y + P_H)) return;
  world.setBlock(x, y, z, sel);
}

/* ---------- GL setup ---------- */
function ensureGL() {
  if (renderer) return;
  const canvas = document.createElement('canvas');
  $('game').appendChild(canvas);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  atlasTex = new THREE.Texture(ATLAS_IMG);
  atlasTex.magFilter = THREE.NearestFilter; atlasTex.minFilter = THREE.NearestFilter;
  atlasTex.generateMipmaps = false; atlasTex.needsUpdate = true;
  matOpaque = new THREE.MeshLambertMaterial({ map: atlasTex, vertexColors: true });
  matCutout = new THREE.MeshLambertMaterial({ map: atlasTex, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true });
  matTrans = new THREE.MeshLambertMaterial({ map: atlasTex, transparent: true, depthWrite: false, vertexColors: true });
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5e0);
  scene.fog = new THREE.Fog(0x87b5e0, 40, RENDER_DIST * CHUNK + 48);
  scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x6b5b43, 0.95));
  const sun = new THREE.DirectionalLight(0xfff2d8, 0.7);
  sun.position.set(60, 100, 30); scene.add(sun);
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.rotation.order = 'YXZ';
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight);
  });
  canvas.addEventListener('mousedown', (e) => {
    if (!playing || paused || pickerOpen) return;
    if (document.pointerLockElement !== canvas) { canvas.requestPointerLock(); return; }
    if (riding) { if (e.button === 0) { const d = dragons.find((x) => x.core === riding); if (d) startBreath(d); } return; }
    if (e.button === 0) breakBlock();
    if (e.button === 2) placeBlock();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas || !playing) return;
    player.yaw -= e.movementX * 0.0024;
    player.pitch -= e.movementY * 0.0024;
    player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch));
  });
  renderer.domElement.id = 'glcanvas';
}

/* ---------- saves ---------- */
let worldName = 'world';
function saveKey() { return 'berkweb_save_' + worldName; }
function saveWorld() {
  if (!world || !player) return;
  const diffs = [];
  for (const [k, id] of world.diffs) { const p = k.split(',').map(Number); diffs.push([p[0], p[1], p[2], id]); }
  const s = { app: 'berkweb', v: 1, seed: world.seed, diffs, player: [player.pos.x, player.pos.y, player.pos.z, player.yaw, player.pitch], hotbar, surv: player.surv,
    dragons: dragons.map((d) => ({ sp: d.core.sp, pos: d.core.pos, yaw: d.core.yaw, trust: d.core.trust, tamed: d.core.tamed, skin: d.core.skin })) };
  try { localStorage.setItem(saveKey(), JSON.stringify(s)); } catch (e) {}
}
function loadSave() {
  try { const s = JSON.parse(localStorage.getItem(saveKey()) || 'null'); return (s && s.app === 'berkweb') ? s : null; } catch (e) { return null; }
}

/* ---------- flow ---------- */
function parseSeed(str) {
  str = (str || '').trim();
  if (/^-?\d+$/.test(str)) return parseInt(str, 10) | 0;
  if (!str) return (Math.random() * 1e9) | 0;
  let h = 0; for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  return h;
}
function startWorld(name, seedStr) {
  ensureGL();
  worldName = (name || 'world').slice(0, 40) || 'world';
  const saved = loadSave();
  const seed = saved ? saved.seed : parseSeed(seedStr);
  world = new World(seed);
  if (saved) for (const d of saved.diffs) world.diffs.set(d[0] + ',' + d[1] + ',' + d[2], d[3]);
  player = makePlayer();
  if (saved && saved.surv) Object.assign(player.surv, saved.surv);
  if (saved && saved.player) {
    player.pos.set(saved.player[0], saved.player[1], saved.player[2]);
    player.yaw = saved.player[3] || 0; player.pitch = saved.player[4] || 0;
  } else {
    const h = heightAt(8, 8, seed);
    player.pos.set(8.5, h + 1.02, 8.5);
  }
  hotbar = (saved && saved.hotbar && saved.hotbar.length === 9) ? saved.hotbar.slice()
    : [PAL.grass, PAL.dirt, PAL.stone, PAL.log, PAL.leaves, PAL.sand,
       REG.byMc.get('minecraft:oak_stairs') || PAL.stone, REG.byMc.get('minecraft:oak_slab') || PAL.stone,
       REG.byMc.get('isleofberk:belzium_block') || PAL.stone];
  selSlot = 0;
  buildHotbar();
  const pcx = Math.floor(player.pos.x / CHUNK), pcz = Math.floor(player.pos.z / CHUNK);
  for (let dx = -RENDER_DIST; dx <= RENDER_DIST; dx++) for (let dz = -RENDER_DIST; dz <= RENDER_DIST; dz++)
    world.ensureChunk(pcx + dx, pcz + dz);
  world.flushDirty(1e9);
  spawnDragons(saved && saved.dragons);
  playing = true; paused = false;
  $('title').classList.add('hidden'); $('hud').classList.remove('hidden'); $('pause').classList.add('hidden');
  $('death').classList.add('hidden');
  survKey = ''; renderSurv();
  requestAnimationFrame(tick);
}

/* ---------- hotbar + picker ---------- */
function tileSprite(tile, size) {
  const g = PACK.grid, px = size;
  const d = document.createElement('div');
  d.className = 'sprite';
  d.style.width = px + 'px'; d.style.height = px + 'px';
  d.style.backgroundImage = 'url(pack/atlas.png)';
  d.style.backgroundSize = (g * px) + 'px ' + (g * px) + 'px';
  d.style.backgroundPosition = `-${(tile % g) * px}px -${Math.floor(tile / g) * px}px`;
  return d;
}
function buildHotbar() {
  const bar = $('hotbar'); bar.innerHTML = '';
  hotbar.forEach((id, i) => {
    const d = document.createElement('div');
    d.className = 'slot' + (i === selSlot ? ' sel' : '');
    const def = defOf(REG, id);
    if (def) { d.appendChild(tileSprite(def.tiles.side, 40)); d.title = def.name; }
    d.addEventListener('click', () => selectSlot(i));
    bar.appendChild(d);
  });
  updateSelName();
}
function selectSlot(i) {
  selSlot = i;
  [...$('hotbar').children].forEach((el, j) => el.classList.toggle('sel', j === i));
  updateSelName();
}
function updateSelName() {
  const def = defOf(REG, hotbar[selSlot]);
  $('selname').textContent = def ? def.name : '';
}
let pickerTab = 'blocks';
function openPicker() {
  pickerOpen = true;
  $('picker').classList.remove('hidden');
  document.exitPointerLock && document.exitPointerLock();
  renderPicker();
}
function closePicker() {
  pickerOpen = false;
  $('picker').classList.add('hidden');
}
function renderPicker() {
  const q = ($('picker-search').value || '').toLowerCase();
  const grid = $('picker-grid'); grid.innerHTML = '';
  const items = pickerTab === 'blocks' ? PACK.blocks : PACK.items;
  let shown = 0, total = 0;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < items.length && shown < 400; i++) {
    const it = items[i];
    if (q && !(it.name.toLowerCase().includes(q) || it.mc.toLowerCase().includes(q))) continue;
    total++;
    const d = document.createElement('div');
    d.className = 'pitem';
    d.appendChild(tileSprite(it.tiles ? it.tiles.side : it.tile, 44));
    const label = document.createElement('span'); label.textContent = it.name; d.appendChild(label);
    d.title = it.mc;
    if (pickerTab === 'blocks') {
      d.addEventListener('click', () => {
        hotbar[selSlot] = i + 1;
        buildHotbar(); closePicker(); saveWorld();
      });
    }
    frag.appendChild(d); shown++;
  }
  grid.appendChild(frag);
  $('picker-count').textContent = pickerTab === 'blocks'
    ? `Showing ${shown} — click one to put it in hotbar slot ${selSlot + 1}. ${PACK.blocks.length.toLocaleString()} blocks total. Items tab is look-only in this version.`
    : `${PACK.items.length.toLocaleString()} items imported with icons — look-only in this version (no gameplay logic yet).`;
}

/* ---------- main loop ---------- */
let lastT = 0, chunkT = 0, saveT = 0;
function tick(t) {
  if (!playing) return;
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
  lastT = t;
  if (!paused && !pickerOpen && !player.dead) { if (riding) driveRidden(dt); else movePlayer(dt); }
  if (!paused && !player.dead) {
    const moving = !!(keys['w'] || keys['a'] || keys['s'] || keys['d']);
    tickSurvival(player.surv, dt, { moving, sprinting: !!keys['shiftdown'] });
    if (eatCd > 0) eatCd -= dt;
    renderSurv();
  }
  if (!paused) updateDragons(dt);
  const pcx = Math.floor(player.pos.x / CHUNK), pcz = Math.floor(player.pos.z / CHUNK);
  chunkT += dt;
  if (chunkT > 0.25) {
    chunkT = 0;
    for (let dx = -RENDER_DIST; dx <= RENDER_DIST; dx++) for (let dz = -RENDER_DIST; dz <= RENDER_DIST; dz++)
      world.ensureChunk(pcx + dx, pcz + dz);
    world.unloadFar(pcx, pcz);
  }
  world.flushDirty(4);
  camera.position.set(player.pos.x, player.pos.y + EYE, player.pos.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
  updateHighlight();
  saveT += dt;
  if (saveT > 15) { saveT = 0; saveWorld(); }
  renderer.render(scene, camera);
}

/* ---------- input / wiring ---------- */
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === ' ') keys[' '] = true;
  else if (k === 'shift') keys['shiftdown'] = true;
  else keys[k] = true;
  if (!playing) return;
  if (k >= '1' && k <= '9') selectSlot(+k - 1);
  if (k === 'f' && !riding) { player.fly = !player.fly; player.vel.y = 0; }
  if (k === 'r') toggleRide();
  if (k === 't' && !riding) offerTreat();
  if (k === 'c') cycleSkin();
  if (k === 'e' && !riding) tryEat();
  if (k === 'b') { pickerOpen ? closePicker() : openPicker(); }
  if (k === 'escape' && pickerOpen) closePicker();
});
document.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === ' ') keys[' '] = false;
  else if (k === 'shift') keys['shiftdown'] = false;
  else keys[k] = false;
});
document.addEventListener('wheel', (e) => {
  if (!playing || pickerOpen) return;
  selectSlot((selSlot + (e.deltaY > 0 ? 1 : 8)) % 9);
});
$('btn-play').addEventListener('click', async () => {
  $('btn-play').textContent = 'Loading the pack…';
  try { await loadPack(); } catch (err) { $('pack-stats').textContent = 'Pack failed to load: ' + err; return; }
  startWorld($('world-name').value, $('world-seed').value);
});
$('picker-search').addEventListener('input', renderPicker);
$('tab-blocks').addEventListener('click', () => { pickerTab = 'blocks'; renderPicker(); });
$('tab-items').addEventListener('click', () => { pickerTab = 'items'; renderPicker(); });
$('picker-close').addEventListener('click', closePicker);
$('btn-resume').addEventListener('click', () => { paused = false; $('pause').classList.add('hidden'); });
$('btn-respawn').addEventListener('click', () => respawn());
$('btn-quit').addEventListener('click', () => { saveWorld(); location.reload(); });
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && playing && !pickerOpen && !paused) {
    paused = true; $('pause').classList.remove('hidden');
  }
});

/* ================= dragons ================= */
const D2R = Math.PI / 180;
const geoCache = new Map(); // speciesId -> Map(boneName -> BufferGeometry)
function speciesById(id) { return ENT.species.find((s) => s.id === id); }
function boneGeo(species, bone, rect, suffix) {
  const key = species.id + '|' + (suffix || 'main');
  let per = geoCache.get(key);
  if (!per) { per = new Map(); geoCache.set(key, per); }
  if (!per.has(bone.name)) {
    const g = buildBoneGeometry(species, bone, ENT.atlas, rect);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    geo.setIndex(g.idx);
    per.set(bone.name, geo);
  }
  return per.get(bone.name);
}
let entMatMembrane = null;
function makeLabel() {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 48;
  const tex = new THREE.CanvasTexture(cv);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  spr.scale.set(3.4, 0.64, 1); spr.position.y = 3.1;
  return { cv, tex, spr,
    draw(name, tamed) {
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, 256, 48);
      ctx.font = 'bold 25px system-ui'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 6, 256, 36);
      ctx.fillStyle = tamed ? '#ffb3d9' : '#ffe9a8';
      ctx.fillText(name + (tamed ? ' ♥' : ''), 128, 33);
      tex.needsUpdate = true;
    } };
}
function buildDragonVis(species, skinIdx, tamed) {
  if (!entMat) {
    entTex = new THREE.Texture(ENT_ATLAS_IMG);
    entTex.magFilter = THREE.NearestFilter; entTex.minFilter = THREE.NearestFilter;
    entTex.generateMipmaps = false; entTex.needsUpdate = true;
    entMat = new THREE.MeshLambertMaterial({ map: entTex, alphaTest: 0.1 });
    entMatMembrane = new THREE.MeshLambertMaterial({ map: entTex, alphaTest: 0.05,
      polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide });
  }
  const skin = species.skins[(skinIdx || 0) % species.skins.length];
  const root = new THREE.Group();
  const groups = new Map();
  const byName = new Map(species.bones.map((b) => [b.name, b]));
  for (const b of species.bones) {
    const g = new THREE.Group();
    const parent = b.parent ? byName.get(b.parent) : null;
    const pp = parent ? parent.pivot : [0, 0, 0];
    g.position.set((b.pivot[0] - pp[0]) / 16, (b.pivot[1] - pp[1]) / 16, (b.pivot[2] - pp[2]) / 16);
    g.rotation.set((b.rot[0] || 0) * D2R, (b.rot[1] || 0) * D2R, (b.rot[2] || 0) * D2R);
    g.userData.basePos = g.position.clone();
    g.userData.baseRot = [g.rotation.x, g.rotation.y, g.rotation.z];
    if (b.cubes && b.cubes.length) {
      const mesh = new THREE.Mesh(boneGeo(species, b, skin.rect, 'skin:' + skin.name), entMat);
      mesh.matrixAutoUpdate = false;
      g.add(mesh);
      if (skin.membrane_rect) {
        const mm = new THREE.Mesh(boneGeo(species, b, skin.membrane_rect, 'mem:' + skin.name), entMatMembrane);
        mm.matrixAutoUpdate = false;
        g.add(mm);
      }
    }
    groups.set(b.name, g);
  }
  for (const b of species.bones) {
    const g = groups.get(b.name);
    const pg = b.parent ? groups.get(b.parent) : null;
    (pg || root).add(g);
  }
  const label = makeLabel();
  label.draw(species.name + (species.skins.length > 1 ? '' : ''), !!tamed);
  root.add(label.spr);
  scene.add(root);
  return { root, groups, label, skin, animName: null, animT: Math.random() * 2, breathT: 0, breathCd: 0 };
}
function rebuildVis(d) {
  const old = d.vis;
  scene.remove(old.root);
  d.vis = buildDragonVis(d.sp, d.core.skin, d.core.tamed);
  d.vis.root.position.set(d.core.pos[0], d.core.pos[1], d.core.pos[2]);
  d.vis.root.rotation.y = d.core.yaw;
}
function resolveAnim(species, suffixes) {
  for (const s of suffixes) {
    const full = species.aliases && species.aliases[s];
    if (full && species.animations[full]) return [full, species.animations[full]];
  }
  const first = Object.keys(species.animations || {})[0];
  return first ? [first, species.animations[first]] : [null, null];
}
function applyAnim(dv, species, suffixes, dt) {
  const [name, anim] = resolveAnim(species, suffixes);
  if (!anim) return;
  if (dv.animName !== name) { dv.animName = name; dv.animT = 0; }
  dv.animT += dt;
  const t = dv.animT;
  for (const boneName in anim.bones) {
    const g = dv.groups.get(boneName);
    if (!g) continue;
    const chans = anim.bones[boneName];
    const bp = g.userData.basePos, br = g.userData.baseRot;
    if (chans.rotation) {
      const r = sampleChannel(chans.rotation, t, anim.len, anim.loop);
      g.rotation.set(br[0] + r[0] * D2R, br[1] - r[1] * D2R, br[2] - r[2] * D2R);
    }
    if (chans.position) {
      const p = sampleChannel(chans.position, t, anim.len, anim.loop);
      g.position.set(bp.x + p[0] / 16, bp.y + p[1] / 16, bp.z + p[2] / 16);
    }
  }
}
function groundH(x, z) {
  const bx = Math.floor(x), bz = Math.floor(z);
  for (let y = WORLD_H - 1; y > 0; y--) if (isSolid(REG, world.getBlock(bx, y, bz))) return y + 1;
  return SEA;
}
function spawnDragons(savedList) {
  dragons = []; riding = null;
  if (!ENT || !ENT.species.length) return;
  const rng = makeRng((world.seed ^ 0xD6A6) >>> 0);
  if (savedList && savedList.length) {
    for (const s of savedList) {
      const sp = speciesById(s.sp);
      if (!sp) continue;
      const core = createDragon(s.sp, s.pos[0], s.pos[1], s.pos[2], rng);
      core.yaw = s.yaw || 0; core.trust = s.trust || 0; core.tamed = !!s.tamed; core.skin = s.skin || 0;
      core.pos[1] = groundH(core.pos[0], core.pos[2]);
      dragons.push({ core, vis: buildDragonVis(sp, core.skin, core.tamed), sp });
    }
    return;
  }
  const n = Math.min(8, ENT.species.length);
  for (let i = 0; i < n; i++) {
    const sp = ENT.species[(i * 2) % ENT.species.length];
    const ang = rng() * Math.PI * 2, rad = 9 + rng() * 16;
    const x = player.pos.x + Math.cos(ang) * rad, z = player.pos.z + Math.sin(ang) * rad;
    const core = createDragon(sp.id, x, groundH(x, z), z, rng);
    core.skin = Math.floor(rng() * sp.skins.length);
    dragons.push({ core, vis: buildDragonVis(sp, core.skin, false), sp });
  }
}
function animForState(d) {
  if (d.core === riding) {
    const g = groundH(d.core.pos[0], d.core.pos[2]);
    if (d.core.pos[1] > g + 0.4) return d.core.speed > 6 ? ['glide', 'hover', 'flap'] : ['hover', 'flap', 'glide'];
    return d.core.speed > 0.3 ? ['walk'] : ['idle', 'sit'];
  }
  if (d.core.state === 'fly' || d.core.state === 'land') return ['glide', 'flap', 'hover', 'flyup'];
  if (d.core.state === 'walk') return ['walk', 'run'];
  return ['idle', 'sit'];
}
function updateDragons(dt) {
  if (!dragons.length) return;
  const env = { groundH, rand: Math.random, playerPos: [player.pos.x, player.pos.y, player.pos.z] };
  for (const d of dragons) {
    if (d.core !== riding) stepDragon(d.core, dt, env);
    d.vis.root.position.set(d.core.pos[0], d.core.pos[1], d.core.pos[2]);
    d.vis.root.rotation.y = d.core.yaw;
    if (d.vis.breathCd > 0) d.vis.breathCd -= dt;
    let suffixes = animForState(d);
    if (d.vis.breathT > 0) { d.vis.breathT -= dt; suffixes = ['breath', 'roar'].concat(suffixes); }
    applyAnim(d.vis, d.sp, suffixes, dt);
  }
  updateBreathFX(dt);
}

/* ---- fire breath particles ---- */
const BREATH_MAX = 260;
let breathFX = null;
function ensureBreathFX() {
  if (breathFX) return breathFX;
  const geo = new THREE.BufferGeometry();
  const posArr = new Float32Array(BREATH_MAX * 3);
  const colArr = new Float32Array(BREATH_MAX * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
  const mat = new THREE.PointsMaterial({ size: 0.42, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);
  breathFX = { geo, points, parts: [] };
  return breathFX;
}
function startBreath(d) {
  if (d.vis.breathCd > 0) return;
  d.vis.breathCd = 1.6; d.vis.breathT = 1.1;
  const fx = ensureBreathFX();
  const head = d.vis.groups.get('head') || d.vis.groups.get('Headrot') || d.vis.groups.get('Chest');
  const hp = new THREE.Vector3();
  if (head) head.getWorldPosition(hp); else hp.set(d.core.pos[0], d.core.pos[1] + 2, d.core.pos[2]);
  const dir = new THREE.Vector3(-Math.sin(player.yaw) * Math.cos(player.pitch), Math.sin(player.pitch), -Math.cos(player.yaw) * Math.cos(player.pitch));
  for (let i = 0; i < 110; i++) {
    fx.parts.push({
      p: [hp.x + (Math.random() - 0.5) * 0.3, hp.y + (Math.random() - 0.5) * 0.3, hp.z + (Math.random() - 0.5) * 0.3],
      v: [dir.x * (10 + Math.random() * 7) + (Math.random() - 0.5) * 2,
          dir.y * (10 + Math.random() * 7) + (Math.random() - 0.5) * 2 + 0.6,
          dir.z * (10 + Math.random() * 7) + (Math.random() - 0.5) * 2],
      life: 0.45 + Math.random() * 0.5, max: 0.9,
    });
  }
  if (fx.parts.length > BREATH_MAX) fx.parts.splice(0, fx.parts.length - BREATH_MAX);
}
function updateBreathFX(dt) {
  if (!breathFX) return;
  const fx = breathFX;
  const posAttr = fx.geo.getAttribute('position'), colAttr = fx.geo.getAttribute('color');
  fx.parts = fx.parts.filter((pt) => { pt.life -= dt; return pt.life > 0; });
  for (let i = 0; i < BREATH_MAX; i++) {
    const pt = fx.parts[i];
    if (!pt) { posAttr.setXYZ(i, 0, -100, 0); colAttr.setXYZ(i, 0, 0, 0); continue; }
    pt.p[0] += pt.v[0] * dt; pt.p[1] += pt.v[1] * dt; pt.p[2] += pt.v[2] * dt;
    pt.v[0] *= 0.96; pt.v[2] *= 0.96; pt.v[1] = pt.v[1] * 0.96 + 1.4 * dt;
    const f = Math.max(0, pt.life / pt.max);
    posAttr.setXYZ(i, pt.p[0], pt.p[1], pt.p[2]);
    colAttr.setXYZ(i, 1.0 * f, 0.45 * f * f, 0.08 * f * f * f); // white-hot core -> orange -> ember
  }
  posAttr.needsUpdate = true; colAttr.needsUpdate = true;
}
function nearestDragon(maxD) {
  let best = null, bd = maxD;
  for (const d of dragons) {
    const dx = d.core.pos[0] - player.pos.x, dz = d.core.pos[2] - player.pos.z;
    const dy = (d.core.pos[1] + 1.5) - (player.pos.y + 1);
    const dist = Math.hypot(dx, dz, dy);
    if (dist < bd) { bd = dist; best = d; }
  }
  return best;
}
let hintTimer = 0;
function flashHint(msg, ms) {
  $('hint').textContent = msg;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    $('hint').textContent = riding ? 'Riding! W = forward · Space up · Shift down · Click = fire breath · R = get off'
      : 'B = block picker · F = fly · R = ride dragon · T = treat · C = change skin · Esc = pause';
  }, ms || 2600);
}
function toggleRide() {
  if (!playing || pickerOpen) return;
  if (riding) {
    const d = riding;
    d.state = 'idle'; d.timer = 3; riding = null;
    const side = [Math.cos(d.yaw) * 2.4, 0, -Math.sin(d.yaw) * 2.4];
    player.pos.set(d.pos[0] + side[0], groundH(d.pos[0] + side[0], d.pos[2] + side[2]) + 0.02, d.pos[2] + side[2]);
    player.vel.set(0, 0, 0);
    $('hint').textContent = 'B = block picker · F = fly · R = ride dragon · Esc = pause';
    return;
  }
  const near = nearestDragon(5);
  if (near) {
    if (!near.core.tamed) {
      flashHint(`That ${near.sp.name} is wild — tame it first: stand close and press T to offer treats`);
      return;
    }
    riding = near.core;
    riding.state = 'ridden'; riding.speed = 0;
    $('hint').textContent = 'Riding! W = forward (look up/down to climb/dive) · Space up · Shift down · Click = fire breath · R = get off';
  }
}
function offerTreat() {
  const near = nearestDragon(5.5);
  if (!near) return;
  const d = near.core;
  if (d.tamed) { flashHint(`Your ${near.sp.name} is already tamed ♥ — press C to change its skin, R to ride`); return; }
  if (d.treatCd > 0) return;
  d.treatCd = 0.9;
  const nowTamed = addTrust(d);
  if (nowTamed) {
    near.vis.label.draw(near.sp.name, true);
    gainXp(10);
    flashHint(`♥ Tamed! The ${near.sp.name} trusts you now — press R to ride it`);
  } else {
    flashHint(`The ${near.sp.name} eats the treat… trust ${Math.round(d.trust * 100)}% (keep offering with T)`);
  }
}
function cycleSkin() {
  const near = nearestDragon(5.5);
  if (!near || near.sp.skins.length < 2) return;
  near.core.skin = (near.core.skin + 1) % near.sp.skins.length;
  rebuildVis(near);
  saveWorld();
  flashHint(`${near.sp.name} skin: ${near.vis.skin.name} (${near.core.skin + 1}/${near.sp.skins.length})`);
}
function driveRidden(dt) {
  const d = riding;
  d.yaw = player.yaw;
  const g = groundH(d.pos[0], d.pos[2]);
  const airborne = d.pos[1] > g + 0.35;
  const fwd = [ -Math.sin(d.yaw), -Math.cos(d.yaw) ];
  let vx = 0, vy = 0, vz = 0;
  const up = keys[' '] ? 8 : 0, down = keys['shiftdown'] ? 8 : 0;
  if (keys['w']) {
    if (airborne) {
      const sp = 11;
      vx += fwd[0] * sp; vz += fwd[1] * sp; vy += Math.sin(player.pitch) * sp * 0.8;
      d.speed = sp;
    } else {
      vx += fwd[0] * 3.6; vz += fwd[1] * 3.6; d.speed = 3.6;
    }
  } else if (keys['s']) { vx -= fwd[0] * 3; vz -= fwd[1] * 3; d.speed = 2; }
  else d.speed = 0;
  vy += up - down;
  d.pos[0] += vx * dt; d.pos[2] += vz * dt; d.pos[1] += vy * dt;
  const gNow = groundH(d.pos[0], d.pos[2]);
  if (d.pos[1] < gNow) d.pos[1] = gNow;
  if (d.pos[1] > WORLD_H - 6) d.pos[1] = WORLD_H - 6;
  // park the player on the saddle
  const sp2 = speciesById(d.sp);
  const so = saddleOffset(sp2);
  const cy = Math.cos(d.yaw), sy = Math.sin(d.yaw);
  const wx = d.pos[0] + (so[0] * cy + so[2] * sy);
  const wz = d.pos[2] + (-so[0] * sy + so[2] * cy);
  player.pos.set(wx, d.pos[1] + so[1] - 0.92, wz);
  player.vel.set(0, 0, 0);
}
})();
