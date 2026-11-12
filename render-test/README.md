# Blender 5.x headless GPU render test

Checks whether a rented Linux NVIDIA box with no display can render, from the command line:

- **Grease Pencil v3**: a 2D character drawn frame by frame (head, body, arms, eyes that blink, a mouth that changes shape) with fill materials.
- **EEVEE toon**: a capsule body and sphere head with a Shader-to-RGB + Color Ramp toon shader, Line Art outlines (it falls back to Freestyle if Line Art setup fails), and a bounce/sway animation.

Each scene is 1080x1920 (9:16), 24 fps, 48 frames, saved as PNG and timed per frame. Everything is built from Python, so no .blend files are needed. Blender **5.2.4** is pinned, and its sha256 is checked against download.blender.org. To use another version, set `BLENDER_VERSION=5.3.0`.

## Steps (RunPod / Vast / Lambda)

1. Rent the cheapest instance that has an **RTX 4090, L4, A10 or A4000** and an Ubuntu 22.04/24.04 image (for example `runpod/pytorch` or `nvidia/cuda:12.x-runtime-ubuntu22.04`). About 20 GB of disk is enough. The full run takes about 5–15 minutes, which costs a few cents.
2. **Important:** set the environment variable `NVIDIA_DRIVER_CAPABILITIES=all` when you create the instance.
   - RunPod: Edit Template / Pod → Environment Variables.
   - Vast: add `-e NVIDIA_DRIVER_CAPABILITIES=all` to the Docker options.

   Without it, most containers get only the CUDA libraries and no OpenGL/EGL/Vulkan, so EEVEE can't use the GPU.
3. Copy this folder up (scp, or the web terminal's upload) and run it:
   ```bash
   cd render-test
   FRAMES=4 bash run_on_gpu.sh     # optional 1-minute smoke test
   bash run_on_gpu.sh              # full 48-frame test
   ```
   Add `RUN_ALL=1` to try all three render modes even after one passes. It gives useful comparison timings.
4. When it finishes, **stop or terminate the instance**.

The script installs a minimal set of apt libraries, prints `nvidia-smi`, downloads and verifies Blender, and then tries these modes in order:

| mode | command | meaning |
|---|---|---|
| `plain`  | `blender -b` with DISPLAY unset | true headless (EGL), default OpenGL backend |
| `vulkan` | `blender -b --gpu-backend vulkan` | true headless, Vulkan backend |
| `xvfb`   | `xvfb-run blender -b` | virtual X server. Usually **Mesa CPU rendering, not the GPU** |

It stops at the first mode that passes *on the NVIDIA GPU*. It makes an mp4 for each scene with ffmpeg and writes two tarballs.

## What to send back

Send `render-results-<host>-<time>-sendback.tar.gz`. It's small and contains:
- `summary.txt`, `system.txt`, `nvidia-smi.txt`, `nvidia-libs.txt`
- for each attempt: `report.json`, `blender.log`, `gp.mp4`, `eevee.mp4`, and frames 1 and 24 of each scene

If you can't transfer files, paste `summary.txt` and one `report.json`.

## Reading pass/fail

`summary.txt` has one line per attempt:

```
attempt=plain exit=0 wall=212s verdict=PASS_GPU "renderer": "NVIDIA GeForce RTX 4090/PCIe/SSE2",
WORKING MODES: plain
```

- **PASS_GPU**: both scenes rendered, the frames aren't blank, and Blender reported an NVIDIA renderer. This is the result we want.
- **PASS_NOT_NVIDIA**: the frames rendered, but on something else, usually `llvmpipe` (CPU) under xvfb. It works but it's slow, and it isn't a GPU result.
- **FAIL**: check `blender.log` (its last 40 lines are printed) and `report.json` → `scenes.<name>.error` / `traceback` / `fatal`.

Useful fields in `report.json`:
- `blender.version_string`
- `gpu.after_first_render.renderer` / `.vendor` / `.backend` / `.device_type`: the GPU Blender actually used
- `scenes.gp.total_s`, `scenes.gp.per_frame_s[]`, `scenes.gp.mean_frame_s_excl_first` (the first frame includes shader compilation), and the same fields for `scenes.eevee`
- `scenes.eevee.setup.outline.method`: `lineart`, or `freestyle` if it fell back (`lineart_error` then says why)
- `first_frame_stats.looks_blank`: if this is true, the render produced a single flat colour
- `report.json` is rewritten after every frame. If Blender crashes (for example, it can't create a GPU context), `frames_done` and the `gpu` section show how far it got.

Common failures:
- `libEGL_nvidia.so not found` in the summary means `NVIDIA_DRIVER_CAPABILITIES=all` wasn't set. Recreate the instance with it.
- `Unable to open a display` or `Failed to create GPU context` in `plain` means headless EGL isn't usable. Check whether `vulkan` or `xvfb` worked.

You can run the script alone with any Blender:
`blender -b --factory-startup --python scene_test.py -- --out out --frames 4`
(options: `--scenes gp,eevee`, `--samples 16`, `--percent 50`, `--outline lineart|freestyle|none`).
