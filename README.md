# Berk Engine — Claws of Berk in a Browser

A brand-new voxel engine written for one job: playing the content of the
**Isle of Berk — Claws of Berk 1.0.0** modpack in a browser. Not Minecraft —
no Mojang or Forge code. The pack's blocks, textures, names, items and
dragons were imported as data from the pack's own files by the importers
in `importer/`.

- **8,718 blocks** (cubes + real shaped geometry: slabs, stairs, doors),
  2,556 items, 10,212 textures
- **14 dragon species, 134 skins** — real GeckoLib models/animations,
  wing membranes, taming, riding, fire breath
- Runs from any static folder: `web/start.bat` or `web/start.sh`
  (or `python3 -m http.server` inside `web/`)

Fan project for personal use. Minecraft is a trademark of Mojang/Microsoft;
Isle of Berk and its mods belong to their respective authors. The imported
asset pack (`web/pack/`) was generated from a legally owned copy of the
modpack + the official Minecraft client assets it builds on.
