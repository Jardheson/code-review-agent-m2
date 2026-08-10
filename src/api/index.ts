import { startServer } from './server.js';

startServer().catch((err) => {
  console.error('Falha ao iniciar servidor', err);
  process.exit(1);
});
