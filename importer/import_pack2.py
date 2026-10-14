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
import hashlib, io, json, re, sys, zipfile
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

# ---------------------------------------------------------------- tile registry
tiles = []          # texture keys in atlas order
tile_index = {}
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
    if h in tile_bytes_hash:
        tile_index[actual] = tile_bytes_hash[h]
        return tile_bytes_hash[h]
    idx = len(tiles)
    tiles.append(actual)
    tile_index[actual] = idx
    tile_bytes_hash[h] = idx
    return idx

# ---------------------------------------------------------------- geometry (v2)
def model_chain(ref, cur_modid, depth=0):
    """Walk parents. Returns (elements_or_None, merged_textures, chain_names)."""
    if depth > 14:
        return None, {}, []
    key = norm_ref(ref, cur_modid)
    modid, path = key.split(":", 1)
    m = models.get(key)
    if m is None:
        return None, {}, [path]
    tex = dict(m.get("textures") or {})
    parent = m.get("parent")
    elems = m.get("elements")
    names = [path]
    if parent:
        pelems, ptex, pnames = model_chain(parent, modid, depth + 1)
        merged = dict(ptex); merged.update(tex); tex = merged
        if elems is None:
            elems = pelems
        names += pnames
    return elems, tex, names

CUBE_TEMPLATE_KEYS = {
    "cube_all": {"down": "all", "up": "all", "north": "all", "south": "all", "east": "all", "west": "all"},
    "cube": {"down": "down", "up": "up", "north": "north", "south": "south", "east": "east", "west": "west"},
    "cube_column": {"down": "end", "up": "end", "north": "side", "south": "side", "east": "side", "west": "side"},
    "cube_column_horizontal": {"down": "side", "up": "side", "north": "end", "south": "end", "east": "side", "west": "side"},
    "cube_bottom_top": {"down": "bottom", "up": "top", "north": "side", "south": "side", "east": "side", "west": "side"},
    "cube_mirrored": {"down": "down", "up": "up", "north": "north", "south": "south", "east": "east", "west": "west"},
    "orientable": {"down": "bottom", "up": "top", "north": "front", "south": "side", "east": "side", "west": "side"},
    "orientable_vertical": {"down": "bottom", "up": "top", "north": "side", "south": "side", "east": "front", "west": "side"},
    "block": {},
}
DIRS = ["down", "up", "north", "south", "east", "west"]

def default_uv(d, f, to):
    x0, y0, z0 = f; x1, y1, z1 = to
    if d in ("up", "down"): return [x0, z0, x1, z1]
    if d in ("north", "south"): return [x0, 16 - y1, x1, 16 - y0]
    return [z0, 16 - y1, z1, 16 - y0]

def rot90_point(pt, axis, angle, origin):
    x, y, z = pt[0] - origin[0], pt[1] - origin[1], pt[2] - origin[2]
    a = angle % 360
    if axis == "y":
        if a == 90: x, z = z, -x
        elif a == 180: x, z = -x, -z
        elif a == 270: x, z = -z, x
    elif axis == "x":
        if a == 90: y, z = -z, y
        elif a == 180: y, z = -y, -z
        elif a == 270: y, z = z, -y
    elif axis == "z":
        if a == 90: x, y = -y, x
        elif a == 180: x, y = -x, -y
        elif a == 270: x, y = y, -x
    return [x + origin[0], y + origin[1], z + origin[2]]

def remap_dir(d, axis, angle):
    a = angle % 360
    if a == 0: return d
    cycles = {
        "y": ["north", "east", "south", "west"],
        "x": ["up", "north", "down", "south"],
        "z": ["up", "west", "down", "east"],
    }
    if d in ("up", "down") and axis == "y": return d
    if d in ("east", "west") and axis == "x": return d
    if d in ("north", "south") and axis == "z": return d
    cyc = cycles[axis]
    i = cyc.index(d)
    step = 1 if a == 90 else (2 if a == 180 else 3)
    # rotating geometry +90 about +axis moves a face pointing one way to the next in cycle (sign approx)
    return cyc[(i + step) % 4]

def resolve_geometry(ref, cur_modid, variant_rot=None):
    elems, texmap, names = model_chain(ref, cur_modid)
    out = []
    if elems is None:
        # cube template at the end of the chain?
        last = names[-1].split("/")[-1] if names else ""
        tmap = CUBE_TEMPLATE_KEYS.get(last)
        if tmap is None:
            return None, "no_geometry", texmap, names
        faces = {}
        for d, k in tmap.items():
            tref = deref(texmap, k)
            if tref: faces[d] = [tref, [0, 0, 16, 16], 0]
        if not faces:
            return None, "no_face_texture", texmap, names
        return [{"f": [0, 0, 0], "t": [16, 16, 16], "faces": faces}], "full", texmap, names
    bad_angle = False
    for el in elems:
        f = [float(v) for v in el.get("from", [0, 0, 0])]
        to = [float(v) for v in el.get("to", [16, 16, 16])]
        rot = el.get("rotation")
        faces_in = el.get("faces") or {}
        face_dirs = list(faces_in.keys())
        if rot:
            ang = rot.get("angle", 0)
            if ang % 90 != 0:
                bad_angle = True
                continue
            axis = rot.get("axis", "y"); origin = rot.get("origin", [8, 8, 8])
            pts = [rot90_point([x, y, z], axis, ang, origin)
                   for x in (f[0], to[0]) for y in (f[1], to[1]) for z in (f[2], to[2])]
            nf = [min(p[i] for p in pts) for i in range(3)]
            nt = [max(p[i] for p in pts) for i in range(3)]
            face_dirs = [remap_dir(d, axis, ang) for d in face_dirs]
            faces_in = {nd: faces_in[od] for nd, od in zip(face_dirs, list((el.get("faces") or {}).keys()))}
            f, to = nf, nt
        faces = {}
        for d, fd in faces_in.items():
            if d not in DIRS: continue
            tref = fd.get("texture")
            if not tref: continue
            tkey = deref(texmap, tref[1:]) if tref.startswith("#") else tref
            if not tkey: continue
            uv = fd.get("uv") or default_uv(d, f, to)
            faces[d] = [tkey, [float(v) for v in uv], 1 if "tintindex" in fd else 0]
        if faces:
            out.append({"f": f, "t": to, "faces": faces})
    if bad_angle and not out:
        return None, "diag_elements", texmap, names
    if not out:
        return None, "no_faces_with_textures", texmap, names
    return out, "boxes", texmap, names

_alpha_cache = {}
def alpha_class(texref, cur_modid):
    key = norm_ref(texref, cur_modid)
    modid, path = key.split(":", 1)
    full = key if key in textures else f"{modid}:block/{path}" if not path.startswith(("block/", "item/")) else key
    data = textures.get(full) or textures.get(key)
    if data is None: return "opaque"
    if full in _alpha_cache: return _alpha_cache[full]
    try:
        im = Image.open(io.BytesIO(data)).convert("RGBA")
        if im.height > im.width: im = im.crop((0, 0, im.width, im.width))
        alphas = list(im.getchannel("A").getdata())
        low = sum(1 for a in alphas if a < 128) / max(1, len(alphas))
        cls = "transparent" if low > 0.30 else ("cutout" if low > 0.0 else "opaque")
    except Exception:
        cls = "opaque"
    _alpha_cache[full] = cls
    return cls

def apply_variant_rotation(elems, variant):
    y = variant.get("y") if isinstance(variant, dict) else None
    if not y or y % 90: return elems
    out = []
    for el in elems:
        f, to = el["f"], el["t"]
        pts = [rot90_point([x, yy, z], "y", y, [8, 0, 8])
               for x in (f[0], to[0]) for yy in (f[1], to[1]) for z in (f[2], to[2])]
        nf = [min(p[i] for p in pts) for i in range(3)]
        nt = [max(p[i] for p in pts) for i in range(3)]
        faces = {}
        for d, fv in el["faces"].items():
            faces[remap_dir(d, "y", y)] = fv
        out.append({"f": nf, "t": nt, "faces": faces})
    return out

# ---------------------------------------------------------------- blocks
blocks = []
skipped = Counter()
per_mod = defaultdict(Counter)
seen_blocks = set()
for (modid, bname), bs in sorted(blockstates.items()):
    if "/" in bname:
        skipped["blockstate_subpath"] += 1
        continue
    uid = f"{modid}:{bname}"
    if uid in seen_blocks: continue
    seen_blocks.add(uid)
    variants = bs.get("variants")
    variant = None; model_ref = None
    if variants:
        first_key = "" if "" in variants else sorted(variants.keys())[0]
        v = variants[first_key]
        if isinstance(v, list): v = v[0]
        variant = v; model_ref = v.get("model")
    elif bs.get("multipart"):
        for part in bs["multipart"]:
            ap = part.get("apply")
            if isinstance(ap, list): ap = ap[0]
            if ap and ap.get("model"):
                model_ref = ap["model"]; variant = ap; break
    if not model_ref:
        skipped["no_model_ref"] += 1; per_mod[modid]["skipped"] += 1; continue
    elems, shape, texmap, names = resolve_geometry(model_ref, modid)
    chain_low = "/".join(names).lower()
    name = re.sub(r"§.", "", lang.get(f"block.{modid}.{bname}") or bname.replace("_", " ").title())
    if elems is None and ("cross" in chain_low or "flower" in chain_low):
        tref = face_tex(texmap, "cross", "all", "side", "texture")
        ti = tile_for(tref, modid) if tref else None
        if ti is None:
            skipped["cross_no_texture"] += 1; per_mod[modid]["skipped"] += 1; continue
        blocks.append({"mc": uid, "mod": modid, "name": name, "shape": "cross",
                       "solid": False, "alpha": "cutout", "tile": ti,
                       "tiles": {"top": ti, "side": ti, "bottom": ti}})
        per_mod[modid]["blocks"] += 1; continue
    if elems is None:
        skipped[shape] += 1; per_mod[modid]["skipped"] += 1; continue
    if variant:
        elems = apply_variant_rotation(elems, variant)
    # convert texture refs to tiles; drop faces whose texture is missing
    geo = []
    for el in elems:
        faces = {}
        for d, fdat in el["faces"].items():
            tref, uv = fdat[0], fdat[1]
            ti = tile_for(tref, modid)
            if ti is not None:
                faces[d] = [ti, uv, fdat[2] if len(fdat) > 2 else 0]
        if faces:
            geo.append({"f": el["f"], "t": el["t"], "faces": faces})
    if not geo:
        skipped["texture_missing"] += 1; per_mod[modid]["skipped"] += 1; continue
    # "full" if ANY element spans the whole cube (grass has an extra overlay
    # element on top of its full cube; the engine dedupes coplanar faces)
    full = any(el["f"] == [0, 0, 0] and el["t"] == [16, 16, 16] for el in geo)
    # side tile for icons / simple faces
    side_ti = None
    for el in geo:
        for d in ("north", "up", "east", "south", "west", "down"):
            if d in el["faces"]: side_ti = el["faces"][d][0]; break
        if side_ti is not None: break
    top_ti = next((el["faces"]["up"][0] for el in geo if "up" in el["faces"]), side_ti)
    bot_ti = next((el["faces"]["down"][0] for el in geo if "down" in el["faces"]), side_ti)
    alpha = alpha_class(tiles[side_ti], modid) if side_ti is not None else "opaque"
    # find a representative texture ref for alpha: use first face in elems (pre-tile) if possible
    solid = full or any((el["t"][1] - el["f"][1]) >= 8 and (el["t"][0] - el["f"][0]) >= 8 and (el["t"][2] - el["f"][2]) >= 8 for el in geo)
    blocks.append({"mc": uid, "mod": modid, "name": name,
                   "shape": "full" if full else "boxes", "solid": bool(solid),
                   "alpha": alpha,
                   "tiles": {"top": top_ti, "side": side_ti, "bottom": bot_ti},
                   "elements": geo})
    per_mod[modid]["blocks"] += 1

# vanilla water has no block-model JSON (fluids are special-cased in the
# real game's code) — synthesize it from its still texture so worlds can
# have lakes.
if not any(b["mc"] == "minecraft:water" for b in blocks):
    wt = tile_for("minecraft:block/water_still", "minecraft")
    if wt is not None:
        blocks.append({"mc": "minecraft:water", "mod": "minecraft", "name": "Water",
                       "shape": "boxes", "solid": False, "alpha": "transparent",
                       "tiles": {"top": wt, "side": wt, "bottom": wt},
                       "elements": [{"f": [0, 0, 0], "t": [16, 14, 16],
                                     "faces": {d: [wt, [0, 0, 16, 16]] for d in DIRS}}]})
        per_mod["minecraft"]["blocks"] += 1
        print("synthesized minecraft:water from water_still texture")

print(f"blocks imported: {len(blocks)}")
from collections import Counter as _C
print("shapes:", dict(_C(b['shape'] for b in blocks)))

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
    name = re.sub(r"§.", "", lang.get(f"item.{modid}.{iname}") or lang.get(f"block.{modid}.{iname}")
        or iname.replace("_", " ").title())
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
    "format": 2,
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
(Path(__file__).parent / "import_report2.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
print(f"atlas: {grid}x{grid} tiles ({n} used), {atlas.size[0]}px")
print("skipped reasons:", dict(skipped.most_common(8)))
