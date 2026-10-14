#!/usr/bin/env python3
"""Berk Engine entity importer: GeckoLib dragon models -> web entity pack.

Reads the Isle of Berk jar inside an installed instance:
  assets/isleofberk/geo/dragons/*.geo.json        (bone hierarchies + cubes)
  assets/isleofberk/animations/dragons/*.json     (keyframed animations)
  assets/isleofberk/textures/dragons/<sp>/<sp>.png (main skin per species)

Outputs into the web pack dir:
  entities.json   (bones, cubes with face UVs, animations as keyframe
                   lists; Molang expressions kept as strings for the
                   engine's tiny safe evaluator)
  entity_atlas.png (all skins shelf-packed at native size)

Usage: import_entities.py <instance_dir> <pack_out_dir>
"""
import io
import json
import sys
import zipfile
from pathlib import Path

from PIL import Image

FACES = ["north", "south", "east", "west", "up", "down"]

def box_uv_faces(u, v, sx, sy, sz):
    """Standard Bedrock box-UV layout -> per-face [u, v, w, h]."""
    return {
        "east":  [u, v + sz, sz, sy],
        "west":  [u + sz + sx, v + sz, sz, sy],
        "north": [u + sz, v + sz, sx, sy],
        "south": [u + sz + sx + sz, v + sz, sx, sy],
        "up":    [u + sz, v, sx, sz],
        "down":  [u + sz + sx, v, sx, sz],
    }

def norm_cube(cube):
    faces = {}
    uv = cube.get("uv")
    size = cube.get("size", [0, 0, 0])
    if isinstance(uv, dict):
        for f, fd in uv.items():
            if f not in FACES: continue
            puv = fd.get("uv", [0, 0]); psz = fd.get("uv_size", [0, 0])
            faces[f] = [float(puv[0]), float(puv[1]), float(psz[0]), float(psz[1])]
    elif isinstance(uv, list):
        faces = box_uv_faces(float(uv[0]), float(uv[1]), size[0], size[1], size[2])
    rot = cube.get("rotation")
    return {"o": cube.get("origin", [0, 0, 0]), "s": size,
            "p": cube.get("pivot"), "r": rot, "faces": faces}

def norm_keyframes(val):
    """Bedrock animation channel value -> sorted [[t, [x,y,z]], ...] or
    [[0, [x,y,z]]] for constants. Values may contain Molang strings (kept)."""
    def vec(v):
        if isinstance(v, dict):
            v = v.get("post", v.get("pre", [0, 0, 0]))
        if isinstance(v, (int, float)): return [v, v, v]
        return list(v)
    if val is None: return None
    if isinstance(val, dict) and "vector" in val:
        return [[0.0, vec(val["vector"])]]
    if isinstance(val, list):
        return [[0.0, vec(val)]]
    if isinstance(val, dict):
        out = []
        for tk, tv in val.items():
            try: t = float(tk)
            except (TypeError, ValueError): continue
            out.append([t, vec(tv)])
        return sorted(out) or None
    return None

def main():
    instance, outdir = Path(sys.argv[1]), Path(sys.argv[2])
    jar = next((instance / "mods").glob("isleofberk-1.2.0.jar"))
    z = zipfile.ZipFile(jar)
    names = set(z.namelist())
    lang = json.loads(z.read("assets/isleofberk/lang/en_us.json"))

    # species id -> (texture dir, main-skin file stem picker)
    SPECIAL = {
        "speed_stinger_leader": ("speed_stinger", lambda f: f == "speed_stinger_leader" or f.endswith("_leader")),
        "terrible_terror_titan_wing": ("terrible_terror", lambda f: f == "titan_wing"),
    }

    def skins_for(sp):
        """All usable skins for a species: [{stem, img, membrane_img|None}]."""
        tex_dir, picker = SPECIAL.get(sp, (sp, None))
        base = f"assets/isleofberk/textures/dragons/{tex_dir}/"
        out = []
        for n in sorted(names):
            if not (n.startswith(base) and n.endswith(".png")):
                continue
            stem = Path(n).name[:-4]
            if "_sleeping" in stem or stem == "equipment" or stem.endswith("_membranes") or stem == "head":
                continue
            if picker and not picker(stem):
                continue
            mem = None
            mp = f"{base}{stem}_membranes.png"
            if mp in names:
                mem = Image.open(io.BytesIO(z.read(mp))).convert("RGBA")
            out.append({"stem": stem, "img": Image.open(io.BytesIO(z.read(n))).convert("RGBA"),
                        "membrane": mem})
        # main skin first (the one named like the species / chosen main)
        out.sort(key=lambda s: 0 if s["stem"] in (sp, "titan_wing", "speed_stinger_leader") else 1)
        return out

    species = []
    skin_images = {}  # (species, stem, kind) -> PIL image
    for n in sorted(names):
        if not (n.startswith("assets/isleofberk/geo/dragons/") and n.endswith(".geo.json")):
            continue
        sp = Path(n).name.replace(".geo.json", "")
        g = json.loads(z.read(n))
        geo = g["minecraft:geometry"][0]
        desc = geo["description"]
        bones = []
        total_cubes = 0
        for b in geo.get("bones", []):
            cubes = [norm_cube(c) for c in b.get("cubes", [])]
            total_cubes += len(cubes)
            bones.append({"name": b["name"], "parent": b.get("parent"),
                          "pivot": b.get("pivot", [0, 0, 0]),
                          "rot": b.get("rotation", [0, 0, 0]), "cubes": cubes})
        # animations
        anim_path = f"assets/isleofberk/animations/dragons/{sp}.animation.json"
        anims = {}
        molang = 0
        if anim_path in names:
            aj = json.loads(z.read(anim_path))
            for aname, a in (aj.get("animations") or {}).items():
                chan = {}
                for bone, chans in (a.get("bones") or {}).items():
                    entry = {}
                    for kind in ("rotation", "position", "scale"):
                        if kind in chans:
                            kf = norm_keyframes(chans[kind])
                            if kf:
                                entry[kind] = kf
                                molang += sum(1 for _, v in kf for x in v if isinstance(x, str))
                    if entry: chan[bone] = entry
                anims[aname] = {"len": a.get("animation_length", 1.0),
                                "loop": bool(a.get("loop")), "bones": chan}
        skin_list = skins_for(sp)
        if not skin_list:
            print(f"  !! {sp}: no skin texture found, skipped")
            continue
        for sk in skin_list:
            skin_images[(sp, sk["stem"], "skin")] = sk["img"]
            if sk["membrane"] is not None:
                skin_images[(sp, sk["stem"], "membrane")] = sk["membrane"]
        display = lang.get(f"entity.isleofberk.{sp}") or sp.replace("_", " ").title()
        # animation aliases by suffix (nightfury.walk -> walk)
        aliases = {}
        for aname in anims:
            suffix = aname.split(".")[-1]
            aliases[suffix] = aname
        species.append({
            "id": sp, "name": display, "cubes": total_cubes,
            "tex_model": [desc.get("texture_width", 64), desc.get("texture_height", 64)],
            "bones": bones, "animations": anims, "aliases": aliases,
            "molang_values": molang,
            "skin_stems": [sk["stem"] for sk in skin_list],
            "skin_has_membrane": {sk["stem"]: sk["membrane"] is not None for sk in skin_list},
        })
        print(f"  {sp}: {len(bones)} bones, {total_cubes} cubes, {len(anims)} animations, {len(skin_list)} skins")

    # Variant hulls ship no animation files of their own — borrow the
    # base species' set so they still move.
    by_id = {s["id"]: s for s in species}
    for sub, base in (("night_light", "night_fury"),
                      ("speed_stinger_leader", "speed_stinger"),
                      ("terrible_terror_titan_wing", "terrible_terror")):
        if sub in by_id and not by_id[sub]["animations"] and base in by_id:
            by_id[sub]["animations"] = by_id[base]["animations"]
            by_id[sub]["aliases"] = by_id[base]["aliases"]
            print(f"  {sub}: borrowed {base} animations (same hull)")

    # shelf-pack every skin + membrane image into one atlas
    ATLAS_W = 2048
    x = y = 0; row_h = 0; placements = {}
    order = sorted(skin_images.items(), key=lambda kv: -kv[1].size[1])
    for key, im in order:
        w, h = im.size
        if x + w > ATLAS_W:
            x = 0; y += row_h; row_h = 0
        placements[key] = [x, y, w, h]
        x += w; row_h = max(row_h, h)
    total_h = y + row_h
    atlas = Image.new("RGBA", (ATLAS_W, total_h), (0, 0, 0, 0))
    for key, im in skin_images.items():
        px, py, _, _ = placements[key]
        atlas.paste(im, (px, py))
    outdir.mkdir(parents=True, exist_ok=True)
    atlas.save(outdir / "entity_atlas.png")
    for s in species:
        skins_out = []
        for stem in s.pop("skin_stems"):
            entry = {"name": stem.replace("_", " ").title(),
                     "rect": placements[(s["id"], stem, "skin")]}
            mk = (s["id"], stem, "membrane")
            if mk in placements:
                entry["membrane_rect"] = placements[mk]
            skins_out.append(entry)
        s["skins"] = skins_out
        s["tex_rect"] = skins_out[0]["rect"]
        s.pop("skin_has_membrane", None)
    payload = {"format": 1, "atlas": [ATLAS_W, total_h], "species": species}
    (outdir / "entities.json").write_text(json.dumps(payload, separators=(",", ":")))
    print(f"species: {len(species)} | atlas {ATLAS_W}x{total_h} | entities.json {(outdir / 'entities.json').stat().st_size} bytes")

if __name__ == "__main__":
    main()
