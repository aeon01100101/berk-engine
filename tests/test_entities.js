'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../web/engine.js'), 'utf8');
const core = src.split('/*__CORE_BEGIN__*/')[1].split('/*__CORE_END__*/')[0];
const ent = src.split('/*__ENT_BEGIN__*/')[1].split('/*__ENT_END__*/')[0];
const api = new Function(core + ent + `\nreturn { evalMolang, sampleChannel, buildBoneGeometry, createDragon, stepDragon, saddleOffset, makeRng, addTrust };`)();

let PASS = 0, FAIL = 0;
function check(name, cond, extra) {
  if (cond) { PASS++; console.log('  PASS', name); }
  else { FAIL++; console.log('  FAIL', name, extra || ''); }
}
const ents = JSON.parse(fs.readFileSync(path.join(__dirname, '../web/pack/entities.json'), 'utf8'));
check('14 dragon species imported', ents.species.length === 14, ents.species.length);
check('leader + titan variants present', !!ents.species.find((s) => s.id === 'speed_stinger_leader') && !!ents.species.find((s) => s.id === 'terrible_terror_titan_wing'));
{
  const totalSkins = ents.species.reduce((a, s) => a + s.skins.length, 0);
  check('130+ skins imported', totalSkins >= 130, totalSkins);
  const withMem = ents.species.reduce((a, s) => a + s.skins.filter((k) => k.membrane_rect).length, 0);
  check('some skins carry membrane textures', withMem >= 10, withMem);
  const nadder = ents.species.find((s) => s.id === 'deadly_nadder');
  check('nadder main skin has a membrane rect', !!nadder.skins[0].membrane_rect);
  check('breath animation alias exists (night fury)', !!nf0alias());
  function nf0alias() { const s = ents.species.find((x) => x.id === 'night_fury'); return s.aliases && s.aliases.breath; }
}
const nf = ents.species.find((s) => s.id === 'night_fury');
check('night fury present with 83 bones', !!nf && nf.bones.length === 83, nf && nf.bones.length);
check('every species has animations', ents.species.every((s) => Object.keys(s.animations).length >= 5));
check('every species has a skin rect', ents.species.every((s) => Array.isArray(s.tex_rect) && s.tex_rect[2] > 0));

// molang evaluator
check('molang arithmetic', Math.abs(api.evalMolang('35+2*3', 0) - 41) < 1e-9);
check('molang sin anim_time', Math.abs(api.evalMolang('math.sin(query.anim_time * 3.14159265)', 0.5) - 1) < 1e-6);
check('molang garbage -> 0, no crash', api.evalMolang('query.anything + woo', 1) === 0);
check('molang number passthrough', api.evalMolang(7, 0) === 7);

// channel sampling
{
  const kf = [[0, [0, 0, 0]], [1, [10, 20, 30]]];
  const mid = api.sampleChannel(kf, 0.5, 1, true);
  check('keyframe lerp midpoint', mid[0] === 5 && mid[1] === 10 && mid[2] === 15, mid);
  const wrapped = api.sampleChannel(kf, 1.5, 1, true);
  check('looping sample wraps', Math.abs(wrapped[0] - 5) < 1e-9, wrapped);
  const constant = api.sampleChannel([[0, ['35+math.sin(query.anim_time*6.2831853)*-1.5', 0, 0]]], 0.25, 1, true);
  check('molang component evaluated at t', Math.abs(constant[0] - (35 + Math.sin(0.25 * 6.2831853) * -1.5)) < 1e-4, constant);
}

// geometry: chest bone of night fury -> 6 cubes = up to 36 faces
{
  const chest = nf.bones.find((b) => b.name === 'Chest');
  const g = api.buildBoneGeometry(nf, chest, ents.atlas);
  check('chest geometry has faces', g.idx.length >= 36 * 1 && g.pos.length > 0, g.idx.length / 6 + ' faces');
  let uvOk = true;
  for (let i = 0; i < g.uv.length; i++) if (g.uv[i] < -0.001 || g.uv[i] > 1.001) uvOk = false;
  check('chest UVs inside atlas [0,1]', uvOk);
  // all species/bones build without error and produce matching attribute sizes
  let totalFaces = 0, err = null;
  try {
    for (const sp of ents.species) for (const b of sp.bones) {
      const gg = api.buildBoneGeometry(sp, b, ents.atlas);
      if (gg.pos.length / 3 !== gg.nor.length / 3 || gg.pos.length / 3 !== gg.uv.length / 2) throw new Error('attr mismatch ' + sp.id + '/' + b.name);
      totalFaces += gg.idx.length / 6;
    }
  } catch (e) { err = e; }
  check('all bones of all species build cleanly', !err, err && err.message);
  check('total dragon faces > 3000 (real models)', totalFaces > 3000, totalFaces);
  console.log('  total faces across all dragons:', totalFaces);
}

// saddle on the chest
{
  const so = api.saddleOffset(nf);
  check('night fury saddle ~2.4 blocks up', so[1] > 2.2 && so[1] < 2.7, so);
}

// taming: three treats
{
  const rng = api.makeRng(7);
  const d = api.createDragon('gronckle', 0, 40, 0, rng);
  check('dragon starts wild', d.tamed === false && d.trust === 0);
  api.addTrust(d); api.addTrust(d);
  check('two treats: trust 0.68, still wild', Math.abs(d.trust - 0.68) < 1e-9 && !d.tamed, d.trust);
  const tamedNow = api.addTrust(d);
  check('third treat tames it', tamedNow === true && d.tamed === true && d.trust === 1);
}
// tamed dragons follow their rider; wild ones don't
{
  const rng = api.makeRng(5);
  const env = { groundH: () => 40, rand: rng, playerPos: [30, 40, 0] };
  const tame = api.createDragon('night_fury', 0, 40, 0, rng);
  tame.tamed = true; tame.state = 'idle'; tame.timer = 5;
  api.stepDragon(tame, 0.1, env);
  check('tamed dragon starts walking to far rider', tame.state === 'walk', tame.state);
  const wild = api.createDragon('night_fury', 0, 40, 0, rng);
  wild.state = 'idle'; wild.timer = 5;
  api.stepDragon(wild, 0.1, env);
  check('wild dragon ignores the player', wild.state === 'idle', wild.state);
}
// membrane geometry builds with an override rect
{
  const nadder = ents.species.find((s) => s.id === 'deadly_nadder');
  const chest = nadder.bones.find((b) => b.name === 'Chest') || nadder.bones[2];
  const g = api.buildBoneGeometry(nadder, chest, ents.atlas, nadder.skins[0].membrane_rect);
  check('membrane-rect geometry builds, UVs in [0,1]', g.idx.length > 0 && g.uv.every((v) => v >= -0.001 && v <= 1.001));
}

// AI state machine on a flat world
{
  const rng = api.makeRng(99);
  const env = { groundH: () => 40, rand: rng };
  const d = api.createDragon('night_fury', 0, 40, 0, rng);
  let sawFly = false, sawWalk = false, minY = 1e9;
  for (let i = 0; i < 60 * 120; i++) { // 2 minutes at 60fps
    api.stepDragon(d, 1 / 60, env);
    if (d.state === 'fly') sawFly = true;
    if (d.state === 'walk') sawWalk = true;
    minY = Math.min(minY, d.pos[1]);
    if (!isFinite(d.pos[0] + d.pos[1] + d.pos[2])) break;
  }
  check('AI stays finite for 2 simulated minutes', isFinite(d.pos[0] + d.pos[1] + d.pos[2]));
  check('AI walks sometimes', sawWalk);
  check('AI flies sometimes', sawFly);
  check('AI never falls below ground', minY >= 39.9, minY);
  check('AI ends in a sane state', ['idle', 'walk', 'fly', 'land'].includes(d.state), d.state);
}
console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
