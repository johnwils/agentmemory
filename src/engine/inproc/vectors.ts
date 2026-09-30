// Durable vector rows behind the in-heap `VectorIndex`, in the same SQLite
// file as the state store so a content row and its vectors can change in one
// transaction. Replaces the iii-era giant-string index persistence: the map is
// the search structure, the table is its source of truth at boot.
//
//   - `put`/`remove`/`clear` are the `VectorStore` hooks `VectorIndex` calls
//     before it touches its map; the map update is queued on `afterCommit`.
//   - `commitEmbedding` is the ONE path every embedding completion takes:
//     inside a transaction it re-reads the current content row, derives the
//     text that row would be embedded with today, and writes the vector only
//     if that is the text this embedding was computed for. A completion for
//     rewritten or deleted content is dropped as stale.
//   - `hydrate` streams the rows in `seq` order into an empty index.
//   - `vector_meta.model` names the embedding model every row was computed
//     with (`provider:model`). `reconcileModel` holds the table to the active
//     model at boot, so vectors of two models are never served together.
import type { SqliteState } from "./state.js";
import type { VectorIndex, VectorRow, VectorStore } from "../../state/vector-index.js";
import { KV } from "../../state/schema.js";
import {
  clipEmbedInput,
  contentLocation,
  embedInputHash,
  embedJobsFor,
  type EmbedJob,
} from "../../state/index-corpus.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vectors (
  seq        INTEGER PRIMARY KEY,
  id         TEXT    NOT NULL UNIQUE,
  session_id TEXT    NOT NULL,
  dims       INTEGER NOT NULL,
  embedding  BLOB    NOT NULL CHECK (length(embedding) = dims * 4),
  input_hash TEXT    NOT NULL,
  hash_state TEXT    NOT NULL CHECK (hash_state IN ('verified', 'legacy'))
);
CREATE TABLE IF NOT EXISTS vector_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export type ModelReconcile =
  // The table is (now) tagged with the active model and may be served.
  | { action: "match" | "tagged" | "adopted"; active: string; rows: number }
  // The table held another model's vectors: deleted, then tagged active.
  | { action: "dropped"; active: string; stored: string; rows: number }
  // The table holds another model's vectors and dropping was not allowed.
  | { action: "refuse"; active: string; stored: string; rows: number };

export type StoredVector = {
  id: string;
  sessionId: string;
  dims: number;
  embedding: Float32Array;
  inputHash: string;
  hashState: "verified" | "legacy";
};

// `id >= 'X#' AND id < 'X$'` is the half-open range of every `X#...` id under
// BINARY collation ('$' is the code point after '#'), so the UNIQUE index
// serves it and no id character needs escaping.
const CHUNK_LO = "#";
const CHUNK_HI = "$";

const OBS_SCOPE_PREFIX = KV.observations("");

export class SqliteVectorStore implements VectorStore {
  constructor(readonly state: SqliteState) {
    state.db.exec(SCHEMA);
    // A `legacy` row (imported, no input text to hash) is trusted until its
    // content is rewritten. Flip it to `verified` with an empty hash inside
    // the rewrite's own transaction so the fill pass sees a stale row and
    // re-embeds; a crash right after the rewrite cannot leave it trusted.
    const invalidate = state.db.prepare(
      `UPDATE vectors SET hash_state = 'verified', input_hash = ''
       WHERE hash_state = 'legacy' AND (id = ? OR (id >= ? AND id < ?))`,
    );
    state.onWrite((scope, key) => {
      if (scope === KV.memories || scope.startsWith(OBS_SCOPE_PREFIX)) {
        invalidate.run(key, key + CHUNK_LO, key + CHUNK_HI);
      }
    });
  }

  put(row: VectorRow): void {
    const blob = Buffer.from(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength,
    );
    if (blob.byteLength !== row.embedding.length * 4) {
      throw new Error(`vector ${row.id}: byteLength ${blob.byteLength} != dims*4`);
    }
    this.state.transaction(() => {
      if (!row.id.includes("#")) {
        this.state.db
          .prepare("DELETE FROM vectors WHERE id >= ? AND id < ?")
          .run(row.id + CHUNK_LO, row.id + CHUNK_HI);
      }
      this.state.db
        .prepare(
          `INSERT INTO vectors (id, session_id, dims, embedding, input_hash, hash_state)
           VALUES (?, ?, ?, ?, ?, 'verified')
           ON CONFLICT(id) DO UPDATE SET
             session_id = excluded.session_id, dims = excluded.dims,
             embedding = excluded.embedding, input_hash = excluded.input_hash,
             hash_state = excluded.hash_state`,
        )
        .run(row.id, row.sessionId, row.embedding.length, blob, row.inputHash);
    });
  }

  remove(id: string, exact = false): void {
    if (exact) {
      this.state.db.prepare("DELETE FROM vectors WHERE id = ?").run(id);
      return;
    }
    this.state.db
      .prepare("DELETE FROM vectors WHERE id = ? OR (id >= ? AND id < ?)")
      .run(id, id + CHUNK_LO, id + CHUNK_HI);
  }

  clear(): void {
    this.state.db.exec("DELETE FROM vectors");
  }

  afterCommit(fn: () => void): void {
    this.state.afterCommit(fn);
  }

  model(): string | null {
    const row = this.state.db.prepare("SELECT value FROM vector_meta WHERE key = 'model'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setModel(model: string): void {
    this.state.db
      .prepare("INSERT INTO vector_meta (key, value) VALUES ('model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(model);
  }

  // Run before `hydrate`. `untagged` is the model an untagged, non-empty
  // table is taken to hold (null: the active one). An empty table is simply
  // tagged, since there is nothing to mix. With `dropStale`, another model's
  // rows are deleted so the fill pass re-embeds them; without it the caller
  // must refuse to start.
  reconcileModel(active: string, untagged: string | null, dropStale: boolean): ModelReconcile {
    const rows = this.count();
    const tag = this.model();
    if (rows === 0) {
      if (tag !== active) this.setModel(active);
      return { action: tag === active ? "match" : "tagged", active, rows };
    }
    const stored = tag ?? untagged ?? active;
    if (stored === active) {
      if (tag !== active) this.setModel(active);
      return { action: tag === active ? "match" : "adopted", active, rows };
    }
    if (!dropStale) return { action: "refuse", active, stored, rows };
    this.state.transaction(() => {
      this.clear();
      this.setModel(active);
    });
    return { action: "dropped", active, stored, rows };
  }

  count(): number {
    const row = this.state.db.prepare("SELECT count(*) AS n FROM vectors").get() as { n: number };
    return row.n;
  }

  // Every row in insertion order. Asserts the blob length on read: the CHECK
  // constraint guards the write side, so a violation here means the file was
  // altered outside the daemon and loading it would corrupt search silently.
  *rows(): IterableIterator<StoredVector> {
    const stmt = this.state.db.prepare(
      "SELECT id, session_id, dims, embedding, input_hash, hash_state FROM vectors ORDER BY seq",
    );
    for (const r of stmt.iterate() as Iterable<{
      id: string;
      session_id: string;
      dims: number;
      embedding: Uint8Array;
      input_hash: string;
      hash_state: "verified" | "legacy";
    }>) {
      if (r.embedding.byteLength !== r.dims * 4) {
        throw new Error(
          `vector ${r.id}: stored blob is ${r.embedding.byteLength} bytes, dims=${r.dims} needs ${r.dims * 4}`,
        );
      }
      // Copy into a fresh, 4-byte-aligned buffer; a Float32Array view over a
      // pooled Uint8Array with an odd byteOffset throws.
      const embedding = new Float32Array(
        r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength),
      );
      yield {
        id: r.id,
        sessionId: r.session_id,
        dims: r.dims,
        embedding,
        inputHash: r.input_hash,
        hashState: r.hash_state,
      };
    }
  }

  hydrate(index: VectorIndex): number {
    let n = 0;
    for (const row of this.rows()) {
      index.hydrate([row]);
      n++;
    }
    return n;
  }

  // The single commit path for an embedding completion. Returns false when the
  // content row no longer calls for exactly this text (deleted, superseded,
  // rewritten, excluded), in which case nothing is written and the in-memory
  // index is untouched.
  commitEmbedding(index: VectorIndex, job: EmbedJob, embedding: Float32Array): boolean {
    return this.state.transaction(() => {
      const { scope, key } = contentLocation(job.kind, job.sessionId, job.id);
      const expected = embedJobsFor(job.kind, this.state.get(scope, key)).find(
        (j) => j.id === job.id,
      );
      if (!expected || clipEmbedInput(expected.text) !== clipEmbedInput(job.text)) {
        return false;
      }
      index.add(job.id, expected.sessionId, embedding, embedInputHash(expected.text));
      return true;
    });
  }
}
