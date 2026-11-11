#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfigFile, type EmulatorConfig } from './config.js';
import { createEmulator } from './emulator.js';
import { loadFaultsFile, type FaultRule } from './faults.js';
import { createJsonlRecorder, type Recorder } from './record.js';
import { splitCommand, ValidatorError, type ValidatorOption } from './validator.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const USAGE =
  'Usage: myinvois-emulator start [--port 8787] [--host 127.0.0.1] [--seed 1] [--clock real|fake] [--config emulator.json] [--rpm-scale 1] [--no-rate-limit] [--faults faults.json] [--validator none|precheck] [--precheck-cmd "<cmd>"] [--record requests.jsonl]';

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
  --rpm-scale Multiply per-endpoint RPM (floor, minimum 1). Default 1
  --no-rate-limit Disable per-endpoint rate limits
  --faults    JSON file of fault rules (array or {"faults": [...]}). Default none
  --validator none (Invoice root only) or precheck (shell out to myinvois-precheck). Default none
  --precheck-cmd  Command to run for --validator precheck, e.g. "node dist/cli.js --json". Required when precheck
  --record    Append one redacted JSON line per request/response to this file (client_secret and access_token become [redacted]; Authorization is not stored)
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
      rateLimitEnabled: boolean;
      rpmScale: number;
      faultsPath: string | null;
      validator: 'none' | 'precheck';
      precheckCommand: string[] | null;
      recordPath: string | null;
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
  let rateLimitEnabled = true;
  let rpmScale = 1;
  let faultsPath: string | null = null;
  let validator: 'none' | 'precheck' = 'none';
  let precheckCmd: string | null = null;
  let recordPath: string | null = null;

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
      if (arg === '--rpm-scale') {
        const raw = takeValue(argv, index, '--rpm-scale');
        const scale = Number(raw);
        if (!Number.isFinite(scale) || scale <= 0) {
          return { mode: 'error', message: '--rpm-scale must be a finite number greater than 0' };
        }
        rpmScale = scale;
        index += 1;
        continue;
      }
      if (arg === '--no-rate-limit') {
        rateLimitEnabled = false;
        continue;
      }
      if (arg === '--faults') {
        faultsPath = takeValue(argv, index, '--faults');
        index += 1;
        continue;
      }
      if (arg === '--validator') {
        const raw = takeValue(argv, index, '--validator');
        if (raw !== 'none' && raw !== 'precheck') {
          return { mode: 'error', message: '--validator must be none or precheck' };
        }
        validator = raw;
        index += 1;
        continue;
      }
      if (arg === '--precheck-cmd') {
        precheckCmd = takeValue(argv, index, '--precheck-cmd');
        index += 1;
        continue;
      }
      if (arg === '--record') {
        recordPath = takeValue(argv, index, '--record');
        if (recordPath.trim() === '') return { mode: 'error', message: '--record requires a file path' };
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

  let precheckCommand: string[] | null = null;
  if (validator === 'precheck') {
    if (precheckCmd === null) {
      return { mode: 'error', message: '--precheck-cmd is required when --validator precheck' };
    }
    if (precheckCmd.trim() === '') {
      return { mode: 'error', message: '--precheck-cmd requires a non-empty command' };
    }
    try {
      precheckCommand = splitCommand(precheckCmd);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return { mode: 'error', message: detail.replace('precheck command', '--precheck-cmd') };
    }
    if (precheckCommand.length === 0) {
      return { mode: 'error', message: '--precheck-cmd must contain a command' };
    }
  } else if (precheckCmd !== null) {
    return { mode: 'error', message: '--precheck-cmd requires --validator precheck' };
  }

  return {
    mode: 'start',
    port,
    host,
    seed,
    clock,
    configPath,
    rateLimitEnabled,
    rpmScale,
    faultsPath,
    validator,
    precheckCommand,
    recordPath,
  };
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

  let faults: FaultRule[] | undefined;
  if (parsed.faultsPath) {
    try {
      faults = loadFaultsFile(parsed.faultsPath);
    } catch (cause) {
      io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      return 2;
    }
  }

  let record: Recorder | undefined;
  if (parsed.recordPath) {
    try {
      record = createJsonlRecorder(parsed.recordPath);
    } catch (cause) {
      io.stderr(`--record: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      return 2;
    }
  }

  const validator: ValidatorOption =
    parsed.validator === 'precheck' && parsed.precheckCommand
      ? { kind: 'precheck', command: parsed.precheckCommand }
      : 'none';

  let emulator: ReturnType<typeof createEmulator>;
  try {
    emulator = createEmulator({
      seed: parsed.seed,
      clock: parsed.clock,
      host: parsed.host,
      port: parsed.port,
      config,
      faults,
      validator,
      record,
      rateLimit: {
        enabled: parsed.rateLimitEnabled,
        scale: parsed.rpmScale,
      },
      onError(error) {
        const detail = error instanceof Error ? error.message : String(error);
        io.stderr(`request failed: ${detail}\n`);
      },
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    io.stderr(`${detail}\n`);
    return cause instanceof ValidatorError ? 2 : 1;
  }

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
