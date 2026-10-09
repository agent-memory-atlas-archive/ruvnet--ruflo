/**
 * Node 24 abort in agentdb's nested better-sqlite3 11.x
 * (`Assertion failed: (env) != nullptr` in Statement::~Statement).
 *
 * useHostSqliteDriver() must make AgentDB open its handle with this
 * package's better-sqlite3, so the source-built 11.x addon is never loaded.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { useHostSqliteDriver } from './agentdb-native-driver.js';

function fakeAgentDB(config: { forceWasm?: boolean } = {}) {
  const calls: string[] = [];
  const own = { own: true };
  const agentdb: {
    config: { forceWasm?: boolean };
    usingWasm: boolean;
    initializeDatabase: (dbPath: string) => Promise<any>;
  } = {
    config,
    usingWasm: true,
    async initializeDatabase(dbPath: string) {
      calls.push(dbPath);
      return own;
    },
  };
  return { agentdb, calls, own };
}

describe('useHostSqliteDriver', () => {
  it('opens the AgentDB handle with our better-sqlite3, not agentdb\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-agentdb-driver-'));
    const { agentdb, calls } = fakeAgentDB();
    try {
      useHostSqliteDriver(agentdb);
      const db = await agentdb.initializeDatabase(join(dir, 'agentdb-memory.db'));

      expect(db).toBeInstanceOf(Database);
      expect(calls).toEqual([]);
      expect(agentdb.usingWasm).toBe(false);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to AgentDB\'s own loader when ours cannot open the path', async () => {
    const { agentdb, calls, own } = fakeAgentDB();
    useHostSqliteDriver(agentdb);
    const missingDir = join(tmpdir(), 'cf-agentdb-driver-missing', 'nested', 'x.db');

    await expect(agentdb.initializeDatabase(missingDir)).resolves.toBe(own);
    expect(calls).toEqual([missingDir]);
  });

  it('leaves forceWasm instances on AgentDB\'s own loader', async () => {
    const { agentdb, calls, own } = fakeAgentDB({ forceWasm: true });
    useHostSqliteDriver(agentdb);

    await expect(agentdb.initializeDatabase(':memory:')).resolves.toBe(own);
    expect(calls).toEqual([':memory:']);
  });

  it('ignores objects without initializeDatabase', () => {
    expect(() => useHostSqliteDriver(null)).not.toThrow();
    expect(() => useHostSqliteDriver({})).not.toThrow();
  });

  it('hands the real AgentDB.initialize() a working handle', async () => {
    const { AgentDB } = (await import('agentdb')) as any;
    const agentdb = new AgentDB({ dbPath: ':memory:' });
    useHostSqliteDriver(agentdb);
    let opened: unknown;
    const wrapped = agentdb.initializeDatabase.bind(agentdb);
    agentdb.initializeDatabase = async (p: string) => (opened = await wrapped(p));
    try {
      await agentdb.initialize();
    } catch {
      // Embedder/vector-backend setup may fail offline; the handle is what matters.
    }

    expect(opened).toBeInstanceOf(Database);
    (opened as Database.Database | undefined)?.close();
  }, 60_000);
});
