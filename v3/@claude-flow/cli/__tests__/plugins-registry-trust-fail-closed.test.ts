/**
 * Plugin registry trust fails closed (ADR-145).
 *
 * The signed registry is what vouches for a plugin: its trustLevel 'official'/'verified' lets an
 * install run npm lifecycle scripts and skip the permission gate. So:
 *  - an unverified registry (unsigned, bad signature, placeholder pinned key, verification off)
 *    and the built-in fallback list carry no registry trust;
 *  - a placeholder (all-zero) pinned key is never used to verify — it accepts a forged signature;
 *  - CLAUDE_FLOW_STRICT_PLUGINS=true turns the fallback into an error and makes `plugins install`
 *    refuse without --allow-unverified;
 *  - `plugins install` never passes an unverified entry's trust, permissions or checksum on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ipfs = vi.hoisted(() => ({ registry: null as Record<string, unknown> | null }));

vi.mock('../src/transfer/ipfs/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/transfer/ipfs/client.js')>();
  return {
    ...real,
    resolveIPNS: vi.fn(async () => null),
    fetchFromIPFS: vi.fn(async () => ipfs.registry),
  };
});

const manager = vi.hoisted(() => ({
  installFromNpm: vi.fn(),
}));

vi.mock('../src/plugins/manager.js', () => ({
  getPluginManager: () => ({
    initialize: async () => {},
    getPlugin: async () => undefined,
    installFromNpm: manager.installFromNpm,
    getPluginsDir: () => '/tmp/plugins',
  }),
}));

import { PluginDiscoveryService } from '../src/plugins/store/discovery.js';
import { verifyEd25519Signature } from '../src/transfer/ipfs/client.js';
import { isPlaceholderSigningKey, isStrictPluginMode } from '../src/plugins/trust-policy.js';
import { pluginsCommand } from '../src/commands/plugins.js';
import type { CommandContext } from '../src/types.js';
import anchorsFile from '../src/plugins/trust/trust-anchors.json';

const ZERO_KEY = '0'.repeat(64);
// R = identity point, S = 0: verifies against any small-order key for every message (ZIP-215).
const FORGED_SIG = '01' + '0'.repeat(126);

function entry(name: string, trustLevel = 'official') {
  return {
    id: name,
    name,
    displayName: name,
    version: '1.0.0',
    trustLevel,
    verified: true,
    checksum: 'sha256:' + 'a'.repeat(64),
    permissions: ['shell:exec'],
    hooks: [],
    commands: [],
  };
}

function registryWith(plugins: ReturnType<typeof entry>[], extra: Record<string, unknown> = {}) {
  return {
    version: '1.0.1',
    type: 'plugins',
    plugins,
    totalPlugins: plugins.length,
    featured: [],
    official: plugins.map((p) => p.id),
    ...extra,
  };
}

function serviceFor(publicKey: string, overrides: Record<string, unknown> = {}) {
  return new PluginDiscoveryService({
    requireVerification: true,
    defaultRegistry: 'test',
    registries: [
      { name: 'test', description: 't', ipnsName: 'QmTestRegistry', gateway: 'https://example.invalid', publicKey, trusted: true, official: true },
    ],
    ...overrides,
  } as never);
}

async function signRegistry(registry: Record<string, unknown>) {
  const ed = await import('@noble/ed25519');
  const priv = ed.utils.randomPrivateKey();
  const pub = Buffer.from(await ed.getPublicKeyAsync(priv)).toString('hex');
  const sig = await ed.signAsync(new TextEncoder().encode(JSON.stringify(registry)), priv);
  return { pub, signed: { ...registry, registrySignature: Buffer.from(sig).toString('hex') } };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.CLAUDE_FLOW_STRICT_PLUGINS;
  ipfs.registry = null;
  manager.installFromNpm.mockReset();
});

afterEach(() => {
  delete process.env.CLAUDE_FLOW_STRICT_PLUGINS;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('placeholder signing keys', () => {
  it('the shipped trust anchor is a placeholder', () => {
    expect(anchorsFile.anchors.length).toBeGreaterThan(0);
    for (const a of anchorsFile.anchors) expect(isPlaceholderSigningKey(a.publicKey)).toBe(true);
  });

  it('rejects missing, malformed and all-zero keys; accepts a real-looking key', () => {
    expect(isPlaceholderSigningKey(undefined)).toBe(true);
    expect(isPlaceholderSigningKey('')).toBe(true);
    expect(isPlaceholderSigningKey('ed25519:abc')).toBe(true);
    expect(isPlaceholderSigningKey(`ed25519:${ZERO_KEY}`)).toBe(true);
    expect(isPlaceholderSigningKey(`ed25519:${'ab'.repeat(32)}`)).toBe(false);
  });

  it('the all-zero key really does accept a forged signature (why it must never be verified against)', async () => {
    expect(await verifyEd25519Signature('any message at all', FORGED_SIG, ZERO_KEY)).toBe(true);
  });

  it('a placeholder pinned key leaves the registry unverified even with a "valid" forged signature', async () => {
    ipfs.registry = registryWith([entry('@claude-flow/evil')], { registrySignature: FORGED_SIG });
    const result = await serviceFor(`ed25519:${ZERO_KEY}`).discoverRegistry();

    expect(result.verified).toBe(false);
    expect(result.unverifiedReason).toMatch(/placeholder/);
    expect(result.registry!.plugins.find((p) => p.name === '@claude-flow/evil')).toBeUndefined();
    expect(result.registry!.plugins.every((p) => p.trustLevel === 'unverified' && !p.verified)).toBe(true);
  });
});

describe('discovery: an unverified registry confers no trust', () => {
  it('an unsigned registry falls back to the built-in list, labelled demo and unverified, with trust stripped', async () => {
    ipfs.registry = registryWith([entry('@claude-flow/a')]);
    const svc = serviceFor(`ed25519:${'ab'.repeat(32)}`);

    const first = await svc.discoverRegistry();
    expect(first.success).toBe(true);
    expect(first.demo).toBe(true);
    expect(first.verified).toBe(false);
    expect(first.unverifiedReason).toMatch(/unsigned/);
    expect(first.registry!.plugins.length).toBeGreaterThan(0);
    expect(first.registry!.plugins.every((p) => p.trustLevel === 'unverified' && !p.verified)).toBe(true);

    const second = await svc.discoverRegistry();
    expect(second.fromCache).toBe(true);
    expect(second.verified).toBe(false);
    expect(second.registry!.plugins.every((p) => p.trustLevel === 'unverified')).toBe(true);
  });

  it('a signature that does not verify is not silently treated as the registry', async () => {
    const { signed } = await signRegistry(registryWith([entry('@claude-flow/a')]));
    ipfs.registry = signed;
    // Pinned key differs from the signer.
    const result = await serviceFor(`ed25519:${'ab'.repeat(32)}`).discoverRegistry();
    expect(result.verified).toBe(false);
    expect(result.demo).toBe(true);
    expect(result.unverifiedReason).toMatch(/does not verify/);
  });

  it('with verification disabled the fetched registry is used but every entry is unverified', async () => {
    ipfs.registry = registryWith([entry('@claude-flow/a')]);
    const result = await serviceFor(`ed25519:${'ab'.repeat(32)}`, { requireVerification: false }).discoverRegistry();
    expect(result.success).toBe(true);
    expect(result.demo).toBeUndefined();
    expect(result.verified).toBe(false);
    expect(result.registry!.plugins).toEqual([expect.objectContaining({ name: '@claude-flow/a', trustLevel: 'unverified', verified: false })]);
  });

  it('a correctly signed registry is verified and keeps its trust levels', async () => {
    const { pub, signed } = await signRegistry(registryWith([entry('@claude-flow/a')]));
    ipfs.registry = signed;
    const result = await serviceFor(`ed25519:${pub}`).discoverRegistry();
    expect(result.verified).toBe(true);
    expect(result.demo).toBeUndefined();
    expect(result.unverifiedReason).toBeUndefined();
    expect(result.registry!.plugins[0].trustLevel).toBe('official');
  });

  it('CLAUDE_FLOW_STRICT_PLUGINS=true: no fallback, discovery fails with the reason', async () => {
    process.env.CLAUDE_FLOW_STRICT_PLUGINS = 'true';
    expect(isStrictPluginMode()).toBe(true);
    ipfs.registry = registryWith([entry('@claude-flow/a')]);
    const result = await serviceFor(`ed25519:${'ab'.repeat(32)}`).discoverRegistry();
    expect(result.success).toBe(false);
    expect(result.registry).toBeUndefined();
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/unsigned.*CLAUDE_FLOW_STRICT_PLUGINS=true/);
  });
});

describe('plugins install: unverified registry entries get no registry trust', () => {
  const install = pluginsCommand.subcommands!.find((c) => c.name === 'install')!;
  const ctxFor = (flags: Record<string, unknown>) =>
    ({ args: [], flags: { _: [], ...flags }, cwd: process.cwd(), interactive: false }) as unknown as CommandContext;
  const installed = { success: true, plugin: { name: '@claude-flow/neural', version: '3.0.0', source: 'npm' }, warnings: [] };

  // The real default registry is unsigned today, as the live CID is; serve it unsigned.
  beforeEach(() => {
    ipfs.registry = registryWith([entry('@claude-flow/neural')]);
    manager.installFromNpm.mockResolvedValue(installed);
  });

  it('default mode: a built-in-list entry installs without its "official" trust, permissions or checksum', async () => {
    const res = await install.action!(ctxFor({ name: '@claude-flow/neural' }));
    expect(res.success).toBe(true);
    expect(manager.installFromNpm).toHaveBeenCalledTimes(1);
    const opts = manager.installFromNpm.mock.calls[0][2];
    expect(opts).toEqual({ verify: true, trust: false });
  });

  it('strict mode: refuses without --allow-unverified and installs nothing', async () => {
    process.env.CLAUDE_FLOW_STRICT_PLUGINS = 'true';
    const res = await install.action!(ctxFor({ name: '@claude-flow/neural' }));
    expect(res.success).toBe(false);
    expect(manager.installFromNpm).not.toHaveBeenCalled();
  });

  it('strict mode + --allow-unverified: installs, still without registry trust', async () => {
    process.env.CLAUDE_FLOW_STRICT_PLUGINS = 'true';
    const res = await install.action!(ctxFor({ name: '@claude-flow/neural', allowUnverified: true }));
    expect(res.success).toBe(true);
    expect(manager.installFromNpm.mock.calls[0][2]).toEqual({ verify: true, trust: false });
  });

  it('a verified registry entry still passes its trust, permissions and checksum on', async () => {
    const { pub, signed } = await signRegistry(registryWith([entry('@claude-flow/neural')]));
    ipfs.registry = signed;
    const { DEFAULT_PLUGIN_STORE_CONFIG } = await import('../src/plugins/store/discovery.js');
    const original = DEFAULT_PLUGIN_STORE_CONFIG.registries.map((r) => r.publicKey);
    DEFAULT_PLUGIN_STORE_CONFIG.registries.forEach((r) => { r.publicKey = `ed25519:${pub}`; });
    try {
      const res = await install.action!(ctxFor({ name: '@claude-flow/neural' }));
      expect(res.success).toBe(true);
      expect(manager.installFromNpm.mock.calls[0][2]).toEqual({
        verify: true,
        trust: false,
        expectedChecksum: 'sha256:' + 'a'.repeat(64),
        registryTrustLevel: 'official',
        registryPermissions: ['shell:exec'],
      });
    } finally {
      DEFAULT_PLUGIN_STORE_CONFIG.registries.forEach((r, i) => { r.publicKey = original[i]; });
    }
  });
});
