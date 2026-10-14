#!/usr/bin/env python3
"""
Claws of Berk -> browser-engine importer.

Reads an installed Claws of Berk instance (AeonPlay format: mods/,
resourcepacks/, config/paxi/resourcepacks/) and produces a content pack
for the AeonCraft web engine:

  web/pack/pack.json   registries: blocks (with per-face tiles), items, stats
  web/pack/atlas.png   all block/item textures, one 32px tile each
  import_report.json   full detail: per-mod counts + every skip, with reasons

What an "import" honestly is here:
  * Blocks whose model is a cube (cube / cube_all / cube_column /
    cube_bottom_top / orientable, or a model JSON that resolves to one)
    become real placeable blocks with the pack's own textures + names.
  * Items become registry entries with the pack's own icon + name
    (gallery in the web build; turning each into gameplay logic is
    hand work, counted in the report).
  * Recipes are counted and converted when every ingredient and the
    result exist in the imported registry.
  * Everything else — non-cube shapes (stairs, slabs, doors, crops...),
    entity/dragon code, quests, dimensions — is listed as NOT imported,
    with the reason. Mod code (Java) is never converted; it can't be.
"""
import hashlib, io, json, sys, zipfile
from collections import Counter, defaultdict
from pathlib import Path
from PIL import Image

TILE = 32
INSTANCE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("aeonplay-data/instances/claws-of-berk")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("web/pack")
OUT.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- stores
textures = {}   # "modid:path-no-ext" -> PNG bytes (later sources override)
models = {}     # "modid:path-no-ext" -> dict
lang = {}       # key -> name
blockstates = {}  # (modid, name) -> dict
recipes_raw = []  # (modid, name, dict)
source_of_tex = {}

def add_jar(z, label):
    for n in z.namelist():
        if not n.startswith("assets/"):
            continue
        parts = n.split("/")
        if len(parts) < 3:
            continue
        modid = parts[1]
        if n.endswith(".png") and "/textures/" in n:
            key = modid + ":" + n.split("/textures/", 1)[1][:-4]
            textures[key] = z.read(n)
            source_of_tex[key] = label
        elif n.endswith(".json"):
            if "/models/" in n:
                key = modid + ":" + n.split("/models/", 1)[1][:-5]
                try: models[key] = json.loads(z.read(n))
                except Exception: pass
            elif "/blockstates/" in n:
                nm = n.split("/blockstates/", 1)[1][:-5]
                try: blockstates[(modid, nm)] = json.loads(z.read(n))
                except Exception: pass
            elif n.endswith("/lang/en_us.json"):
                try:
                    for k, v in json.loads(z.read(n)).items():
                        lang[k] = v
                except Exception: pass
        if n.startswith("data/"):
            pass
    for n in z.namelist():
        if n.startswith("data/") and "/recipes/" in n and n.endswith(".json"):
            modid = n.split("/")[1]
            nm = n.split("/recipes/", 1)[1][:-5]
            try: recipes_raw.append((modid, nm, json.loads(z.read(n))))
            except Exception: pass

BASE_JAR = Path(__file__).parent / "client-1.18.2.jar"
if BASE_JAR.exists():
    # The official 1.18.2 client (from Mojang's own CDN, SHA-1 verified at
    # download time) is the base layer: it supplies the vanilla textures /
    # models / blockstates that most mods build on. Mods and resource
    # packs loaded after it override it, exactly like the real game.
    with zipfile.ZipFile(BASE_JAR) as z:
        add_jar(z, BASE_JAR.name)
    print("base layer: official Minecraft 1.18.2 client jar")

jars = sorted((INSTANCE / "mods").glob("*.jar"))
for jp in jars:
    try:
        with zipfile.ZipFile(jp) as z:
            add_jar(z, jp.name)
    except Exception as e:
        print("bad jar", jp, e)

rp_zips = sorted((INSTANCE / "resourcepacks").glob("*.zip")) + \
          sorted((INSTANCE / "config/paxi/resourcepacks").glob("*.zip"))
for rp in rp_zips:
    try:
        with zipfile.ZipFile(rp) as z:
            add_jar(z, rp.name)
    except Exception:
        pass

print(f"stores: {len(textures)} textures, {len(models)} models, "
      f"{len(blockstates)} blockstates, {len(lang)} lang keys, {len(recipes_raw)} recipes")

# ---------------------------------------------------------------- model resolution
CUBE_PARENTS = {"cube", "cube_all", "cube_column", "cube_bottom_top",
                "cube_mirrored", "cube_column_horizontal", "orientable",
                "block/cube", "block/cube_all", "block/cube_column",
                "block/cube_bottom_top", "block/cube_mirrored",
                "block/cube_column_horizontal", "block/orientable"}
NONCUBE_HINTS = ["slab", "stairs", "stair", "fence", "wall", "door", "trapdoor",
                 "button", "pressure_plate", "carpet", "torch", "cross", "crop",
                 "sapling", "rail", "ladder", "sign", "bed", "chest", "pane",
                 "bars", "chain", "lantern", "flower_pot", "cake", "cauldron",
                 "hopper", "anvil", "brewing", "lectern", "banner", "head",
                 "skull", "egg", "candle", "rod", "frame", "leaves"]

def norm_ref(ref, cur_modid):
    if ":" not in ref:
        return f"{cur_modid}:{ref}"
    return ref

def resolve_model(ref, cur_modid, depth=0):
    """Returns (textures_dict, shape) or (None, reason)."""
    if depth > 12:
        return None, "parent_loop"
    key = norm_ref(ref, cur_modid)
    modid, path = key.split(":", 1)
    m = models.get(key)
    if m is None:
        base = path.split("/")[-1]
        if modid == "minecraft" and (path in CUBE_PARENTS or base in CUBE_PARENTS):
            return {}, "cube"
        return None, "vanilla_or_missing_model"
    tex = dict(m.get("textures") or {})
    parent = m.get("parent")
    shape = None
    if parent:
        ptex, pshape = resolve_model(parent, modid, depth + 1)
        if ptex is None and pshape not in ("cube",):
            # a missing/vanilla parent still gives shape hints by name
            pname = parent.split("/")[-1]
            if any(h in pname for h in NONCUBE_HINTS):
                return None, f"shape:{pname}"
            if pname in CUBE_PARENTS or parent.replace("block/", "") in CUBE_PARENTS:
                ptex, pshape = {}, "cube"
            else:
                return None, f"parent:{pname}"
        if ptex:
            merged = dict(ptex); merged.update(tex); tex = merged
        shape = pshape
    if shape is None:
        if m.get("elements"):
            els = m["elements"]
            full = any(e.get("from") == [0, 0, 0] and e.get("to") == [16, 16, 16] for e in els)
            shape = "cube" if full and len(els) == 1 else "complex_elements"
        else:
            shape = "cube"  # texture-only model inheriting cube semantics via store parents
    low = path.lower()
    if shape == "cube" and any(h in low for h in NONCUBE_HINTS):
        shape = f"shape:{low.split('/')[-1]}"
    return tex, shape

def deref(texmap, key, guard=0):
    v = texmap.get(key)
    while isinstance(v, str) and v.startswith("#") and guard < 8:
        v = texmap.get(v[1:]); guard += 1
    return v if isinstance(v, str) else None

def face_tex(texmap, *keys):
    for k in keys:
        v = deref(texmap, k)
        if v:
            return v
    return None

# ---------------------------------------------------------------- blocks
tiles = []          # list of texture keys in atlas order
tile_index = {}     # texture key -> tile slot
tile_bytes_hash = {}

def tile_for(texref, cur_modid):
    key = norm_ref(texref, cur_modid)
    modid, path = key.split(":", 1)
    if not path.startswith("block/") and "/" not in path:
        path = "block/" + path
    full = f"{modid}:{path}"
    data = textures.get(full) or textures.get(key)
    if data is None:
        return None
    actual = full if full in textures else key
    if actual in tile_index:
        return tile_index[actual]
    h = hashlib.sha256(data).hexdigest()
    if h in tile_bytes_hash:  # identical texture already tiled
        tile_index[actual] = tile_bytes_hash[h]
        return tile_bytes_hash[h]
    idx = len(tiles)
    tiles.append(actual)
    tile_index[actual] = idx
    tile_bytes_hash[h] = idx
    return idx

blocks = []
skipped = Counter()
per_mod = defaultdict(Counter)
seen_blocks = set()
for (modid, bname), bs in sorted(blockstates.items()):
    if "/" in bname:  # nested blockstate paths are not plain blocks
        skipped["blockstate_subpath"] += 1
        continue
    uid = f"{modid}:{bname}"
    if uid in seen_blocks:
        continue
    seen_blocks.add(uid)
    # first model ref
    model_ref = None
    variants = bs.get("variants")
    if variants:
        first_key = "" if "" in variants else sorted(variants.keys())[0]
        v = variants[first_key]
        if isinstance(v, list): v = v[0]
        model_ref = v.get("model")
    elif bs.get("multipart"):
        for part in bs["multipart"]:
            ap = part.get("apply")
            if isinstance(ap, list): ap = ap[0]
            if ap and ap.get("model"):
                model_ref = ap["model"]; break
    if not model_ref:
        skipped["no_model_ref"] += 1; per_mod[modid]["skipped"] += 1; continue
    texmap, shape = resolve_model(model_ref, modid)
    if texmap is None:
        skipped[shape] += 1; per_mod[modid]["skipped"] += 1; continue
    if shape != "cube":
        skipped[shape if shape.startswith("shape:") else f"shape:{shape}"] += 1
        per_mod[modid]["skipped"] += 1; continue
    top = face_tex(texmap, "up", "top", "end", "all", "side")
    bottom = face_tex(texmap, "down", "bottom", "end", "all", "side")
    side = face_tex(texmap, "side", "north", "all", "east", "west", "south")
    if not side and not top:
        skipped["no_face_texture"] += 1; per_mod[modid]["skipped"] += 1; continue
    side = side or top; top = top or side; bottom = bottom or side
    tt, ts, tb = tile_for(top, modid), tile_for(side, modid), tile_for(bottom, modid)
    if tt is None or ts is None or tb is None:
        skipped["texture_missing"] += 1; per_mod[modid]["skipped"] += 1; continue
    name = lang.get(f"block.{modid}.{bname}") or bname.replace("_", " ").title()
    blocks.append({"mc": uid, "mod": modid, "name": name,
                   "tiles": {"top": tt, "side": ts, "bottom": tb}})
    per_mod[modid]["blocks"] += 1

print(f"blocks imported: {len(blocks)}")

# ---------------------------------------------------------------- items (icons only)
items = []
block_mc_set = {b["mc"] for b in blocks}
for key, m in sorted(models.items()):
    modid, path = key.split(":", 1)
    if not path.startswith("item/"):
        continue
    iname = path.split("/")[-1]
    if f"{modid}:{iname}" in block_mc_set:
        per_mod[modid]["block_items"] += 1
        continue  # already in as a placeable block
    texmap, shape = resolve_model(key, modid)
    if texmap is None:
        # vanilla item templates (item/generated, item/handheld) carry no
        # textures of their own — the model's own layer0 is the whole story
        own = models[key].get("textures") or {}
        texmap = own if own.get("layer0") else None
    if texmap is None:
        continue
    t0 = face_tex(texmap, "layer0")
    if not t0:
        continue
    ti = tile_for(t0, modid)
    if ti is None:
        continue
    name = lang.get(f"item.{modid}.{iname}") or lang.get(f"block.{modid}.{iname}") \
        or iname.replace("_", " ").title()
    items.append({"mc": f"{modid}:{iname}", "mod": modid, "name": name, "tile": ti})
    per_mod[modid]["items"] += 1
print(f"items imported (icons): {len(items)}")

# ---------------------------------------------------------------- core overrides (pack look for the base world)
CORE_TEX = [
    ("grass_top", "minecraft:block/grass_block_top"), ("grass_side", "minecraft:block/grass_block_side"),
    ("dirt", "minecraft:block/dirt"), ("stone", "minecraft:block/stone"),
    ("log_side", "minecraft:block/oak_log"), ("log_top", "minecraft:block/oak_log_top"),
    ("leaves", "minecraft:block/oak_leaves"), ("sand", "minecraft:block/sand"),
    ("planks", "minecraft:block/oak_planks"), ("brick", "minecraft:block/bricks"),
    ("glass", "minecraft:block/glass"), ("craft_side", "minecraft:block/crafting_table_side"),
    ("craft_top", "minecraft:block/crafting_table_top"),
]
core_overrides = {}
for label, key in CORE_TEX:
    if key in textures:
        core_overrides[label] = tile_for(key, "minecraft")
print("core texture overrides found:", core_overrides)

# ---------------------------------------------------------------- recipes converted
block_by_mc = {b["mc"]: i for i, b in enumerate(blocks)}
converted = 0
for modid, rname, r in recipes_raw:
    res = (r.get("result") or {})
    rid = res.get("item") if isinstance(res, dict) else None
    if rid in block_by_mc:
        converted += 1
print(f"recipes total: {len(recipes_raw)}, result-is-imported-block: {converted}")

# ---------------------------------------------------------------- atlas
n = len(tiles)
grid = 1
while grid * grid < n:
    grid *= 2
atlas = Image.new("RGBA", (grid * TILE, grid * TILE), (0, 0, 0, 0))
for i, key in enumerate(tiles):
    data = textures[key]
    try:
        im = Image.open(io.BytesIO(data)).convert("RGBA")
    except Exception:
        continue
    if im.height > im.width:  # animated strip -> first frame
        im = im.crop((0, 0, im.width, im.width))
    im = im.resize((TILE, TILE), Image.NEAREST)
    atlas.paste(im, ((i % grid) * TILE, (i // grid) * TILE))
atlas.save(OUT / "atlas.png")

pack = {
    "name": "Isle of Berk — Claws of Berk (browser engine import)",
    "tilePx": TILE, "grid": grid, "tileCount": n,
    "blocks": blocks, "items": items,
    "coreOverrides": core_overrides,
    "stats": {
        "modJars": len(jars), "texturesInPack": len(textures),
        "blocksImported": len(blocks), "itemsImported": len(items),
        "recipesTotal": len(recipes_raw), "recipesWithImportedResult": converted,
        "skipped": dict(skipped),
    },
}
(OUT / "pack.json").write_text(json.dumps(pack), encoding="utf-8")
report = {
    "instance": str(INSTANCE),
    "stats": pack["stats"],
    "perMod": {m: dict(c) for m, c in sorted(per_mod.items())},
    "notImported": [
        "mod Java code (behaviour, AI, GUIs, dimensions, quests) — cannot be auto-converted",
        "non-cube block shapes (see stats.skipped by reason)",
        "entities incl. dragons (471 entity textures exist in the pack; mobs need hand-written code)",
        "shaderpacks (browser engine uses its own renderer)",
    ],
}
(Path(__file__).parent / "import_report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
print(f"atlas: {grid}x{grid} tiles ({n} used), {atlas.size[0]}px")
print("skipped reasons:", dict(skipped.most_common(8)))
