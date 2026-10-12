// Scenario store backed by one JSON file.
//
// Fine for a pilot with a handful of users. The interface (list/get/create/
// update) is what the server depends on, so swapping in Postgres later means
// rewriting this file only. On Fly/Render the DATA_DIR must be a mounted
// volume, otherwise saved scenarios disappear on redeploy.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function createStore(dataDir, fileName = "scenarios.json", seed = null) {
  const file = join(dataDir, fileName);
  let cache = null;
  let writing = Promise.resolve();

  async function load() {
    if (cache) return cache;
    if (!existsSync(file)) {
      cache = { version: 1, scenarios: [] };
      if (seed) {
        const now = new Date().toISOString();
        cache.scenarios = seed().map((data) => ({
          id: randomUUID(), createdAt: now, updatedAt: now, createdBy: "setup", status: "active",
          activity: [{ at: now, by: "setup", action: "created", detail: "Sample product" }], ...data,
        }));
        await persist();
      }
      return cache;
    }
    cache = JSON.parse(await readFile(file, "utf8"));
    return cache;
  }

  // Serialise writes and replace the file atomically (write temp, rename).
  function persist() {
    writing = writing.then(async () => {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(cache, null, 2));
      await rename(tmp, file);
    });
    return writing;
  }

  const clone = (v) => JSON.parse(JSON.stringify(v));

  return {
    async list() {
      const db = await load();
      return clone(db.scenarios.filter((s) => s.status !== "archived"));
    },
    async get(id) {
      const db = await load();
      const found = db.scenarios.find((s) => s.id === id);
      return found ? clone(found) : null;
    },
    async create(data, user) {
      const db = await load();
      const now = new Date().toISOString();
      const scenario = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        createdBy: user,
        status: "draft",
        activity: [],
        ...data,
      };
      scenario.activity = [{ at: now, by: user, action: "created", detail: data.createdFrom ? `Duplicated from ${data.createdFrom}` : "" }, ...(data.activity || [])];
      db.scenarios.push(scenario);
      await persist();
      return clone(scenario);
    },
    async update(id, mutate, user, action, detail = "", extra = {}) {
      const db = await load();
      const scenario = db.scenarios.find((s) => s.id === id);
      if (!scenario) return null;
      mutate(scenario);
      const now = new Date().toISOString();
      scenario.updatedAt = now;
      scenario.activity.push({ at: now, by: user, action, detail, ...extra });
      await persist();
      return clone(scenario);
    },
  };
}
