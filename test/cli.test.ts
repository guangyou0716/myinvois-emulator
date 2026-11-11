import { describe, expect, it } from 'vitest';
import { parseArgs, run } from '../src/cli.js';

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
    });
  });

  it('reads the documented flags', () => {
    expect(parseArgs(['start', '--port', '0', '--host', '127.0.0.1', '--seed', '42', '--clock', 'fake', '--config', 'emulator.json'])).toEqual({
      mode: 'start',
      port: 0,
      host: '127.0.0.1',
      seed: 42,
      clock: 'fake',
      configPath: 'emulator.json',
    });
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
    expect(help.out).toContain('127.0.0.1');
    const version = io();
    expect(await run(['--version'], version)).toBe(0);
    expect(version.out.trim()).toBe('0.1.0');
  });
});
