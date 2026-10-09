/**
 * #3693/#3883 single-copy invariant after @claude-flow/memory started opening
 * AgentDB with its own better-sqlite3 (Node 24 Statement-GC abort): the CLI's
 * shared loader must hand out the exact constructor AgentDB's handle uses.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const req = createRequire(import.meta.url);
// This package's vitest config externalizes both; import the resolved files natively.
const importInstalled = (name: string): Promise<any> => import(pathToFileURL(req.resolve(name)).href);

describe('shared-sqlite follows @claude-flow/memory getHostSqliteDriver()', () => {
  it('resolves the owner to the installed @claude-flow/memory', async () => {
    const { resolveSqliteOwnerEntry } = await import('../src/memory/shared-sqlite.js');

    expect(resolveSqliteOwnerEntry()).toBe(req.resolve('@claude-flow/memory'));
  });

  it("loadBetterSqlite3() is the constructor of AgentDB's handle", async () => {
    const memory = await importInstalled('@claude-flow/memory');
    const { AgentDB } = await importInstalled('agentdb');
    const { loadBetterSqlite3 } = await import('../src/memory/shared-sqlite.js');
    const agentdb = new AgentDB({ dbPath: ':memory:' });

    expect(memory.useHostSqliteDriver(agentdb)).toBe(true);
    const handle = await agentdb.initializeDatabase(':memory:');
    try {
      expect(await loadBetterSqlite3()).toBe(memory.getHostSqliteDriver());
      expect(handle.constructor).toBe(await loadBetterSqlite3());
    } finally {
      handle.close();
    }
  });
});
