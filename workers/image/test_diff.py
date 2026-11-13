"""CPU tests for overlay extraction (run inside the hermes-image container)."""

import numpy as np
from PIL import Image

from handler import _diff_overlay, _region_overlay

rng = np.random.default_rng(0)
base = np.full((400, 300, 3), 200, np.uint8)
base[100:350, 80:220] = (120, 90, 60)  # the figure

# 1) pixel-diff fallback: a local change is extracted at the right offset; small global noise is ignored
edit = base.copy().astype(np.int16)
edit += rng.integers(-4, 5, edit.shape)
edit[130:170, 120:180] = (30, 30, 30)
edit = np.clip(edit, 0, 255).astype(np.uint8)
alpha = np.zeros((400, 300), np.uint8)
alpha[100:350, 80:220] = 255
sprite, box, ratio = _diff_overlay(Image.fromarray(base), Image.fromarray(edit), Image.fromarray(alpha))
assert sprite is not None and box is not None
assert 100 <= box["x"] <= 120 and 110 <= box["y"] <= 130, box
assert 0.02 < ratio < 0.2, ratio
print("diff overlay ok", box, ratio)

# 2) region overlay: the edit model shifted the whole frame by (6, 4) px and changed the "face";
#    alignment must recover the shift so the pasted head has no seam, and the change must land in the comp.
textured = base.copy()
textured[100:350, 80:220] = rng.integers(60, 180, (250, 140, 3))  # textured figure so alignment has signal
face = (110, 120, 80, 70)  # x, y, w, h
moved = np.roll(np.roll(textured, 4, axis=0), 6, axis=1).copy()
moved[124 + 10 : 124 + 60, 126 + 10 : 126 + 70] = (20, 200, 20)  # changed face, in the shifted frame
sprite, comp, shift = _region_overlay(
    Image.fromarray(textured), Image.fromarray(moved), {"x": face[0], "y": face[1], "w": face[2], "h": face[3]}
)
assert shift == {"dx": 6, "dy": 4}, shift
c = np.asarray(comp)
assert (c[150, 150] == (20, 200, 20)).all(), c[150, 150]  # change visible at the right place in the composite
assert (c[90, 150] == textured[90, 150]).all()  # outside the region the base is untouched
assert sprite.size == (face[2], face[3]) and sprite.mode == "RGBA"
print("region overlay ok", shift)
