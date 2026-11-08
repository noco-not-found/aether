"""Turn items into vectors: CLIP for pictures (and for text queries about pictures), bge-small for text.

The embedder is a small interface (has_image / has_text / ids / image_vectors / clip_text_vectors /
text_vectors) so tests can swap in a fake one and never need the model files.
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

import numpy as np
from PIL import Image

from . import models as M
from .config import Paths

log = logging.getLogger("aether.embed")

CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
CLIP_PAD = 49407                    # <|endoftext|>; also what marks the end of a prompt
BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
THREADS = max(2, (os.cpu_count() or 4) // 2)   # leave cores free so the UI stays smooth


def unit(a: np.ndarray) -> np.ndarray:
    a = np.asarray(a, dtype=np.float32)
    return a / np.maximum(np.linalg.norm(a, axis=-1, keepdims=True), 1e-9)


class OnnxEmbedder:
    def __init__(self, paths: Paths) -> None:
        self.paths = paths
        self._lock = threading.Lock()
        self._sessions: dict[str, object] = {}
        self._tok: dict[str, object] = {}

    # ---- what is available
    def has_image(self) -> bool:
        return M.present(self.paths, "clip")

    def has_text(self) -> bool:
        return M.present(self.paths, "bge")

    def ids(self) -> dict[str, str]:
        return {"image": M.model_id(self.paths, "clip"), "text": M.model_id(self.paths, "bge")}

    def providers(self) -> list[str]:
        import onnxruntime as ort
        return ort.get_available_providers()

    def unload(self) -> None:
        """Drop the ONNX sessions (~1 GB of RAM); they load again on next use."""
        with self._lock:
            self._sessions.clear()

    # ---- sessions / tokenisers (loaded on first use, then kept)
    def _session(self, name: str, model: str, file: str):
        key = f"{name}/{file}"
        with self._lock:
            s = self._sessions.get(key)
            if s is None:
                import onnxruntime as ort
                so = ort.SessionOptions()
                so.intra_op_num_threads = THREADS
                so.log_severity_level = 3
                avail = ort.get_available_providers()
                prov = [p for p in ("CUDAExecutionProvider", "DmlExecutionProvider") if p in avail] + ["CPUExecutionProvider"]
                s = ort.InferenceSession(str(M.model_dir(self.paths, model) / file), so, providers=prov)
                self._sessions[key] = s
                log.info("loaded %s (%s)", key, s.get_providers()[0])
            return s

    def _tokenizer(self, model: str, *, max_len: int, pad_id: int | None):
        key = f"{model}/{max_len}"
        with self._lock:
            t = self._tok.get(key)
            if t is None:
                from tokenizers import Tokenizer
                t = Tokenizer.from_file(str(M.model_dir(self.paths, model) / "tokenizer.json"))
                t.enable_truncation(max_length=max_len)
                if pad_id is not None:
                    t.enable_padding(length=max_len, pad_id=pad_id, pad_token="<pad>")
                else:
                    t.enable_padding()          # to the longest in the batch
                self._tok[key] = t
            return t

    @staticmethod
    def _feed(sess, arrays: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
        return {i.name: arrays[i.name] for i in sess.get_inputs() if i.name in arrays}

    @staticmethod
    def _pick(sess, outs, names: tuple[str, ...]) -> np.ndarray:
        by = {o.name: v for o, v in zip(sess.get_outputs(), outs)}
        for n in names:
            if n in by:
                return by[n]
        return outs[0]

    # ---- CLIP
    @staticmethod
    def _prep(path: Path) -> np.ndarray:
        im = Image.open(path)
        im.draft("RGB", (448, 448))      # JPEGs decode at reduced size: much faster
        im = im.convert("RGB")
        w, h = im.size
        s = 224 / min(w, h)
        im = im.resize((max(224, round(w * s)), max(224, round(h * s))), Image.BICUBIC)
        w, h = im.size
        l, t = (w - 224) // 2, (h - 224) // 2
        im = im.crop((l, t, l + 224, t + 224))
        a = (np.asarray(im, dtype=np.float32) / 255.0 - CLIP_MEAN) / CLIP_STD
        return a.transpose(2, 0, 1)

    def image_vectors(self, files: list[Path]) -> np.ndarray:
        sess = self._session("clip", "clip", "vision.onnx")
        out = []
        for i in range(0, len(files), 8):
            batch = np.stack([self._prep(f) for f in files[i:i + 8]]).astype(np.float32)
            res = sess.run(None, self._feed(sess, {"pixel_values": batch}))
            out.append(self._pick(sess, res, ("image_embeds",)))
        return unit(np.concatenate(out))

    def clip_text_vectors(self, texts: list[str]) -> np.ndarray:
        sess = self._session("clip", "clip", "text.onnx")
        tok = self._tokenizer("clip", max_len=77, pad_id=CLIP_PAD)
        out = []
        for i in range(0, len(texts), 32):          # 77 tokens x 170 prompts in one go can exhaust memory
            enc = tok.encode_batch([t or " " for t in texts[i:i + 32]])
            ids = np.array([e.ids for e in enc], dtype=np.int64)
            mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
            res = sess.run(None, self._feed(sess, {"input_ids": ids, "attention_mask": mask}))
            out.append(self._pick(sess, res, ("text_embeds",)))
        return unit(np.concatenate(out))

    # ---- bge-small
    def text_vectors(self, texts: list[str], *, query: bool = False) -> np.ndarray:
        sess = self._session("bge", "bge", "model.onnx")
        tok = self._tokenizer("bge", max_len=512, pad_id=None)
        out = []
        for i in range(0, len(texts), 16):
            batch = [(BGE_QUERY_PREFIX + t) if query else t for t in texts[i:i + 16]]
            enc = tok.encode_batch(batch)
            ids = np.array([e.ids for e in enc], dtype=np.int64)
            mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
            res = sess.run(None, self._feed(sess, {"input_ids": ids, "attention_mask": mask,
                                                   "token_type_ids": np.zeros_like(ids)}))
            hidden = self._pick(sess, res, ("last_hidden_state",))
            out.append(hidden[:, 0, :])          # CLS pooling, as the model was trained
        return unit(np.concatenate(out))
