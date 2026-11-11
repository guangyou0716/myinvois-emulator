import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseArgs, run } from '../src/cli.js';
import { loadFaultsFile } from '../src/faults.js';

function io() {
  return {
    out: '',
    err: '',
    stdout(text: string) {
      this.out += text;
    },
    stderr(text: string) {
      this.err += text;
    },
  };
}

describe('cli arguments', () => {
  it('defaults host, port, seed, and real clock', () => {
    expect(parseArgs(['start'])).toEqual({
      mode: 'start',
      port: 8787,
      host: '127.0.0.1',
      seed: 1,
      clock: 'real',
      configPath: null,
      rateLimitEnabled: true,
      rpmScale: 1,
      faultsPath: null,
      validator: 'none',
      precheckCommand: null,
    });
  });

  it('reads the documented flags', () => {
    expect(
      parseArgs([
        'start',
        '--port',
        '0',
        '--host',
        '127.0.0.1',
        '--seed',
        '42',
        '--clock',
        'fake',
        '--config',
        'emulator.json',
        '--rpm-scale',
        '0.5',
        '--no-rate-limit',
        '--faults',
        'fixtures/faults/500-storm.json',
      ]),
    ).toEqual({
      mode: 'start',
      port: 0,
      host: '127.0.0.1',
      seed: 42,
      clock: 'fake',
      configPath: 'emulator.json',
      rateLimitEnabled: false,
      rpmScale: 0.5,
      faultsPath: 'fixtures/faults/500-storm.json',
      validator: 'none',
      precheckCommand: null,
    });
  });

  it('parses --rpm-scale 0.5 and --no-rate-limit on their own', () => {
    expect(parseArgs(['start', '--rpm-scale', '0.5'])).toMatchObject({
      mode: 'start',
      rateLimitEnabled: true,
      rpmScale: 0.5,
    });
    expect(parseArgs(['start', '--no-rate-limit'])).toMatchObject({
      mode: 'start',
      rateLimitEnabled: false,
      rpmScale: 1,
    });
  });

  it('rejects a non-positive or non-finite --rpm-scale', () => {
    expect(parseArgs(['start', '--rpm-scale', '0'])).toEqual({
      mode: 'error',
      message: '--rpm-scale must be a finite number greater than 0',
    });
    expect(parseArgs(['start', '--rpm-scale', '-1'])).toMatchObject({ mode: 'error' });
    expect(parseArgs(['start', '--rpm-scale', 'Infinity'])).toMatchObject({ mode: 'error' });
    expect(parseArgs(['start', '--rpm-scale', 'nope'])).toMatchObject({ mode: 'error' });
  });

  it('rejects an unknown clock and a missing command', async () => {
    expect(parseArgs(['start', '--clock', 'paused']).mode).toBe('error');
    const streams = io();
    expect(await run([], streams)).toBe(2);
    expect(streams.err).toContain('start');
  });

  it('prints help and version without listening', async () => {
    const help = io();
    expect(await run(['--help'], help)).toBe(0);
    expect(help.out).toContain('--clock');
    expect(help.out).toContain('--rpm-scale');
    expect(help.out).toContain('--no-rate-limit');
    expect(help.out).toContain('--faults');
    expect(help.out).toContain('--validator');
    expect(help.out).toContain('--precheck-cmd');
    expect(help.out).toContain('127.0.0.1');
    const version = io();
    expect(await run(['--version'], version)).toBe(0);
    expect(version.out.trim()).toBe('0.1.0');
  });

  it('parses --faults and loads a valid file', () => {
    const path = fileURLToPath(new URL('../fixtures/faults/500-storm.json', import.meta.url));
    expect(parseArgs(['start', '--faults', path])).toMatchObject({
      mode: 'start',
      faultsPath: path,
    });
    expect(loadFaultsFile(path)).toEqual([
      { endpoint: '*', kind: 'error500', probability: 0.5 },
    ]);
  });

  it('rejects a missing or invalid --faults file', async () => {
    const missing = io();
    expect(await run(['start', '--faults', join(tmpdir(), 'no-such-faults.json')], missing)).toBe(2);
    expect(missing.err).toContain('Cannot read faults');

    const dir = mkdtempSync(join(tmpdir(), 'faults-'));
    try {
      const badJson = join(dir, 'bad.json');
      writeFileSync(badJson, '{');
      const invalidJson = io();
      expect(await run(['start', '--faults', badJson], invalidJson)).toBe(2);
      expect(invalidJson.err).toContain('not valid JSON');

      const badRule = join(dir, 'rule.json');
      writeFileSync(badRule, JSON.stringify([{ endpoint: 'submit', kind: 'error500' }]));
      const invalidRule = io();
      expect(await run(['start', '--faults', badRule], invalidRule)).toBe(2);
      expect(invalidRule.err).toMatch(/probability or nth/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses --validator precheck and a quoted --precheck-cmd', () => {
    expect(
      parseArgs(['start', '--validator', 'precheck', '--precheck-cmd', "node '/path with spaces/cli.js' --json"]),
    ).toMatchObject({
      mode: 'start',
      validator: 'precheck',
      precheckCommand: ['node', '/path with spaces/cli.js', '--json'],
    });
    expect(parseArgs(['start', '--validator', 'none'])).toMatchObject({
      mode: 'start',
      validator: 'none',
      precheckCommand: null,
    });
  });

  it('rejects missing, empty, or unmatched --precheck-cmd with precheck', async () => {
    expect(parseArgs(['start', '--validator', 'precheck'])).toEqual({
      mode: 'error',
      message: '--precheck-cmd is required when --validator precheck',
    });
    expect(parseArgs(['start', '--validator', 'precheck', '--precheck-cmd', '   '])).toEqual({
      mode: 'error',
      message: '--precheck-cmd requires a non-empty command',
    });
    expect(parseArgs(['start', '--validator', 'precheck', '--precheck-cmd', "node 'oops"])).toMatchObject({
      mode: 'error',
    });
    expect(parseArgs(['start', '--precheck-cmd', 'node cli.js'])).toEqual({
      mode: 'error',
      message: '--precheck-cmd requires --validator precheck',
    });
    expect(parseArgs(['start', '--validator', 'other'])).toEqual({
      mode: 'error',
      message: '--validator must be none or precheck',
    });

    const streams = io();
    expect(await run(['start', '--validator', 'precheck'], streams)).toBe(2);
    expect(streams.err).toContain('--precheck-cmd');
  });
});
