# Berk Engine — Claws of Berk in a Browser

A **brand-new voxel engine written for this pack** (not Minecraft, no Mojang
or Forge code) that plays the *content* of the **Isle of Berk — Claws of Berk
1.0.0** modpack in any modern browser: its blocks, textures, names and items,
imported as data from the pack's own files.

Why a new engine? The existing options were checked first: noa (browser voxel
engine) only knows cube blocks in its own format; Prismarine's web client can
only speak to vanilla servers — its own team states modded blocks are out of
scope. A purpose-built engine could read the pack's actual model files, so
**shaped blocks came along too** — not just cubes.

## Run it

- Windows: double-click **start.bat**
- Linux/Mac: `./start.sh`
- Or manually: `python3 -m http.server 8902` in this folder, then open
  http://localhost:8902

Fill in a world name + seed (or leave seed blank for random), press **Play**,
click the world to grab the mouse.

## Controls

WASD move · Mouse look · Left click mine · Right click place · 1–9 / wheel
select · Space jump · Shift sprint · **F** fly · **B** block picker
(search all 8,718 blocks; Items tab is look-only) · **T** offer a treat ·
**E** eat a treat · **R** ride the nearest dragon / get off · **C** cycle a
nearby dragon's skin · Esc pause.
Worlds (including your health, hunger and XP) auto-save into the browser's
local storage.

## Dragons (v0.3)

The Isle of Berk mod is GeckoLib-based, so its dragons imported as **real
data, not recreations**: bone hierarchies, cube geometry, skins and the
mod's own keyframed animations.

- **14 species, 134 skins**: Night Fury, Light Fury, Nightlight, Deadly
  Nadder, Gronckle, Monstrous Nightmare, Hideous Zippleback, Skrill,
  Triple Stryke, Speed Stinger, Lead Speed Stinger, Stinger, Terrible
  Terror, Titan-Wing Terror — 9,126 textured faces. Named skins from the
  show are all in (Barklethorn, Flystorm, Iggy, Pain…): walk up to a
  dragon and press **C** to cycle its skin. 12 skins also carry their
  **wing-membrane textures**, rendered as a second pass like the mod does.
- They **wander, graze idle, take off, circle, and land** on their own,
  playing the mod's walk/idle/glide animations — including the Molang
  sine-wave wing motions (a tiny safe evaluator runs them; no eval()).
- **Taming**: dragons start wild. Stand close and press **T** to offer
  treats — three treats (trust 0→100%) tame one. Tamed dragons get a ♥
  on their name label, **follow you** when you wander off, and only tamed
  dragons let you ride.
- **Ride them**: press **R** next to a tamed dragon. You sit on the chest
  saddle; W flies where you look (pitch climbs/dives), Space/Shift go
  up/down, **left click breathes fire** (the mod's breath animation +
  particle stream), R again to hop off.
- **Dragons are saved with your world** — species, position, skin, trust
  and tamed state all persist in the browser save.
- Still hand-wavey: treats are free/infinite (no item economy yet —
  items are look-only), breath is cosmetic (doesn't ignite blocks),
  and variant hulls (Nightlight, Leader, Titan-Wing) borrow their base
  species' animation files because the mod ships none for them.

## What imported (verified)

- **8,718 blocks**: 6,852 full cubes, 1,662 shaped blocks (slabs, stairs,
  doors, trapdoors, fences — real model geometry, not approximations),
  204 cross-shaped plants, plus synthesized water (vanilla water has no
  model file; it was rebuilt from its texture).
- **2,556 items** with real icons and names (look-only for now).
- **10,212 textures** in one atlas, including the official Minecraft 1.18.2
  client textures as the base layer (mods build on them).
- Terrain is generated with the pack's own grass/dirt/stone/oak palette.

## What did NOT import (honest list)

- **Mod behaviour/code**: quests, dragon taming/flying, NPCs, machines,
  GUIs, dimensions. Java code does not convert to a web engine; behaviours
  get hand-written over time, like the original AeonCraft mobs were.
- **Entities/dragons**: not in this build. 471 entity textures exist in the
  pack; mob models/AI are the next hand-written step.
- ~700 blockstates: 293 nested-path variants, 243 with no resolvable
  geometry, 86 pointing at textures missing from the pack itself
  (those show as missing-texture in real Minecraft too), 79 with
  diagonal (45°) model elements this engine doesn't rasterize yet.
- Crafting recipes were parsed (783 craft an imported block) but the
  crafting UI isn't wired yet — the picker is creative-mode style.
- Shaped blocks collide as full cells in v1 (you can't walk up a slab
  as a step yet).

## Validation

- **Survival (v0.4.0)**: the full Minecraft HUD — 10 hearts, 10 hunger
  shanks, XP bar + level number — drawn from the vanilla `icons.png`
  pulled out of the 1.18.2 client jar, with real rules behind it:
  hunger drains (faster sprinting), a full belly regenerates health,
  an empty one starves you to half a heart, falls hurt (3.5+ blocks,
  water breaks them), mining and taming pay XP on the vanilla level
  curve, **E** eats a treat, death shows a respawn screen.
- Engine core: **36/36 Node tests** (meshing, face culling, slab height
  0.5, cross plants, water, raycast, deterministic terrain, biome tint).
- **Real-browser play test (v0.3.1)**: driven in Chromium over CDP —
  title → Play → world renders with zero page errors, hotbar/picker work,
  player walks, a dragon took off on its own. Screenshots inspected by
  eye; that check caught a real bug — Minecraft stores grass/leaves
  textures near-greyscale and tints them in code, so v0.3's world looked
  washed out. v0.3.1 carries the models' `tintindex` flags through the
  importer and tints vertices properly (grass, leaves, water).
- Dragons: **32/32 Node tests** (Molang evaluator, keyframe sampling,
  every bone of every species builds geometry cleanly, saddle height,
  trust/taming math, tamed-follow behaviour, membrane geometry,
  AI simulated 2 minutes — walks, flies, never falls through the world).
- Importer counts independently re-derived from its JSON outputs.
- Visual check: see above — verified in a real Chromium on the build
  machine (the remote chat browser still can't reach local servers,
  which is why the first attempt at this check failed).

## Legal note

Fan project for personal use. Minecraft is a trademark of Mojang/Microsoft;
Isle of Berk and its mods belong to their respective authors. This build
contains no Minecraft game code — textures/models were imported from a
pack copy you supplied, for your own use.
