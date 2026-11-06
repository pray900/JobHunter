import Fastify, { type FastifyInstance } from 'fastify';
import { scanJobFolder } from './jobs/scan.js';

export interface ServerDeps {
  jobFolderDir: string;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify();
  app.get('/health', async () => ({ ok: true }));
  app.post('/jobs/scan', async () => ({ jobs: await scanJobFolder(deps.jobFolderDir) }));
  return app;
}
