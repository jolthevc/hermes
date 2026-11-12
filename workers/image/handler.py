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

        _pipe = Flux2KleinPipeline.from_pretrained(IMAGE_MODEL, torch_dtype=torch.bfloat16).to("cuda")
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


def cutout(ctx: Ctx) -> dict[str, Any]:
    if MOCK:
        ctx.write("image", mock.png(rgba=(200, 120, 60, 0)), {"mock": True})
        return {}

    import torch
    from PIL import Image
    from torchvision import transforms

    img = Image.open(io.BytesIO(ctx.input_bytes("image"))).convert("RGB")
    tf = transforms.Compose(
        [
            transforms.Resize((1024, 1024)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )
    with torch.no_grad():
        pred = _get_matting()(tf(img).unsqueeze(0).to("cuda").half())[-1].sigmoid().cpu()[0].squeeze()
    mask = transforms.ToPILImage()(pred).resize(img.size)
    img.putalpha(mask)
    ctx.write("image", _png(img), {"model": MATTING_MODEL})
    return {}


TASKS = {"generate": generate, "cutout": cutout}
