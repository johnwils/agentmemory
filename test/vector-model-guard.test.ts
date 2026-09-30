import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteState } from "../src/engine/inproc/state.js";
import { SqliteVectorStore } from "../src/engine/inproc/vectors.js";
import { VectorIndex } from "../src/state/vector-index.js";

const v = (...xs: number[]) => new Float32Array(xs);

describe("vector store model identity", () => {
  let dir: string;
  let path: string;
  let state: SqliteState;
  let store: SqliteVectorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "am-vmodel-"));
    path = join(dir, "agentmemory.sqlite");
    state = new SqliteState(path);
    store = new SqliteVectorStore(state);
  });
  afterEach(() => {
    try {
      state.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(n: number): void {
    const index = new VectorIndex();
    index.attachStore(store);
    for (let i = 0; i < n; i++) index.add(`obs_${i}`, "s1", v(i, 1, 0, 0), "h");
  }

  it("tags an empty store with the active model", () => {
    expect(store.model()).toBeNull();
    expect(store.reconcileModel("voyage:voyage-code-4", "voyage:voyage-code-3", false)).toMatchObject({ action: "tagged" });
    expect(store.model()).toBe("voyage:voyage-code-4");
    expect(store.reconcileModel("voyage:voyage-code-4", "voyage:voyage-code-3", false)).toMatchObject({ action: "match" });
  });

  it("retags an empty store whose tag names another model: there is nothing to mix", () => {
    store.setModel("voyage:voyage-code-3");
    expect(store.reconcileModel("voyage:voyage-code-4", null, false)).toMatchObject({ action: "tagged" });
    expect(store.model()).toBe("voyage:voyage-code-4");
  });

  it("refuses a store tagged with another model and leaves every row in place", () => {
    seed(3);
    store.setModel("voyage:voyage-code-3");
    expect(store.reconcileModel("voyage:voyage-code-4", null, false)).toEqual({
      action: "refuse",
      active: "voyage:voyage-code-4",
      stored: "voyage:voyage-code-3",
      rows: 3,
    });
    expect(store.count()).toBe(3);
    expect(store.model()).toBe("voyage:voyage-code-3");
  });

  it("with dropStale deletes another model's rows and tags the store active", () => {
    seed(3);
    store.setModel("voyage:voyage-code-3");
    expect(store.reconcileModel("voyage:voyage-code-4", null, true)).toMatchObject({ action: "dropped", rows: 3 });
    expect(store.count()).toBe(0);
    expect(store.model()).toBe("voyage:voyage-code-4");
  });

  it("an untagged Voyage store is voyage-code-3: adopted under code-3, refused under code-4", () => {
    seed(2);
    expect(store.reconcileModel("voyage:voyage-code-4", "voyage:voyage-code-3", false)).toMatchObject({
      action: "refuse",
      stored: "voyage:voyage-code-3",
    });
    expect(store.model()).toBeNull();
    expect(store.reconcileModel("voyage:voyage-code-3", "voyage:voyage-code-3", false)).toMatchObject({ action: "adopted", rows: 2 });
    expect(store.model()).toBe("voyage:voyage-code-3");
  });

  it("an untagged store of a provider with no known legacy model is taken to match", () => {
    seed(1);
    expect(store.reconcileModel("openai:text-embedding-3-small", null, false)).toMatchObject({ action: "adopted" });
    expect(store.model()).toBe("openai:text-embedding-3-small");
  });

  it("the tag survives a close and reopen", () => {
    store.setModel("voyage:voyage-code-4");
    state.close();
    state = new SqliteState(path);
    store = new SqliteVectorStore(state);
    expect(store.model()).toBe("voyage:voyage-code-4");
  });
});
