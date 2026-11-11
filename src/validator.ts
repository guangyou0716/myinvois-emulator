import { DEFAULT_PRECHECK_TIMEOUT_MS } from './constants.js';

export class ValidatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidatorError';
  }
}

export type ValidatorOption =
  | 'none'
  | {
      kind: 'precheck';
      command: string[];
      timeoutMs?: number;
    };

export type ResolvedValidator =
  | { kind: 'none' }
  | { kind: 'precheck'; command: string[]; timeoutMs: number };

/**
 * Split a CLI command string into argv. Single and double quotes group tokens.
 * There is no shell expansion, globbing, or backslash unescape.
 */
export function splitCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? '';
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (quote !== null) {
    throw new ValidatorError('unmatched quote in precheck command');
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

export function resolveValidator(option?: ValidatorOption): ResolvedValidator {
  if (option === undefined || option === 'none') return { kind: 'none' };
  if (typeof option !== 'object' || option === null || option.kind !== 'precheck') {
    throw new ValidatorError("validator must be 'none' or { kind: 'precheck', command }");
  }
  if (!Array.isArray(option.command) || option.command.length === 0) {
    throw new ValidatorError('precheck command must be a non-empty array');
  }
  for (const entry of option.command) {
    if (typeof entry !== 'string' || entry === '') {
      throw new ValidatorError('precheck command entries must be non-empty strings');
    }
  }
  const timeoutMs = option.timeoutMs ?? DEFAULT_PRECHECK_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new ValidatorError('precheck timeoutMs must be a positive integer');
  }
  return { kind: 'precheck', command: [...option.command], timeoutMs };
}
