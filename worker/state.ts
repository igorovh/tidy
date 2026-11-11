import { DurableObject } from "cloudflare:workers";

// One SQLite-backed object holds all state, so one-time and counter checks are atomic.
export class TidyState extends DurableObject<object> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)");
  }

  private live(k: string): string | null {
    const row = this.sql.exec<{ v: string; exp: number | null }>("SELECT v, exp FROM kv WHERE k = ?", k).toArray()[0];
    if (!row) return null;
    if (row.exp !== null && row.exp < Date.now()) {
      this.sql.exec("DELETE FROM kv WHERE k = ?", k);
      return null;
    }
    return row.v;
  }

  get(k: string): string | null {
    return this.live(k);
  }

  put(k: string, v: string, ttlMs?: number): void {
    this.sql.exec("INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)", k, v, ttlMs ? Date.now() + ttlMs : null);
    if (Math.random() < 0.05) this.sql.exec("DELETE FROM kv WHERE exp IS NOT NULL AND exp < ?", Date.now());
  }

  delete(k: string): void {
    this.sql.exec("DELETE FROM kv WHERE k = ?", k);
  }

  /** Stores the value only if the key is free; returns the value that is stored afterwards. */
  claim(k: string, v: string, ttlMs: number): string {
    const existing = this.live(k);
    if (existing !== null) return existing;
    this.put(k, v, ttlMs);
    return v;
  }

  /** Increments a counter unless it already reached `limit`; returns whether it was incremented. */
  take(k: string, limit: number, ttlMs: number): boolean {
    const count = Number(this.live(k) ?? 0);
    if (count >= limit) return false;
    const exp = this.sql.exec<{ exp: number | null }>("SELECT exp FROM kv WHERE k = ?", k).toArray()[0]?.exp;
    this.sql.exec("INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)", k, String(count + 1), exp ?? Date.now() + ttlMs);
    return true;
  }
}
