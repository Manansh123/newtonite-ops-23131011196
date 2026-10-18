import { config } from './config';
import { createApp } from './app';
import { prisma } from './lib/prisma';

const server = createApp().listen(config.port, () => {
  console.log(`API listening on port ${config.port}${config.serveFrontend ? ' (serving the built UI)' : ''}`);
});

// Graceful shutdown so in-flight transactions finish when the platform restarts the container.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  });
}
