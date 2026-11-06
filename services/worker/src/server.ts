import Fastify, { type FastifyInstance } from 'fastify';

export interface ServerDeps {
  jobFolderDir: string;
}

export function buildServer(_deps: ServerDeps): FastifyInstance {
  const app = Fastify();
  app.get('/health', async () => ({ ok: true }));
  return app;
}
