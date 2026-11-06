import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { JobFileReadError, JobFolderMissingError, type ReadFile } from './storage/jobFolder.js';
import { scanJobFolder } from './jobs/scan.js';
import { registerDocumentRoutes } from './documents/routes.js';
import { createDocumentFolders } from './storage/documentFolder.js';

export interface ServerDeps {
  jobFolderDir: string;
  cvDir?: string;
  coverLetterDir?: string;
  // Logger config; omitted in tests so output stays quiet. main.ts enables it.
  logger?: FastifyServerOptions['logger'];
  // Test seam forwarded to the job folder reader.
  readFile?: ReadFile;
  // One banned phrase per line. Defaults to BANNED_PHRASES_FILE or the container path.
  bannedPhrasesFile?: string;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  app.get('/health', async () => ({ ok: true }));

  app.post('/jobs/scan', async (request, reply) => {
    try {
      return { jobs: await scanJobFolder(deps.jobFolderDir, { readFile: deps.readFile }) };
    } catch (err) {
      if (err instanceof JobFolderMissingError) {
        request.log.error({ folder: err.dir, code: 'ENOENT' }, 'job folder missing');
        return reply.code(503).send({ error: 'job_folder_missing' });
      }
      if (err instanceof JobFileReadError) {
        request.log.error(
          { folder: deps.jobFolderDir, file: err.fileName, code: err.code },
          'job file read failed',
        );
      } else {
        request.log.error({ folder: deps.jobFolderDir, err }, 'job scan failed');
      }
      return reply.code(500).send({ error: 'job_scan_failed' });
    }
  });

  registerDocumentRoutes(
    app,
    createDocumentFolders(
      {
        cv: deps.cvDir ?? './PersonalDetailsCV',
        cover_letter: deps.coverLetterDir ?? './PersonalDetailsCoverLetter',
      },
      (message, context) => app.log.warn(context, message),
    ),
    deps.bannedPhrasesFile ??
      process.env.BANNED_PHRASES_FILE ??
      '/app/config/banned-phrases.txt',
  );

  return app;
}
