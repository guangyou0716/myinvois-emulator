import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('Dockerfile', () => {
  const dockerfile = read('../Dockerfile');
  const ignore = read('../.dockerignore').split('\n').map((line) => line.trim());

  it('pins the node:20-alpine base by digest', () => {
    expect(dockerfile).toMatch(/^ARG NODE_IMAGE=node:20-alpine@sha256:[0-9a-f]{64}$/m);
    const froms = dockerfile.split('\n').filter((line) => line.startsWith('FROM '));
    expect(froms).toHaveLength(2);
    for (const line of froms) expect(line).toContain('${NODE_IMAGE}');
  });

  it('runs the compiled CLI as the unprivileged node user on all interfaces', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain('ENTRYPOINT ["node", "dist/cli.js"]');
    expect(dockerfile).toContain('CMD ["start", "--host", "0.0.0.0", "--port", "8787"]');
    expect(dockerfile).toMatch(/^EXPOSE 8787$/m);
    expect(dockerfile).toContain('/_emulator/health');
  });

  it('copies no node_modules into the runtime stage', () => {
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM '));
    expect(runtime).not.toContain('node_modules');
    expect(runtime).not.toMatch(/npm (ci|install)/);
  });

  it('keeps local build output and git data out of the build context', () => {
    for (const entry of ['node_modules', 'dist', '.git', '.cache', 'reports']) expect(ignore).toContain(entry);
  });
});
