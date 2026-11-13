"""hermes-tts: original voices (Qwen3-TTS, Apache-2.0) + timing (faster-whisper, MIT).

We never clone real people. Voices are *designed* from a text description (VoiceDesign model);
the approved design clip then becomes the reference for consistent lines (Base model clone prompt).

Tasks
- voice_design: params {instruct, text, language?, n?}; outputs audio_0..audio_{n-1} (WAV)
- voice_lines:  inputs {ref_audio}; params {ref_text, lines: [{text, language?}]}; outputs line_0.. (WAV)
                meta per line: {duration_s, words: [{w, start, end}]} for lip sync / timing / QA
"""

from __future__ import annotations

import io
import os
from typing import Any

from hermes_worker.server import MOCK, Ctx
from hermes_worker import mock

DESIGN_MODEL = os.environ.get("TTS_DESIGN_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")
BASE_MODEL = os.environ.get("TTS_BASE_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
ASR_MODEL = os.environ.get("ASR_MODEL", "large-v3-turbo")

_design = _base = _asr = None


def warmup() -> None:
    _get_design()
    _get_base()
    _get_asr()


def _load(name: str):
    import torch
    from qwen_tts import Qwen3TTSModel

    return Qwen3TTSModel.from_pretrained(name, device_map="cuda:0", dtype=torch.bfloat16)


def _get_design():
    global _design
    _design = _design or _load(DESIGN_MODEL)
    return _design


def _get_base():
    global _base
    _base = _base or _load(BASE_MODEL)
    return _base


def _get_asr():
    global _asr
    if _asr is None:
        from faster_whisper import WhisperModel

        _asr = WhisperModel(ASR_MODEL, device="cuda", compute_type="float16")
    return _asr


def _wav(samples, sr: int) -> bytes:
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, samples, sr, format="WAV")
    return buf.getvalue()


def _words(wav_bytes: bytes) -> tuple[list[dict[str, Any]], str]:
    segments, _ = _get_asr().transcribe(io.BytesIO(wav_bytes), word_timestamps=True, language="en")
    words, text = [], []
    for seg in segments:
        text.append(seg.text)
        for w in seg.words or []:
            words.append({"w": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
    return words, " ".join(t.strip() for t in text)


def voice_design(ctx: Ctx) -> dict[str, Any]:
    p = ctx.params
    n = int(p.get("n", 3))
    if MOCK:
        for i in range(n):
            ctx.write(f"audio_{i}", mock.wav(1.5, 180 + 40 * i), {"duration_s": 1.5, "mock": True})
        return {"takes": n}
    model = _get_design()
    lang = p.get("language", "English")
    # Batch n takes of the same description; sampling gives n distinct candidate voices.
    wavs, sr = model.generate_voice_design(text=[p["text"]] * n, language=[lang] * n, instruct=[p["instruct"]] * n)
    for i, samples in enumerate(wavs):
        data = _wav(samples, sr)
        ctx.write(f"audio_{i}", data, {"duration_s": round(len(samples) / sr, 3), "sample_rate": sr})
    return {"takes": n}


def voice_lines(ctx: Ctx) -> dict[str, Any]:
    p = ctx.params
    lines = p["lines"]
    if MOCK:
        for i, line in enumerate(lines):
            dur = max(0.6, len(line["text"].split()) / 2.6)
            ctx.write(f"line_{i}", mock.wav(dur), {"duration_s": round(dur, 3), "words": [], "mock": True})
        return {"lines": len(lines)}
    import numpy as np
    import soundfile as sf

    ref, ref_sr = sf.read(io.BytesIO(ctx.input_bytes("ref_audio")))
    model = _get_base()
    prompt = model.create_voice_clone_prompt(ref_audio=(np.asarray(ref), ref_sr), ref_text=p["ref_text"])
    wavs, sr = model.generate_voice_clone(
        text=[l["text"] for l in lines],
        language=[l.get("language", "English") for l in lines],
        voice_clone_prompt=prompt,
    )
    for i, samples in enumerate(wavs):
        data = _wav(samples, sr)
        words, heard = _words(data)
        ctx.write(
            f"line_{i}",
            data,
            {"duration_s": round(len(samples) / sr, 3), "sample_rate": sr, "words": words, "heard": heard},
        )
    return {"lines": len(lines)}


def voice_lines_multi(ctx: Ctx) -> dict[str, Any]:
    """All lines of a sketch in one job, each in its character's approved voice.

    params: {voices: {voice_id: {ref: <input name>, ref_text}}, lines: [{id, voice, text, language?}]}
    outputs: line_<id> (WAV); meta {duration_s, words, heard} for timing, lip sync and QA.
    """
    p = ctx.params
    lines = p["lines"]
    if MOCK:
        for l in lines:
            dur = max(0.6, len(l["text"].split()) / 2.6)
            ctx.write(f"line_{l['id']}", mock.wav(dur), {"duration_s": round(dur, 3), "words": [], "mock": True})
        return {"lines": len(lines)}
    import numpy as np
    import soundfile as sf

    model = _get_base()
    prompts = {}
    for vid, v in p["voices"].items():
        ref, ref_sr = sf.read(io.BytesIO(ctx.input_bytes(v["ref"])))
        prompts[vid] = model.create_voice_clone_prompt(ref_audio=(np.asarray(ref), ref_sr), ref_text=v["ref_text"])
    for vid in prompts:
        mine = [l for l in lines if l["voice"] == vid]
        if not mine:
            continue
        wavs, sr = model.generate_voice_clone(
            text=[l["text"] for l in mine],
            language=[l.get("language", "English") for l in mine],
            voice_clone_prompt=prompts[vid],
        )
        for l, samples in zip(mine, wavs):
            data = _wav(samples, sr)
            words, heard = _words(data)
            ctx.write(
                f"line_{l['id']}",
                data,
                {"duration_s": round(len(samples) / sr, 3), "sample_rate": sr, "words": words, "heard": heard},
            )
    return {"lines": len(lines), "voices": len(prompts)}


TASKS = {"voice_design": voice_design, "voice_lines": voice_lines, "voice_lines_multi": voice_lines_multi}
