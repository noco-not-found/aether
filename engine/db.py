"""SQLite layer: WAL mode, per-thread connections, explicit transactions."""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager

SCHEMA_VERSION = 3

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
  id             INTEGER PRIMARY KEY,
  url_canonical  TEXT NOT NULL UNIQUE,
  original_url   TEXT NOT NULL,
  source         TEXT NOT NULL,              -- youtube, x, instagram, pinterest, tumblr, wikipedia, web
  type           TEXT NOT NULL,              -- video, post, image, article, page
  author         TEXT,
  title          TEXT,
  text           TEXT,
  note           TEXT,
  embed_provider TEXT,
  embed_id       TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  embed_stale    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_source  ON items(source);

CREATE TABLE IF NOT EXISTS assets (
  id        INTEGER PRIMARY KEY,
  item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL DEFAULT 'image',   -- image, screenshot
  path      TEXT NOT NULL,                   -- relative to storage/originals
  thumb     TEXT NOT NULL,                   -- file name in storage/thumbs
  w INTEGER, h INTEGER,                      -- original size
  tw INTEGER, th INTEGER,                    -- thumbnail size (drives grid layout)
  color     TEXT,                            -- average colour, used as placeholder
  sha256    TEXT NOT NULL,
  phash     TEXT,
  src_url   TEXT,
  ocr_text  TEXT,
  position  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(item_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_assets_item ON assets(item_id, position);
CREATE INDEX IF NOT EXISTS idx_assets_sha  ON assets(sha256);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS item_tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  origin  TEXT NOT NULL DEFAULT 'manual',    -- manual | auto | suggested | accepted
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  type        TEXT NOT NULL,
  item_id     INTEGER REFERENCES items(id)  ON DELETE CASCADE,
  asset_id    INTEGER REFERENCES assets(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed | skipped
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  run_after   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(type, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS embeddings (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,                     -- image | text
  model   TEXT NOT NULL,                     -- model name + variant
  dim     INTEGER NOT NULL,
  vector  BLOB NOT NULL,                     -- float32, L2-normalised
  src_hash TEXT,                             -- hash of what was embedded: unchanged input is never re-embedded
  PRIMARY KEY (item_id, kind)
);

-- Latest clustering run (replaced as a whole by every run).
CREATE TABLE IF NOT EXISTS clusters (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',       -- JSON list of the terms behind the name
  size     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS item_clusters (
  item_id    INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  cluster_id INTEGER REFERENCES clusters(id) ON DELETE CASCADE,   -- NULL: fits no cluster
  x REAL, y REAL                             -- 2-D position for a map view
);
CREATE INDEX IF NOT EXISTS idx_item_clusters_c ON item_clusters(cluster_id);
-- Links you draw by hand in the graph: one-way arrows, src -> dst.
CREATE TABLE IF NOT EXISTS links (
  src        INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  dst        INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src, dst),
  CHECK (src <> dst)
);
CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, text, ocr, tags, author,
  tokenize = 'porter unicode61'
);
"""


class DB:
    """One SQLite connection per thread; writes go through tx()."""

    def __init__(self, path) -> None:
        self.path = str(path)
        self._local = threading.local()

    def conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "c", None)
        if c is None:
            c = sqlite3.connect(self.path, isolation_level=None, timeout=30)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
            c.execute("PRAGMA foreign_keys=ON")
            c.execute("PRAGMA busy_timeout=30000")
            self._local.c = c
        return c

    @contextmanager
    def tx(self):
        c = self.conn()
        c.execute("BEGIN IMMEDIATE")
        try:
            yield c
        except BaseException:
            c.execute("ROLLBACK")
            raise
        else:
            c.execute("COMMIT")

    def init(self) -> None:
        c = self.conn()
        c.executescript(SCHEMA)
        # v1 -> v2: columns added to tables that already exist in users' databases
        def has(table: str, col: str) -> bool:
            return any(r[1] == col for r in c.execute(f"PRAGMA table_info({table})"))
        if not has("items", "embed_stale"):
            # a counter, not a flag: bumped on every change, and only reset if it still has the value
            # the embedder saw, so an edit made while embedding is never lost. Existing rows start dirty.
            c.execute("ALTER TABLE items ADD COLUMN embed_stale INTEGER NOT NULL DEFAULT 1")
        if not has("embeddings", "src_hash"):
            c.execute("ALTER TABLE embeddings ADD COLUMN src_hash TEXT")
        c.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
