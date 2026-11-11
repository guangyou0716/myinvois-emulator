import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TENANTS } from '../src/defaults.js';
import { loadConfigFile, resolveConfig } from '../src/config.js';

const tenantsPath = fileURLToPath(new URL('../fixtures/tenants.json', import.meta.url));
const sourcePath = fileURLToPath(new URL('../fixtures/samples/SOURCE.md', import.meta.url));

describe('fixtures', () => {
  it('keeps fixtures/tenants.json aligned with the built-in tenants', () => {
    const loaded = resolveConfig(loadConfigFile(tenantsPath));
    expect(loaded.tenants).toEqual(DEFAULT_TENANTS.map((tenant) => ({ ...tenant })));
    expect(loaded.validationDelayMs).toBe(2000);
    expect(loaded.tokenTtlSeconds).toBe(3600);
    const fakeTins = loaded.tenants.map((tenant) => tenant.tin);
    expect(fakeTins).toContain('C00000000000');
    expect(fakeTins).toContain("Supplier's TIN");
  });

  it('records the public sample source URL', () => {
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).toContain('https://sdk.myinvois.hasil.gov.my/');
    expect(readFileSync(fileURLToPath(new URL('../fixtures/samples/1.1-Invoice-Sample.json', import.meta.url))).byteLength).toBeGreaterThan(100);
  });
});
