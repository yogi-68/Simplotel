import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { knowledgeBase } from './domain/knowledge/kb.repository.js';
import { logger } from './lib/logger.js';

function main(): void {
  let env;
  try {
    env = getEnv();
  } catch (error) {
    // Configuration problems are printed plainly: at this point the logger may
    // not be usable, and whoever is starting the server needs to read this.
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        provider: env.AI_PROVIDER,
        model: env.AI_PROVIDER === 'openai' ? env.OPENAI_MODEL : 'n/a',
        retrievalMode: env.RETRIEVAL_MODE,
        facts: knowledgeBase.facts().length,
        allowedOrigins: env.WEB_ORIGIN,
      },
      `Hotel assistant API listening on http://localhost:${env.PORT}`,
    );
    if (env.AI_PROVIDER === 'mock') {
      logger.info('Running with the offline mock model. Set AI_PROVIDER=openai and OPENAI_API_KEY in .env for real AI.');
    }
  });

  // Finish in-flight turns before exiting so a deploy never cuts off a guest
  // mid-answer.
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close((err) => {
      if (err) {
        logger.error({ err: err.message }, 'error during shutdown');
        process.exit(1);
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  });
}

main();
