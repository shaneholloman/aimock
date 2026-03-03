import { generateId } from "./helpers.js";
import type { Fixture, JournalEntry } from "./types.js";

export class Journal {
  private entries: JournalEntry[] = [];

  add(entry: Omit<JournalEntry, "id" | "timestamp">): JournalEntry {
    const full: JournalEntry = {
      id: generateId("req"),
      timestamp: Date.now(),
      ...entry,
    };
    this.entries.push(full);
    return full;
  }

  getAll(opts?: { limit?: number }): JournalEntry[] {
    if (opts?.limit !== undefined) {
      return this.entries.slice(-opts.limit);
    }
    return this.entries.slice();
  }

  getLast(): JournalEntry | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1] : null;
  }

  findByFixture(fixture: Fixture): JournalEntry[] {
    return this.entries.filter((e) => e.response.fixture === fixture);
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}
