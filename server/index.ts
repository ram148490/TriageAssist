import 'dotenv/config';

import express from 'express';
import path from 'path';

import { ensureSchema } from './db';
import { warnAboutGeminiDataHandling } from './lib/gemini';
import { apiNotFound, crossSiteGuard, jsonErrorHandler, securityHeaders } from './lib/http';
import { logError } from './lib/log';
import authRoutes, { requireAuth, sessions } from './routes/auth.routes';
import intakeRoutes from './routes/intake.routes';
import queueRoutes from './routes/queue.routes';

// Last-resort safety nets. Routes already catch their own errors; these make sure
// a bug in an unexpected place is logged instead of silently ending the process
// mid-shift. A rejected promise is recoverable, so keep serving. An uncaught
// exception leaves the process in an unknown state, so exit and let the process
// manager (or the user) restart it cleanly. (logError, never the raw error object:
// see server/lib/log.ts for why.)
process.on('unhandledRejection', (reason) => {
  logError('Unhandled promise rejection', reason);
});
process.on('uncaughtException', (err) => {
  logError('Uncaught exception, shutting down', err);
  process.exit(1);
});

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// Loopback by default: this app serves patient data and must not be reachable from the
// network unless the operator deliberately sets HOST (and puts TLS in front of it).
const HOST = process.env.HOST || '127.0.0.1';

app.disable('x-powered-by');
app.use(securityHeaders);
// Real requests are a few hundred bytes; a small cap limits what an unauthenticated caller can make us parse.
app.use(express.json({ limit: '16kb' }));
app.use(crossSiteGuard);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Everything under /api except health and the login/logout/me routes requires a signed-in staff member.
app.use('/api/auth', authRoutes);
app.use('/api', requireAuth);
app.use('/api', intakeRoutes);
app.use('/api', queueRoutes);
app.use('/api', apiNotFound);
app.use('/api', jsonErrorHandler);

const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  await ensureSchema();
  warnAboutGeminiDataHandling();
  setInterval(() => sessions.purgeExpired(), 60_000).unref();

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`TriageAssist server running on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  logError('Failed to start server', err);
  process.exit(1);
});
