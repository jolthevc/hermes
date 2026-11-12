"""
Headless render test for Blender 5.x: Grease Pencil v3 + EEVEE toon scene.

Run:
    blender -b --factory-startup --python-exit-code 3 --python scene_test.py -- --out ./out

Options (after the "--"):
    --out DIR           output directory (required)
    --frames N          frames per scene (default 48)
    --scenes LIST       comma list of: gp,eevee   (default "gp,eevee")
    --samples N         EEVEE render samples (default 16)
    --percent P         resolution percentage (default 100 -> 1080x1920)
    --outline MODE      lineart | freestyle | none   (default lineart; falls back to freestyle)

Writes <out>/report.json (rewritten after every frame, so a crash still leaves
partial data) and PNG frames in <out>/gp/ and <out>/eevee/.
Exit code: 0 = all requested scenes rendered, 2 = some scene failed.

API facts this script relies on (checked against docs.blender.org/api/5.2 and the
5.0 / 5.2 Python API release notes):
  * bpy.data.grease_pencils -> BlendDataGreasePencilsV3 (5.0 renamed it from
    bpy.data.grease_pencils_v3; in 4.3-4.5 bpy.data.grease_pencils is LEGACY GP)
  * Object type 'GREASEPENCIL'
  * GreasePencil.layers.new(name) ; layer.frames.new(frame_number) ; frame.drawing
  * GreasePencilDrawing.add_strokes(sizes) ; drawing.strokes[i] (python wrapper)
    stroke.cyclic / material_index / points[j].position / .radius / .opacity
  * bpy.data.materials.create_gpencil_data(mat) ; mat.grease_pencil.show_fill etc.
  * Modifier type 'LINEART' (GreasePencilLineartModifier: source_type,
    source_collection, target_layer, target_material, radius)
  * Render engine id 'BLENDER_EEVEE' (5.0 renamed from 'BLENDER_EEVEE_NEXT')
  * ImageFormatSettings.media_type must be set before file_format (5.0)
  * gpu.init() exists from 5.2 for background mode; gpu.platform.*_get()
"""

import json
import math
import os
import platform
import socket
import sys
import time
import traceback

import bpy

# --------------------------------------------------------------------------- args


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    import argparse
    p = argparse.ArgumentParser(prog="scene_test.py")
    p.add_argument("--out", required=True)
    p.add_argument("--frames", type=int, default=48)
    p.add_argument("--scenes", default="gp,eevee")
    p.add_argument("--samples", type=int, default=16)
    p.add_argument("--percent", type=int, default=100)
    p.add_argument("--outline", default="lineart", choices=["lineart", "freestyle", "none"])
    return p.parse_args(argv)


ARGS = parse_args()
OUT = os.path.abspath(ARGS.out)
os.makedirs(OUT, exist_ok=True)
REPORT_PATH = os.path.join(OUT, "report.json")

RES_X, RES_Y, FPS = 1080, 1920, 24


def _s(v):
    return v.decode(errors="replace") if isinstance(v, bytes) else str(v)

REPORT = {
    "schema": 1,
    "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "host": socket.gethostname(),
    "platform": platform.platform(),
    "env": {k: os.environ.get(k) for k in (
        "DISPLAY", "WAYLAND_DISPLAY", "NVIDIA_VISIBLE_DEVICES",
        "NVIDIA_DRIVER_CAPABILITIES", "RENDER_ATTEMPT")},
    "blender": {
        "version_string": bpy.app.version_string,
        "version": list(bpy.app.version),
        "build_hash": _s(getattr(bpy.app, "build_hash", "")),
        "build_date": _s(getattr(bpy.app, "build_date", "")),
        "background": bpy.app.background,
        "argv": sys.argv,
    },
    "settings": {"resolution": [RES_X, RES_Y], "percent": ARGS.percent, "fps": FPS,
                 "frames": ARGS.frames, "samples": ARGS.samples, "outline": ARGS.outline},
    "gpu": {},
    "api_checks": {},
    "scenes": {},
    "overall_pass": False,
    "notes": [],
}


def save_report():
    tmp = REPORT_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(REPORT, f, indent=2, default=str)
    os.replace(tmp, REPORT_PATH)


def log(msg):
    print("[scene_test] " + msg, flush=True)


class ApiMissing(RuntimeError):
    pass


# --------------------------------------------------------------------------- GPU info


def gpu_info(stage):
    info = {}
    try:
        import gpu
        if hasattr(gpu, "init"):  # 5.2+: explicitly initialise GPU in --background
            REPORT["gpu"][stage] = {"gpu.init": "attempting (if the run stops here, gpu.init crashed)"}
            save_report()
            try:
                gpu.init()
                info["gpu.init"] = "ok"
            except Exception as e:  # SystemError when no GPU context possible
                info["gpu.init"] = "FAILED: %r" % (e,)
        else:
            info["gpu.init"] = "not available (<5.2); GPU context is created lazily at render"
        plat = getattr(gpu, "platform", None)
        for fn in ("backend_type_get", "device_type_get", "vendor_get", "renderer_get", "version_get"):
            try:
                info[fn.replace("_get", "")] = getattr(plat, fn)()
            except Exception as e:
                info[fn.replace("_get", "")] = "error: %r" % (e,)
        try:
            devs = plat.devices_get()
            info["devices"] = [{k: str(getattr(d, k, "")) for k in dir(d) if not k.startswith("_")}
                               for d in devs]
        except Exception as e:
            info["devices"] = "error: %r" % (e,)
    except Exception as e:
        info["error"] = "import gpu failed: %r" % (e,)
    r = str(info.get("renderer", "")).lower()
    info["looks_like_software"] = any(s in r for s in ("llvmpipe", "softpipe", "swrast", "lavapipe")) \
        or info.get("device_type") == "SOFTWARE"
    info["looks_like_nvidia"] = ("nvidia" in r) or info.get("device_type") == "NVIDIA"
    REPORT["gpu"][stage] = info
    save_report()
    log("GPU (%s): %s" % (stage, {k: v for k, v in info.items() if k != "devices"}))
    return info


# --------------------------------------------------------------------------- API detection


def detect_api():
    v = bpy.app.version
    checks = REPORT["api_checks"]
    if v < (4, 3, 0):
        raise ApiMissing("Blender %s is too old: Grease Pencil v3 needs >= 4.3 (this kit targets 5.x)."
                         % bpy.app.version_string)
    # GP datablock collection
    if v >= (5, 0, 0):
        coll_name = "grease_pencils"
    else:
        coll_name = "grease_pencils_v3"
    coll = getattr(bpy.data, coll_name, None)
    checks["gp_collection"] = "bpy.data." + coll_name if coll is not None else "MISSING"
    if coll is None:
        raise ApiMissing("bpy.data.%s not found in Blender %s (expected GPv3 datablock collection)."
                         % (coll_name, bpy.app.version_string))
    # EEVEE engine id
    eevee_ids = ["BLENDER_EEVEE"] if v >= (5, 0, 0) else ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"]
    checks["eevee_candidates"] = eevee_ids
    checks["has_gpu_init"] = False
    try:
        import gpu
        checks["has_gpu_init"] = hasattr(gpu, "init")
    except Exception:
        pass
    save_report()
    return coll, eevee_ids


def require(obj, attr, what):
    if not hasattr(obj, attr):
        raise ApiMissing("API missing: %s (%s.%s) in Blender %s"
                         % (what, type(obj).__name__, attr, bpy.app.version_string))
    return getattr(obj, attr)


# --------------------------------------------------------------------------- common scene setup


def new_scene(name, engine_ids):
    sc = bpy.data.scenes.new(name)
    used = None
    errs = []
    for eid in engine_ids:
        try:
            sc.render.engine = eid
            used = eid
            break
        except Exception as e:
            errs.append("%s: %r" % (eid, e))
    if used is None:
        raise ApiMissing("Could not set EEVEE engine. Tried %s -> %s" % (engine_ids, errs))
    r = sc.render
    r.resolution_x, r.resolution_y = RES_X, RES_Y
    r.resolution_percentage = ARGS.percent
    r.fps = FPS
    r.fps_base = 1.0
    sc.frame_start, sc.frame_end = 1, ARGS.frames
    imf = r.image_settings
    if hasattr(imf, "media_type"):  # 5.0+: set media type before file format
        imf.media_type = "IMAGE"
    imf.file_format = "PNG"
    imf.color_mode = "RGB"
    try:
        sc.view_settings.view_transform = "Standard"  # flat toon colours, no AgX desaturation
    except Exception as e:
        REPORT["notes"].append("view_transform Standard not set: %r" % (e,))
    try:
        sc.eevee.taa_render_samples = ARGS.samples
    except Exception as e:
        REPORT["notes"].append("taa_render_samples not set: %r" % (e,))
    world = bpy.data.worlds.new(name + "_World")
    sc.world = world
    return sc, used


def set_world_color(world, rgb, strength=1.0):
    try:
        if world.node_tree is None and hasattr(world, "use_nodes"):
            world.use_nodes = True  # <5.0 only; deprecated no-op in 5.x
        bg = None
        for n in world.node_tree.nodes:
            if n.type == "BACKGROUND":
                bg = n
        if bg is None:
            bg = world.node_tree.nodes.new("ShaderNodeBackground")
            out = world.node_tree.nodes.new("ShaderNodeOutputWorld")
            world.node_tree.links.new(bg.outputs[0], out.inputs["Surface"])
        bg.inputs["Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
        bg.inputs["Strength"].default_value = strength
    except Exception as e:
        REPORT["notes"].append("world colour not set: %r" % (e,))
        try:
            world.color = rgb
        except Exception:
            pass


def add_camera(sc, loc, rot_deg, ortho_scale=None, lens=50.0):
    cam_data = bpy.data.cameras.new(sc.name + "_Cam")
    if ortho_scale:
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = ortho_scale
    else:
        cam_data.lens = lens
    cam = bpy.data.objects.new(sc.name + "_Cam", cam_data)
    sc.collection.objects.link(cam)
    cam.location = loc
    cam.rotation_euler = tuple(math.radians(a) for a in rot_deg)
    sc.camera = cam
    return cam


# --------------------------------------------------------------------------- Grease Pencil scene


def gp_material(name, stroke_rgba, fill_rgba=None):
    mat = bpy.data.materials.new(name)
    require(bpy.data.materials, "create_gpencil_data", "BlendDataMaterials.create_gpencil_data")
    bpy.data.materials.create_gpencil_data(mat)
    gs = mat.grease_pencil
    gs.show_stroke = stroke_rgba is not None
    if stroke_rgba is not None:
        gs.color = stroke_rgba
    gs.show_fill = fill_rgba is not None
    if fill_rgba is not None:
        gs.fill_color = fill_rgba
    return mat


def ellipse(cx, cz, rx, rz, n=48):
    return [(cx + rx * math.cos(2 * math.pi * i / n), 0.0, cz + rz * math.sin(2 * math.pi * i / n))
            for i in range(n)]


def write_strokes(drawing, strokes):
    """strokes: list of dict(points=[(x,y,z)...], mat=int, cyclic=bool, radius=float)"""
    require(drawing, "add_strokes", "GreasePencilDrawing.add_strokes")
    base = len(drawing.strokes)
    drawing.add_strokes([len(s["points"]) for s in strokes])
    for i, s in enumerate(strokes):
        st = drawing.strokes[base + i]  # re-fetch after resize (slices are invalidated)
        st.cyclic = s.get("cyclic", True)
        st.material_index = s["mat"]
        pts = st.points
        r = s.get("radius", 0.04)
        for j, p in enumerate(s["points"]):
            pt = pts[j]
            pt.position = p
            pt.radius = r
            pt.opacity = 1.0


def build_gp_scene(gp_coll, engine_ids):
    sc, engine = new_scene("GP_Test", engine_ids)
    set_world_color(sc.world, (0.96, 0.93, 0.85))
    add_camera(sc, (0.0, -10.0, 0.0), (90.0, 0.0, 0.0), ortho_scale=7.5)

    gpd = gp_coll.new("GP_Character")
    REPORT["api_checks"]["gp_data_rna_type"] = gpd.rna_type.identifier
    obj = bpy.data.objects.new("GP_Character", gpd)
    REPORT["api_checks"]["gp_object_type"] = obj.type
    if obj.type != "GREASEPENCIL":
        raise ApiMissing("Expected object type GREASEPENCIL, got %r" % obj.type)
    sc.collection.objects.link(obj)

    ink = (0.08, 0.06, 0.06, 1.0)
    mats = [
        gp_material("GP_Skin", ink, (1.0, 0.80, 0.62, 1.0)),    # 0 head
        gp_material("GP_Shirt", ink, (0.20, 0.45, 0.85, 1.0)),  # 1 body
        gp_material("GP_Eye", None, (0.05, 0.05, 0.08, 1.0)),   # 2 eyes (fill only)
        gp_material("GP_Mouth", ink, (0.70, 0.12, 0.15, 1.0)),  # 3 mouth
        gp_material("GP_Line", ink, None),                      # 4 plain lines
    ]
    for m in mats:
        gpd.materials.append(m)

    layer = require(gpd, "layers", "GreasePencil.layers").new("Character")
    if hasattr(layer, "use_lights"):
        layer.use_lights = False  # flat 2D look, independent of scene lights

    n = ARGS.frames
    for f in range(1, n + 1):
        t = (f - 1) / FPS
        bob = 0.18 * math.sin(2 * math.pi * t)            # 1 bob per second
        squash = 1.0 + 0.04 * math.sin(2 * math.pi * t)
        head_z = 1.35 + bob
        open_amt = abs(math.sin(math.pi * t * 3.0))        # talking mouth
        frame = layer.frames.new(f)
        drawing = frame.drawing
        strokes = [
            # body (drawn first = behind head)
            {"points": ellipse(0.0, -1.15 + bob * 0.4, 1.0 / squash, 1.45 * squash), "mat": 1},
            # arms
            {"points": [(-0.9, 0, -0.8 + bob * 0.4), (-1.5, 0, -1.4 + bob), (-1.6, 0, -1.9 + bob)],
             "mat": 4, "cyclic": False, "radius": 0.05},
            {"points": [(0.9, 0, -0.8 + bob * 0.4), (1.5, 0, -1.4 - bob), (1.6, 0, -1.9 - bob)],
             "mat": 4, "cyclic": False, "radius": 0.05},
            # head
            {"points": ellipse(0.0, head_z, 1.15, 1.1), "mat": 0},
            # eyes (blink on frames 20-22)
            {"points": ellipse(-0.42, head_z + 0.22, 0.13, 0.02 if 20 <= f <= 22 else 0.2, 24),
             "mat": 2, "radius": 0.01},
            {"points": ellipse(0.42, head_z + 0.22, 0.13, 0.02 if 20 <= f <= 22 else 0.2, 24),
             "mat": 2, "radius": 0.01},
            # mouth: ellipse whose height changes every frame
            {"points": ellipse(0.0, head_z - 0.45, 0.32, 0.04 + 0.22 * open_amt, 32),
             "mat": 3, "radius": 0.025},
        ]
        write_strokes(drawing, strokes)

    REPORT["scenes"].setdefault("gp", {})["setup"] = {
        "layers": len(gpd.layers), "frames": len(layer.frames),
        "strokes_frame1": len(layer.frames[0].drawing.strokes) if len(layer.frames) else 0,
    }
    return sc, engine


# --------------------------------------------------------------------------- EEVEE toon scene


def make_mesh(name, kind, size, capsule_height=0.0):
    import bmesh
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    if kind == "sphere":
        bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=size)
        if capsule_height > 0:
            for v in bm.verts:
                if v.co.z > 1e-6:
                    v.co.z += capsule_height / 2
                elif v.co.z < -1e-6:
                    v.co.z -= capsule_height / 2
    elif kind == "grid":
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=size)
    bm.to_mesh(me)
    bm.free()
    if kind == "sphere":
        try:
            me.shade_smooth()
        except Exception:
            for p in me.polygons:
                p.use_smooth = True
    return me


def sock(sockets, name, idx=0):
    return sockets[name] if name in sockets else sockets[idx]


def toon_material(name, base_rgb):
    mat = bpy.data.materials.new(name)
    if getattr(mat, "node_tree", None) is None and hasattr(mat, "use_nodes"):
        mat.use_nodes = True  # <5.0 only
    nt = mat.node_tree
    nt.nodes.clear()
    diff = nt.nodes.new("ShaderNodeBsdfDiffuse")
    s2rgb = nt.nodes.new("ShaderNodeShaderToRGB")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    emit = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    sock(diff.inputs, "Color").default_value = (1, 1, 1, 1)
    cr = ramp.color_ramp
    cr.interpolation = "CONSTANT"
    shadow = tuple(c * 0.45 for c in base_rgb) + (1.0,)
    lit = tuple(base_rgb) + (1.0,)
    cr.elements[0].position = 0.0
    cr.elements[0].color = shadow
    cr.elements[1].position = 0.35
    cr.elements[1].color = lit
    nt.links.new(sock(diff.outputs, "BSDF"), sock(s2rgb.inputs, "Shader"))
    nt.links.new(sock(s2rgb.outputs, "Color"), sock(ramp.inputs, "Fac"))
    nt.links.new(sock(ramp.outputs, "Color"), sock(emit.inputs, "Color"))
    nt.links.new(sock(emit.outputs, "Emission"), sock(out.inputs, "Surface"))
    return mat


def add_obj(sc, coll, name, me, mat, loc, parent=None):
    o = bpy.data.objects.new(name, me)
    me.materials.append(mat)
    coll.objects.link(o)
    o.location = loc
    if parent is not None:
        o.parent = parent
    return o


def setup_lineart(sc, char_coll):
    gp_coll = getattr(bpy.data, "grease_pencils" if bpy.app.version >= (5, 0, 0) else "grease_pencils_v3")
    gpd = gp_coll.new("LineArt")
    ink = gp_material("LineArt_Ink", (0.03, 0.03, 0.05, 1.0), None)
    gpd.materials.append(ink)
    layer = gpd.layers.new("Lines")
    if hasattr(layer, "use_lights"):
        layer.use_lights = False
    layer.frames.new(1)  # one keyframe holds for the whole range; modifier regenerates per frame
    obj = bpy.data.objects.new("LineArt", gpd)
    sc.collection.objects.link(obj)
    mod = obj.modifiers.new("LineArt", "LINEART")
    if mod is None:
        raise ApiMissing("modifiers.new(type='LINEART') returned None")
    mod.source_type = "COLLECTION"
    mod.source_collection = char_coll
    mod.target_layer = "Lines"
    mod.target_material = ink
    mod.radius = 0.006
    return {"method": "lineart", "modifier_type": mod.type}


def setup_freestyle(sc):
    sc.render.use_freestyle = True
    sc.render.line_thickness_mode = "ABSOLUTE"
    sc.render.line_thickness = 3.0
    return {"method": "freestyle"}


def build_eevee_scene(engine_ids):
    sc, engine = new_scene("EEVEE_Toon", engine_ids)
    set_world_color(sc.world, (0.55, 0.75, 0.95), 1.0)
    add_camera(sc, (0.0, -7.0, 1.6), (90.0, 0.0, 0.0), lens=50.0)

    char_coll = bpy.data.collections.new("Character")
    sc.collection.children.link(char_coll)

    sun_data = bpy.data.lights.new("Sun", "SUN")
    sun_data.energy = 3.0
    sun = bpy.data.objects.new("Sun", sun_data)
    sc.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))

    skin = toon_material("Toon_Skin", (1.0, 0.72, 0.55))
    shirt = toon_material("Toon_Shirt", (0.95, 0.35, 0.25))
    dark = toon_material("Toon_Dark", (0.05, 0.05, 0.07))
    ground_mat = toon_material("Toon_Ground", (0.45, 0.75, 0.40))

    add_obj(sc, sc.collection, "Ground", make_mesh("Ground", "grid", 20.0), ground_mat, (0, 0, 0))
    body = add_obj(sc, char_coll, "Body", make_mesh("Body", "sphere", 0.6, capsule_height=1.0),
                   shirt, (0, 0, 1.1))
    head = add_obj(sc, char_coll, "Head", make_mesh("Head", "sphere", 0.55), skin, (0, 0, 1.25), parent=body)
    for side in (-1, 1):
        add_obj(sc, char_coll, "Eye%+d" % side, make_mesh("Eye", "sphere", 0.08), dark,
                (0.2 * side, -0.5, 0.1), parent=head)

    n = ARGS.frames
    for f in sorted(set(list(range(1, n + 1, 6)) + [n])):
        t = (f - 1) / FPS
        body.location = (0.0, 0.0, 1.1 + 0.25 * abs(math.sin(2 * math.pi * t)))
        body.rotation_euler = (0.0, 0.0, math.radians(20 * math.sin(math.pi * t)))
        head.rotation_euler = (math.radians(10 * math.sin(2 * math.pi * t)), 0.0, 0.0)
        body.keyframe_insert("location", frame=f)
        body.keyframe_insert("rotation_euler", frame=f)
        head.keyframe_insert("rotation_euler", frame=f)

    outline = {"method": "none"}
    if ARGS.outline == "lineart":
        try:
            outline = setup_lineart(sc, char_coll)
        except Exception:
            outline = {"method": "freestyle", "lineart_error": traceback.format_exc()}
            log("Line Art setup failed, falling back to Freestyle:\n" + outline["lineart_error"])
            outline.update(setup_freestyle(sc))
    elif ARGS.outline == "freestyle":
        outline = setup_freestyle(sc)
    REPORT["scenes"].setdefault("eevee", {})["setup"] = {"outline": outline}
    return sc, engine


# --------------------------------------------------------------------------- rendering


def frame_stats(path):
    """Simple pixel stats of a written PNG, to catch blank/black renders."""
    img = None
    try:
        import numpy as np
        img = bpy.data.images.load(path, check_existing=False)
        w, h = img.size
        ch = img.channels
        px = np.empty(w * h * ch, dtype=np.float32)
        img.pixels.foreach_get(px)
        rgb = px.reshape(-1, ch)[:, :3]
        corner = rgb[0]
        differ = np.abs(rgb - corner).sum(axis=1) > 0.05
        luma = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        sample = np.round(rgb[:: max(1, len(rgb) // 20000)], 2)
        return {"size": [w, h], "mean_luma": round(float(luma.mean()), 4),
                "distinct_colors_sampled": int(len(np.unique(sample, axis=0))),
                "pct_pixels_differ_from_corner": round(100.0 * float(differ.mean()), 2),
                "looks_blank": bool(differ.mean() < 0.01)}
    except Exception as e:
        return {"error": repr(e)}
    finally:
        if img is not None:
            bpy.data.images.remove(img)


def render_scene(key, sc, engine):
    res = REPORT["scenes"].setdefault(key, {})
    res.update({"engine": engine, "ok": False, "frames_done": 0, "per_frame_s": [], "error": None})
    save_report()
    outdir = os.path.join(OUT, key)
    os.makedirs(outdir, exist_ok=True)
    win = bpy.context.window
    if win is not None:
        win.scene = sc
    t_all = time.perf_counter()
    for f in range(sc.frame_start, sc.frame_end + 1):
        sc.frame_set(f)
        sc.render.filepath = os.path.join(outdir, "frame_%04d.png" % f)
        t0 = time.perf_counter()
        ret = bpy.ops.render.render(write_still=True, scene=sc.name)
        dt = time.perf_counter() - t0
        if "FINISHED" not in ret:
            raise RuntimeError("bpy.ops.render.render returned %r on frame %d" % (ret, f))
        res["per_frame_s"].append(round(dt, 3))
        res["frames_done"] += 1
        if not os.path.isfile(sc.render.filepath):
            raise RuntimeError("render returned but file not written: " + sc.render.filepath)
        if f == sc.frame_start:
            res["first_frame_stats"] = frame_stats(sc.render.filepath)
            if REPORT["gpu"].get("after_first_render") is None:
                gpu_info("after_first_render")
        log("%s frame %d/%d: %.2fs" % (key, f, sc.frame_end, dt))
        save_report()
    res["last_frame_stats"] = frame_stats(os.path.join(outdir, "frame_%04d.png" % sc.frame_end))
    res["total_s"] = round(time.perf_counter() - t_all, 3)
    pf = res["per_frame_s"]
    res["mean_frame_s"] = round(sum(pf) / len(pf), 3)
    res["mean_frame_s_excl_first"] = round(sum(pf[1:]) / max(1, len(pf) - 1), 3) if len(pf) > 1 else pf[0]
    blank = res["first_frame_stats"].get("looks_blank") or res["last_frame_stats"].get("looks_blank")
    res["ok"] = not blank
    if blank:
        res["error"] = "Rendered frames look blank (single colour). Check GPU/driver output."
    save_report()


def main():
    log("Blender %s, background=%s" % (bpy.app.version_string, bpy.app.background))
    gpu_info("startup")
    try:
        gp_coll, eevee_ids = detect_api()
    except ApiMissing as e:
        REPORT["fatal"] = str(e)
        save_report()
        log("FATAL: " + str(e))
        return 2

    wanted = [s.strip() for s in ARGS.scenes.split(",") if s.strip()]
    builders = {"gp": lambda: build_gp_scene(gp_coll, eevee_ids),
                "eevee": lambda: build_eevee_scene(eevee_ids)}
    all_ok = True
    for key in wanted:
        if key not in builders:
            REPORT["notes"].append("unknown scene %r ignored" % key)
            continue
        res = REPORT["scenes"].setdefault(key, {})
        log("=== scene %s ===" % key)
        try:
            t0 = time.perf_counter()
            sc, engine = builders[key]()
            res["build_s"] = round(time.perf_counter() - t0, 3)
            save_report()
            render_scene(key, sc, engine)
        except Exception as e:
            res["ok"] = False
            res["error"] = "%s: %s" % (type(e).__name__, e)
            res["traceback"] = traceback.format_exc()
            log("scene %s FAILED:\n%s" % (key, res["traceback"]))
        all_ok = all_ok and bool(res.get("ok"))
        save_report()

    g = REPORT["gpu"].get("after_first_render") or REPORT["gpu"].get("startup") or {}
    REPORT["software_rendering_suspected"] = bool(g.get("looks_like_software"))
    REPORT["nvidia_gpu_used"] = bool(g.get("looks_like_nvidia"))
    REPORT["overall_pass"] = all_ok
    REPORT["finished_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save_report()
    log("RESULT overall_pass=%s nvidia_gpu_used=%s software=%s report=%s"
        % (all_ok, REPORT["nvidia_gpu_used"], REPORT["software_rendering_suspected"], REPORT_PATH))
    return 0 if all_ok else 2


if __name__ == "__main__":
    try:
        code = main()
    except Exception:
        REPORT["fatal"] = traceback.format_exc()
        save_report()
        print(REPORT["fatal"], flush=True)
        code = 2
    sys.stdout.flush()
    # os._exit avoids SystemExit being swallowed/reported as a traceback by Blender.
    os._exit(code)
