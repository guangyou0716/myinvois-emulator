#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfigFile, type EmulatorConfig } from './config.js';
import { createEmulator } from './emulator.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const USAGE = 'Usage: myinvois-emulator start [--port 8787] [--host 127.0.0.1] [--seed 1] [--clock real|fake] [--config emulator.json]';

const HELP = `${USAGE}

Offline MyInvois emulator. It binds to 127.0.0.1 by default and never calls LHDN.

Commands:
  start       Listen for identity and e-invoicing requests

Options:
  --port      TCP port (0 lets the OS choose). Default 8787
  --host      Bind address. Default 127.0.0.1
  --seed      Integer seed for ids and tokens. Default 1
  --clock     real (wall clock) or fake (moves only via /_emulator/clock/advance). Default real
  --config    JSON config file. Omitted fields keep the built-in defaults
  --help      Show this help
  --version   Print the package version

On success, start prints one line: myinvois-emulator listening on http://127.0.0.1:8787
`;

type Parsed =
  | { mode: 'help' }
  | { mode: 'version' }
  | { mode: 'error'; message: string }
  | {
      mode: 'start';
      port: number;
      host: string;
      seed: number;
      clock: 'real' | 'fake';
      configPath: string | null;
    };

function packageVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (isRecord(parsed) && typeof parsed.version === 'string') return parsed.version;
  throw new Error('package.json is missing a version string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv: string[]): Parsed {
  if (argv.includes('--help')) return { mode: 'help' };
  if (argv.includes('--version')) return { mode: 'version' };

  let command: string | null = null;
  let port = 8787;
  let host = '127.0.0.1';
  let seed = 1;
  let clock: 'real' | 'fake' = 'real';
  let configPath: string | null = null;

  try {
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index] ?? '';
      if (arg === 'start' && command === null) {
        command = 'start';
        continue;
      }
      if (arg === '--port') {
        const raw = takeValue(argv, index, '--port');
        if (!/^\d+$/.test(raw)) return { mode: 'error', message: '--port must be an integer from 0 to 65535' };
        port = Number(raw);
        if (port > 65535) return { mode: 'error', message: '--port must be an integer from 0 to 65535' };
        index += 1;
        continue;
      }
      if (arg === '--host') {
        host = takeValue(argv, index, '--host');
        if (host.trim() === '') return { mode: 'error', message: '--host requires a value' };
        index += 1;
        continue;
      }
      if (arg === '--seed') {
        const raw = takeValue(argv, index, '--seed');
        if (!/^-?\d+$/.test(raw)) return { mode: 'error', message: '--seed must be an integer' };
        seed = Number(raw);
        if (!Number.isSafeInteger(seed)) return { mode: 'error', message: '--seed must be a safe integer' };
        index += 1;
        continue;
      }
      if (arg === '--clock') {
        const raw = takeValue(argv, index, '--clock');
        if (raw !== 'real' && raw !== 'fake') return { mode: 'error', message: '--clock must be real or fake' };
        clock = raw;
        index += 1;
        continue;
      }
      if (arg === '--config') {
        configPath = takeValue(argv, index, '--config');
        index += 1;
        continue;
      }
      if (arg.startsWith('--')) return { mode: 'error', message: `Unknown option: ${arg}` };
      return { mode: 'error', message: `Unexpected argument: ${arg}` };
    }
  } catch (cause) {
    return { mode: 'error', message: cause instanceof Error ? cause.message : String(cause) };
  }

  if (command !== 'start') return { mode: 'error', message: 'Missing command: start' };
  return { mode: 'start', port, host, seed, clock, configPath };
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.mode === 'help') {
    io.stdout(HELP);
    return 0;
  }
  if (parsed.mode === 'version') {
    io.stdout(`${packageVersion()}\n`);
    return 0;
  }
  if (parsed.mode === 'error') {
    io.stderr(`${parsed.message}\n${HELP}`);
    return 2;
  }

  let config: EmulatorConfig | undefined;
  if (parsed.configPath) {
    try {
      config = loadConfigFile(parsed.configPath);
    } catch (cause) {
      io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      return 2;
    }
  }

  const emulator = createEmulator({
    seed: parsed.seed,
    clock: parsed.clock,
    host: parsed.host,
    port: parsed.port,
    config,
    onError(error) {
      const detail = error instanceof Error ? error.message : String(error);
      io.stderr(`request failed: ${detail}\n`);
    },
  });

  try {
    const info = await emulator.start({ port: parsed.port, host: parsed.host });
    io.stdout(`myinvois-emulator listening on ${info.url}\n`);
  } catch (cause) {
    io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await emulator.stop();
  return 0;
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  run(process.argv.slice(2), {
    stdout(text) {
      process.stdout.write(text);
    },
    stderr(text) {
      process.stderr.write(text);
    },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((cause: unknown) => {
      const detail = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`${detail}\n`);
      process.exitCode = 1;
    });
}
