/**
 * Open AgentDB's native SQLite handle with this package's better-sqlite3.
 *
 * agentdb 3.0.0-alpha.x declares `better-sqlite3: ^11.8.1`, so npm gives it a
 * nested 11.x copy next to our 12.x one. better-sqlite3 11.x ships no prebuilt
 * binary for Node 24 (ABI 137), so on Node 24 that copy is compiled from
 * source against the local headers. Node 24.19+ headers carry a partial
 * backport of `node::ObjectWrap` cleanup hooks (nodejs/node#65446): a
 * Statement collected by an allocation-driven GC calls
 * RemoveEnvironmentCleanupHook() with no Environment and the process aborts
 * with `Assertion failed: (env) != nullptr` — exit 134 for the CLI, "Connection
 * closed" for the MCP server.
 *
 * The 12.x copy we depend on ships a Node 24 prebuild, so routing AgentDB's
 * handle through it keeps the source-built 11.x addon out of the process.
 * `overrides` cannot do this: npm ignores them in a dependency's package.json,
 * which is where ours sit for anyone installing ruflo.
 */

type AgentDBLike = {
  config?: { forceWasm?: boolean };
  usingWasm?: boolean;
  initializeDatabase?: (dbPath: string) => Promise<unknown>;
};

/**
 * Replace `agentdb.initializeDatabase` so `initialize()` opens the database
 * with our better-sqlite3. Must be called before `agentdb.initialize()`.
 * Falls back to AgentDB's own loader when ours cannot open the file, and
 * leaves `forceWasm` instances alone.
 */
export function useHostSqliteDriver(agentdb: AgentDBLike | null | undefined): void {
  if (!agentdb || typeof agentdb.initializeDatabase !== 'function') return;
  if (agentdb.config?.forceWasm) return;

  const agentdbLoader = agentdb.initializeDatabase.bind(agentdb);
  agentdb.initializeDatabase = async (dbPath: string) => {
    let db: { pragma(sql: string): unknown };
    try {
      const Database = (await import('better-sqlite3')).default;
      db = new Database(dbPath);
    } catch {
      return agentdbLoader(dbPath);
    }
    // Same setup as AgentDB.initializeDatabase()'s native branch.
    db.pragma('journal_mode = WAL');
    agentdb.usingWasm = false;
    return db;
  };
}
