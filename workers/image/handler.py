"""hermes-image: art generation (FLUX.2 [klein] 4B, Apache-2.0) + background removal (BiRefNet, MIT).

Tasks
- generate: params {prompt, width, height, steps?, seeds[], refs[]}; inputs: reference images named in refs;
            outputs: image_0..image_{len(seeds)-1} (PNG)
- cutout:   inputs {image}; outputs {image} (RGBA PNG, background removed)
"""

from __future__ import annotations

import io
import os
from typing import Any

from hermes_worker.server import MOCK, Ctx
from hermes_worker import mock

IMAGE_MODEL = os.environ.get("IMAGE_MODEL", "black-forest-labs/FLUX.2-klein-4B")
MATTING_MODEL = os.environ.get("MATTING_MODEL", "ZhengPeng7/BiRefNet")

_pipe = None
_matting = None


def warmup() -> None:
    _get_pipe()
    _get_matting()


def _get_pipe():
    global _pipe
    if _pipe is None:
        import torch
        from diffusers import Flux2KleinPipeline

        _pipe = Flux2KleinPipeline.from_pretrained(IMAGE_MODEL, torch_dtype=torch.bfloat16)
        # Peak use is ~19 GB. On Salad (Windows/WSL2 hosts) an over-full card silently spills to system RAM
        # and runs ~100x slower instead of failing, so on <20 GB cards move components on demand instead.
        if torch.cuda.get_device_properties(0).total_memory < 20e9:
            _pipe.enable_model_cpu_offload()
        else:
            _pipe.to("cuda")
    return _pipe


def _get_matting():
    global _matting
    if _matting is None:
        import torch
        from transformers import AutoModelForImageSegmentation

        m = AutoModelForImageSegmentation.from_pretrained(MATTING_MODEL, trust_remote_code=True)
        _matting = m.to("cuda").eval().half()
        torch.set_float32_matmul_precision("high")
    return _matting


def _png(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def generate(ctx: Ctx) -> dict[str, Any]:
    p = ctx.params
    seeds: list[int] = p.get("seeds") or [0]
    if MOCK:
        for i, _ in enumerate(seeds):
            ctx.write(f"image_{i}", mock.png(), {"seed": seeds[i], "mock": True})
        return {"images": len(seeds)}

    import torch
    from PIL import Image

    import time

    refs = [Image.open(io.BytesIO(ctx.input_bytes(n))).convert("RGB") for n in p.get("refs", [])]
    pipe = _get_pipe()
    diag = _diagnostics(pipe)
    per_image: list[float] = []
    for i, seed in enumerate(seeds):
        t0 = time.time()
        out = pipe(
            prompt=p["prompt"],
            image=refs or None,
            height=int(p.get("height", 1024)),
            width=int(p.get("width", 1024)),
            num_inference_steps=int(p.get("steps", 4)),
            guidance_scale=float(p.get("guidance", 1.0)),
            generator=torch.Generator(device="cuda").manual_seed(int(seed)),
        ).images[0]
        torch.cuda.synchronize()
        per_image.append(round(time.time() - t0, 2))
        ctx.write(f"image_{i}", _png(out), {"seed": seed, "model": IMAGE_MODEL, "seconds": per_image[-1]})
    return {
        "images": len(seeds),
        "per_image_s": per_image,
        "max_vram_gb": round(torch.cuda.max_memory_allocated() / 1e9, 2),
        **diag,
    }


def _diagnostics(pipe) -> dict[str, Any]:
    import torch

    props = torch.cuda.get_device_properties(0)
    devices = {n: str(getattr(pipe, n).device) for n in ("transformer", "text_encoder", "vae") if hasattr(pipe, n)}
    return {
        "gpu": props.name,
        "vram_total_gb": round(props.total_memory / 1e9, 1),
        "devices": devices,
        "dtype": str(pipe.transformer.dtype),
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "attn": str(getattr(pipe.transformer, "attn_processors", {}) and next(iter(pipe.transformer.attn_processors.values())).__class__.__name__),
    }


def _matte(img):
    """Alpha mask (PIL 'L') for the foreground of an RGB image."""
    import torch
    from torchvision import transforms

    tf = transforms.Compose(
        [
            transforms.Resize((1024, 1024)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )
    with torch.no_grad():
        pred = _get_matting()(tf(img).unsqueeze(0).to("cuda").half())[-1].sigmoid().cpu()[0].squeeze()
    return transforms.ToPILImage()(pred.float()).resize(img.size)


def cutout(ctx: Ctx) -> dict[str, Any]:
    if MOCK:
        ctx.write("image", mock.png(rgba=(200, 120, 60, 0)), {"mock": True})
        return {}

    from PIL import Image

    img = Image.open(io.BytesIO(ctx.input_bytes("image"))).convert("RGB")
    img.putalpha(_matte(img))
    ctx.write("image", _png(img), {"model": MATTING_MODEL})
    return {}


def _gen(prompt: str, refs: list, width: int, height: int, seed: int, steps: int = 4):
    import torch

    return _get_pipe()(
        prompt=prompt,
        image=refs or None,
        height=height,
        width=width,
        num_inference_steps=steps,
        guidance_scale=1.0,
        generator=torch.Generator(device="cuda").manual_seed(int(seed)),
    ).images[0]


def _diff_overlay(base, variant, base_alpha, threshold: int = 22, pad: int = 12):
    """Region where `variant` differs from `base` (an edit of it): returns (RGBA crop, box, change_ratio).

    Edits of the same canvas line up pixel-for-pixel apart from the intended change (face, mouth, eyelid),
    so the changed region becomes an overlay sprite placed at a known offset over the base puppet.
    """
    import numpy as np
    from PIL import Image, ImageFilter

    a = np.asarray(base.convert("RGB"), dtype=np.int16)
    b = np.asarray(variant.convert("RGB"), dtype=np.int16)
    d = np.abs(a - b).mean(axis=2).astype(np.uint8)
    m = Image.fromarray(d).filter(ImageFilter.GaussianBlur(3)).point(lambda v: 255 if v > threshold else 0)
    # Open (drop speckle from global drift), then close/dilate to make a solid, slightly padded region.
    m = m.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(2 * pad + 1))
    fg = np.asarray(base_alpha) > 32
    mask = (np.asarray(m) > 0) & fg
    fg_area = max(1, int(fg.sum()))
    ratio = float(mask.sum()) / fg_area
    if not mask.any():
        return None, None, 0.0
    ys, xs = np.where(mask)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    alpha = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2))
    sprite = variant.convert("RGB").copy()
    sprite.putalpha(alpha)
    return sprite.crop((x0, y0, x1, y1)), {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}, round(ratio, 4)


def _best_shift(base, edited, box, search: int = 12) -> tuple[int, int]:
    """Small (dx, dy) that best aligns `edited` to `base` inside `box`: edit models redraw the whole frame and
    can nudge the head a few pixels, which would show as a seam when the overlay is pasted on the base."""
    import numpy as np

    x, y, w, h = box["x"], box["y"], box["w"], box["h"]
    a = np.asarray(base.convert("L"), dtype=np.float32)
    b = np.asarray(edited.convert("L"), dtype=np.float32)
    ref = a[y : y + h, x : x + w]
    best, best_err = (0, 0), float("inf")
    for dy in range(-search, search + 1, 2):
        for dx in range(-search, search + 1, 2):
            ys, xs = y + dy, x + dx
            if ys < 0 or xs < 0 or ys + h > b.shape[0] or xs + w > b.shape[1]:
                continue
            # Compare only the outer ring of the box: that is where seams appear (the interior is meant to change).
            cand = b[ys : ys + h, xs : xs + w]
            ring = np.ones_like(ref, dtype=bool)
            ring[h // 6 : h - h // 6, w // 6 : w - w // 6] = False
            err = float(np.abs(cand[ring] - ref[ring]).mean())
            if err < best_err:
                best, best_err = (dx, dy), err
    return best


def _region_overlay(base, edited, box, feather_frac: float = 0.12):
    """Overlay sprite = the edited image inside a fixed region (e.g. the head), aligned to the base, with a soft
    elliptical edge so it blends into the base puppet. Returns (sprite RGBA, composite RGB, shift)."""
    import numpy as np
    from PIL import Image, ImageFilter

    x, y, w, h = box["x"], box["y"], box["w"], box["h"]
    dx, dy = _best_shift(base, edited, box)
    crop = edited.convert("RGB").crop((x + dx, y + dy, x + dx + w, y + dy + h))
    # Soft ellipse mask: full inside, fading over feather_frac of the box toward the edges.
    yy, xx = np.mgrid[0:h, 0:w]
    d = ((xx - (w - 1) / 2) / (w / 2)) ** 2 + ((yy - (h - 1) / 2) / (h / 2)) ** 2
    alpha = np.clip((1.0 - d) / max(1e-6, 2 * feather_frac), 0, 1)
    mask = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2))
    sprite = crop.copy()
    sprite.putalpha(mask)
    comp = base.convert("RGB").copy()
    comp.paste(crop, (x, y), mask)
    return sprite, comp, {"dx": dx, "dy": dy}


def variants(ctx: Ctx) -> dict[str, Any]:
    """Base image + aligned edit variants, all cut out — the raw material for a cutout puppet.

    params: {base: {prompt, refs[], width, height, seed} | None (then input "base" is used),
             variants: [{name, prompt, mode: "full" | "overlay", seed?}]}
    outputs: base (RGB), base_rgba, and one RGBA per variant
      - full:    whole canvas, aligned with base (pose swaps)
      - overlay: cropped changed region + {x,y,w,h} offset in meta (expressions, mouths, eyelids)
    """
    import time

    from PIL import Image

    p = ctx.params
    vs = p.get("variants", [])
    if MOCK:
        ctx.write("base", mock.png(), {"mock": True})
        ctx.write("base_rgba", mock.png(rgba=(200, 120, 60, 200)), {"mock": True})
        for v in vs:
            ctx.write(v["name"], mock.png(16, 16), {"mode": v["mode"], "box": {"x": 0, "y": 0, "w": 16, "h": 16}})
        return {"variants": len(vs)}

    t0 = time.time()
    if p.get("base"):
        b = p["base"]
        refs = [Image.open(io.BytesIO(ctx.input_bytes(n))).convert("RGB") for n in b.get("refs", [])]
        base = _gen(b["prompt"], refs, int(b.get("width", 1024)), int(b.get("height", 1536)), int(b.get("seed", 1)))
    else:
        base = Image.open(io.BytesIO(ctx.input_bytes("base"))).convert("RGB")
    base_alpha = _matte(base)
    base_rgba = base.copy()
    base_rgba.putalpha(base_alpha)
    ctx.write("base", _png(base), {"role": "base"})
    ctx.write("base_rgba", _png(base_rgba), {"role": "base_rgba", "box": {"x": 0, "y": 0, "w": base.width, "h": base.height}})

    # Overlays use a fixed region (from the vision locator, in base pixels) when given; else the pixel-diff fallback.
    region = p.get("region")
    report: dict[str, Any] = {}
    for v in vs:
        out = _gen(v["prompt"], [base], base.width, base.height, int(v.get("seed", 7)))
        if v["mode"] == "full":
            rgba = out.copy()
            rgba.putalpha(_matte(out))
            ctx.write(v["name"], _png(rgba), {"mode": "full", "box": {"x": 0, "y": 0, "w": out.width, "h": out.height}})
            # Uncut frame on its plain background, for the Part Judge (transparent PNGs read as black).
            if f"{v['name']}__raw" in ctx.job.outputs:
                ctx.write(f"{v['name']}__raw", _png(out), {"mode": "raw"})
            report[v["name"]] = {"mode": "full"}
        elif region:
            sprite, comp, shift = _region_overlay(base, out, region)
            ctx.write(v["name"], _png(sprite), {"mode": "overlay", "box": region, "shift": shift})
            # What viewers will actually see: base puppet with this overlay pasted. Judged for seams + the change.
            if f"{v['name']}__comp" in ctx.job.outputs:
                ctx.write(f"{v['name']}__comp", _png(comp), {"mode": "comp"})
            report[v["name"]] = {"mode": "overlay", "shift": shift}
        else:
            sprite, box, ratio = _diff_overlay(base, out, base_alpha)
            if sprite is None:  # edit changed nothing visible; keep a 1px transparent placeholder, flag it
                sprite, box = Image.new("RGBA", (1, 1)), {"x": 0, "y": 0, "w": 1, "h": 1}
            ctx.write(v["name"], _png(sprite), {"mode": "overlay", "box": box, "change_ratio": ratio})
            if f"{v['name']}__raw" in ctx.job.outputs:
                ctx.write(f"{v['name']}__raw", _png(out), {"mode": "raw"})
            report[v["name"]] = {"mode": "overlay", "change_ratio": ratio}
    return {"variants": len(vs), "seconds": round(time.time() - t0, 1), "report": report}


TASKS = {"generate": generate, "cutout": cutout, "variants": variants}
