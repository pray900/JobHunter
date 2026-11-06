import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { N8N_URL, ROOT, stub } from './lib';

describe('e2e infrastructure', () => {
  it('n8n is healthy', async () => {
    const res = await fetch(`${N8N_URL}/healthz`);
    expect(res.ok).toBe(true);
  });

  it('anthropic stub starts with no recorded requests', async () => {
    expect(await stub.requests()).toEqual([]);
  });

  it('bootstrap loaded both credentials into n8n', () => {
    const out = execFileSync(
      'docker',
      ['compose', '-f', join(ROOT, 'docker-compose.test.yml'), 'exec', '-T', 'n8n', 'n8n', 'export:credentials', '--all'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    // The CLI prints log lines before the JSON array.
    const json = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith('[{'));
    const creds = JSON.parse(json!);
    const names = creds.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(['Anthropic', 'JobHunter Postgres']);
  });

  it('re-running the bootstrap publishes only the shipped workflows and leaves no temp credentials', () => {
    const composeFile = join(ROOT, 'docker-compose.test.yml');
    const n8n = (args: string[], input?: string) =>
      execFileSync('docker', ['compose', '-f', composeFile, 'exec', '-T', 'n8n', ...args], { cwd: ROOT, encoding: 'utf8', input });
    const activeIds = () =>
      n8n(['n8n', 'list:workflow', '--active=true', '--onlyId'])
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^[A-Za-z0-9_-]+$/.test(l))
        .sort();

    // A workflow the user built in the editor (publishable: it has a trigger).
    const own = {
      id: 'user-own-workflow',
      name: 'My own workflow',
      active: false,
      nodes: [{ id: 'u1', name: 'Daily', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: 'days' }] } } }],
      connections: {},
      settings: {},
    };
    n8n(['sh', '-c', 'cat >/tmp/user-own.json'], JSON.stringify(own));
    n8n(['n8n', 'import:workflow', '--input=/tmp/user-own.json']);
    n8n(['rm', '-f', '/tmp/user-own.json']);

    execFileSync('bash', [join(ROOT, 'scripts', 'n8n-bootstrap.sh'), composeFile], { cwd: ROOT, stdio: 'inherit' });

    expect(activeIds()).toEqual(['jh-job-intake-sync', 'jh-jobs-api']);
    expect(n8n(['sh', '-c', 'test -e /tmp/jh-credentials.json && echo present || echo absent']).trim()).toBe('absent');
  }, 300_000);
});
