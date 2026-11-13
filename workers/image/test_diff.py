"""CPU test for the overlay extractor: a synthetic 'edit' that changes only a face region must be extracted
as one overlay at the right offset, while small global noise (edit-model drift) is ignored."""

import numpy as np
from PIL import Image

from handler import _diff_overlay

rng = np.random.default_rng(0)
base = np.full((400, 300, 3), 200, np.uint8)
base[100:350, 80:220] = (120, 90, 60)  # the figure
edit = base.copy().astype(np.int16)
edit += rng.integers(-4, 5, edit.shape)  # global drift, below threshold
edit[130:170, 120:180] = (30, 30, 30)  # the intended change (a "mouth")
edit = np.clip(edit, 0, 255).astype(np.uint8)

alpha = np.zeros((400, 300), np.uint8)
alpha[100:350, 80:220] = 255

sprite, box, ratio = _diff_overlay(Image.fromarray(base), Image.fromarray(edit), Image.fromarray(alpha))
assert sprite is not None and box is not None
assert 100 <= box["x"] <= 120 and 110 <= box["y"] <= 130, box  # padded around (120,130)
assert box["x"] + box["w"] <= 200 and box["y"] + box["h"] <= 190, box
assert 0.02 < ratio < 0.2, ratio
print("diff overlay ok", box, ratio)
