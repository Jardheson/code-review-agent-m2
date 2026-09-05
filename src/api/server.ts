import Fastify, { type FastifyInstance } from 'fastify';
import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';
import { runGraph } from '../agent/graph.js';
import { PullRequestInputSchema } from '../schemas/index.js';
import { logger, createChildLogger } from '../observability/logger.js';
import { auditor } from '../observability/auditor.js';
import { staticAnalysisTool } from '../tools/staticAnalysisTool.js';
import { AppError, InternalServerError, ValidationError } from '../errors/AppError.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    keepAliveTimeout: 65_000,
  });

  app.addHook('onRequest', (req, _reply, done) => {
    (req as typeof req & { $traceId: string }).$traceId =
      (req.headers['x-trace-id'] as string | undefined) ?? uuidv4();
    done();
  });

  app.addHook('onSend', (req, reply, _payload, done) => {
    const traceId = (req as typeof req & { $traceId?: string }).$traceId ?? 'unknown';
    reply.header('X-Trace-Id', traceId);
    done();
  });

  app.setErrorHandler((err, req, reply) => {
    const traceId = (req as typeof req & { $traceId?: string }).$traceId ?? 'unknown';
    reply.header('X-Trace-Id', traceId);
    const log = createChildLogger({ traceId });
    if (err instanceof AppError) {
      log.warn({ code: err.code, statusCode: err.statusCode }, err.message);
      return reply.status(err.statusCode).send({ error: err.toJSON(), traceId });
    }
    if (err.validation) {
      const vErr = new ValidationError('Payload invalido', err.validation);
      return reply.status(400).send({ error: vErr.toJSON(), traceId });
    }
    log.error({ error: err.stack ?? err.message }, 'Erro nao tratado na API');
    return reply.status(500).send({
      error: {
        name: 'InternalServerError',
        code: 'INTERNAL_ERROR',
        message: 'Erro interno no servidor',
        traceId,
      },
    });
  });

  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              service: { type: 'string' },
              version: { type: 'string' },
              environment: { type: 'string' },
              timestamp: { type: 'string' },
            },
          },
        },
      },
    },
    async () => ({
      status: 'ok',
      service: 'code-review-agent',
      version: '1.0.0',
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    }),
  );

  const landingHtml = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Code Review Agent — IA para Desenvolvedores (M2.2)</title>
  <style>
    :root {
      --bg: #0b1020;
      --bg-2: #121933;
      --fg: #e6eefc;
      --muted: #8fa2c5;
      --accent: #6ee7ff;
      --accent-2: #a78bfa;
      --ok: #34d399;
      --warn: #fbbf24;
      --bad: #f87171;
      --border: #263157;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 28px;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Inter, sans-serif;
      background: radial-gradient(1200px 700px at 10% -10%, #1b2353 0%, transparent 60%),
                  radial-gradient(900px 500px at 110% 10%, #2a1960 0%, transparent 55%), var(--bg);
      color: var(--fg); min-height: 100vh;
    }
    header {
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      padding: 18px 22px; border: 1px solid var(--border); border-radius: 16px;
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
      backdrop-filter: blur(6px);
    }
    header h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
    .pill {
      display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px;
      background: rgba(52, 211, 153, 0.1); color: var(--ok);
      border: 1px solid rgba(52,211,153,0.25); border-radius: 999px;
      font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
    }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--ok); box-shadow: 0 0 12px var(--ok); }
    main { display: grid; grid-template-columns: repeat(12, 1fr); gap: 20px; margin-top: 22px; }
    .card {
      grid-column: span 6;
      padding: 20px 22px;
      background: var(--bg-2);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset;
    }
    .card.wide { grid-column: span 12; }
    .card h2 { margin: 0 0 10px 0; font-size: 16px; letter-spacing: -0.01em; }
    .card p, .card li { color: var(--muted); line-height: 1.55; font-size: 14px; }
    code {
      background: rgba(110, 231, 255, 0.08); color: var(--accent);
      padding: 2px 6px; border-radius: 6px; font-size: 12.5px;
      border: 1px solid rgba(110,231,255,0.18);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    pre {
      margin: 0; padding: 14px 16px; overflow: auto; border-radius: 12px;
      background: #070b1a; border: 1px solid var(--border);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px;
    }
    ul.links { list-style: none; padding: 0; margin: 10px 0 0 0; display: grid; gap: 8px; }
    ul.links li {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px;
      background: rgba(255,255,255,0.015);
    }
    ul.links a {
      color: var(--accent); text-decoration: none; font-weight: 600; font-size: 13.5px;
    }
    ul.links a:hover { text-decoration: underline; }
    .tag {
      font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
      padding: 3px 8px; border-radius: 999px;
      border: 1px solid var(--border); color: var(--muted); background: rgba(255,255,255,0.02);
    }
    .tag.get { color: var(--accent); border-color: rgba(110,231,255,0.3); background: rgba(110,231,255,0.08); }
    .tag.post { color: var(--accent-2); border-color: rgba(167,139,250,0.3); background: rgba(167,139,250,0.08); }
    footer { margin-top: 28px; color: var(--muted); font-size: 12px; text-align: center; }
    @media (max-width: 860px) { .card { grid-column: span 12 !important; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Code Review Agent (CRA) — Projeto Avaliativo M2.2</h1>
      <p style="margin: 6px 0 0 0; color: var(--muted); font-size: 13.5px;">
        Agente híbrido de revisão de PRs com grafo de orquestração, tool de análise estática,
        memória persistente, observabilidade 2 sinais, LLM opcional e low-code.
      </p>
    </div>
    <div>
      <span class="pill"><span class="dot"></span> Online · Porta 3000 · ${env.NODE_ENV}</span>
    </div>
  </header>

  <main>
    <section class="card wide">
      <h2>Endpoints da API</h2>
      <ul class="links" id="endpoints">
        <li><span><span class="tag get">GET</span> <a href="/health">/health</a></span><span class="tag">Monitoramento</span></li>
        <li><span><span class="tag post">POST</span> <a href="#" title="Use Insomnia, curl ou Postman com body JSON">/api/v1/review</a></span><span class="tag">Fluxo principal</span></li>
        <li><span><span class="tag post">POST</span> <a href="#" title="Tool HTTP para integrações externas (ex: serviço separado na porta 3001)">/api/v1/tools/static-analysis</a></span><span class="tag">Tool HTTP</span></li>
        <li><span><span class="tag post">POST</span> <a href="#" title="Recebe triggers declarativos low-code (GitHub Actions, n8n, Make)">/api/v1/webhook/low-code</a></span><span class="tag">Integração low-code</span></li>
        <li><span><span class="tag get">GET</span> <a href="/api/v1/observability/audit">/api/v1/observability/audit</a></span><span class="tag">Auditoria (últimos 50 traces)</span></li>
        <li><span><span class="tag get">GET</span> <a href="/api/v1/observability/logs">/api/v1/observability/logs</a></span><span class="tag">Logs estruturados (últimas 100 linhas)</span></li>
        <li><span><span class="tag get">GET</span> <a href="#" title="Substitua :traceId pelo ID retornado na resposta">/api/v1/traces/:traceId/audit</a></span><span class="tag">Auditoria por trace individual</span></li>
      </ul>
    </section>

    <section class="card">
      <h2>Como testar o fluxo principal via CLI</h2>
      <p>Use a CLI com dados de exemplo embutidos:</p>
      <pre>cd "e:\\Projeto Avaliativo - Módulo 2"
npm run cli -- review --sample</pre>
      <p style="margin-top: 14px;">Ou invoque a API com <code>curl</code>:</p>
      <pre>curl -X POST http://localhost:3000/api/v1/review ^
  -H "Content-Type: application/json" ^
  -d @- &lt; sample-pr.json</pre>
    </section>

    <section class="card">
      <h2>Cobertura de testes</h2>
      <p>A página de coverage gerada pelo <code>vitest</code> + <code>v8</code> está na pasta
      <code>coverage/index.html</code>. Abra diretamente via:</p>
      <ul style="margin: 10px 0 0 0; padding-left: 18px;">
        <li>Arquivo local no explorador: <code>coverage/index.html</code> (servido via <code>file://</code>)</li>
        <li>Ou servidor estático: <code>npx http-server coverage -p 8080</code> → <a href="http://localhost:8080/">http://localhost:8080/</a></li>
      </ul>
    </section>

    <section class="card wide">
      <h2>Arquitetura da solução (10 nodes orquestrados)</h2>
      <pre><code>INPUT_VALIDATION → ADVERSARIAL_CHECK → STATIC_ANALYSIS
                              ↓
              ┌─ PARALLEL_ANALYSIS (Promise.all: aggregateMetrics + preliminaryRisk)
              ↓
       LLM_ANALYSIS → AGGREGATE_RESULTS → RISK_ASSESSMENT
                              ↓
     GENERATE_RECOMMENDATIONS → HUMAN_APPROVAL_CHECK → FINAL_REPORT</code></pre>
      <p style="margin-top: 10px;">
        Classificação: <strong>sistema híbrido</strong> (~70% workflow determinístico com Zod + regras, ~30% assistido por LLM/heurística).
      </p>
    </section>
  </main>

  <footer>
    Entrega: 31/08/26 · Domínio: Code Review Agent para times de QA &amp; SRE · Stack: Node 20 + TypeScript strict ESM + Fastify + Vitest + Pino
  </footer>
</body>
</html>`;

  app.get(
    '/',
    {
      schema: {
        response: {
          200: {
            type: 'string',
          },
        },
      },
    },
    async (_req, reply) => {
      reply.type('text/html; charset=utf-8').send(landingHtml);
      return reply;
    },
  );

  app.post(
    '/api/v1/review',
    {
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: { type: 'object' },
              traceId: { type: 'string' },
              steps: { type: 'array' },
            },
            required: ['data', 'traceId', 'steps'],
          },
        },
      },
    },
    async (req, reply) => {
      const traceId = (req as typeof req & { $traceId?: string }).$traceId ?? uuidv4();
      const parsed = PullRequestInputSchema.safeParse(req.body);
      if (!parsed.success) {
        const vErr = new ValidationError(
          'Payload invalido em POST /api/v1/review',
          parsed.error.flatten(),
        );
        const log = createChildLogger({ traceId, route: 'POST /api/v1/review' });
        log.warn({ issues: parsed.error.flatten() }, vErr.message);
        return reply.status(400).send({ error: vErr.toJSON(), traceId });
      }
      const input = parsed.data;
      const log = createChildLogger({ prId: input.prId, route: 'POST /api/v1/review', traceId });
      log.info({ filesCount: input.files.length }, 'Recebida requisicao de revisao');

      const state = await runGraph(input);
      if (!state.finalResult) {
        throw new InternalServerError('Final result nao gerado apos fluxo do grafo', {
          cause: 'EMPTY_FINAL_RESULT',
          prId: input.prId,
          traceId,
        });
      }

      return {
        data: state.finalResult,
        traceId: state.traceId,
        steps: state.steps.map((s) => ({
          node: s.node,
          status: s.status,
          durationMs: s.durationMs,
          error: s.error,
        })),
      };
    },
  );

  app.post(
    '/api/v1/tools/static-analysis',
    {
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: { type: 'object' },
              traceId: { type: 'string' },
            },
            required: ['data', 'traceId'],
          },
        },
      },
    },
    async (req, reply) => {
      const traceId = (req as typeof req & { $traceId?: string }).$traceId ?? uuidv4();
      const raw = req.body as Record<string, unknown> | null;
      if (typeof raw !== 'object' || raw === null) {
        const vErr = new ValidationError('Payload invalido em POST /api/v1/tools/static-analysis', {
          receivedType: typeof raw,
        });
        return reply.status(400).send({ error: vErr.toJSON(), traceId });
      }

      const prId = typeof raw.prId === 'string' && raw.prId.length > 0 ? raw.prId : 'tool-http';
      const input = {
        ...raw,
        prId,
        traceId: typeof raw.traceId === 'string' && raw.traceId.length > 0 ? raw.traceId : traceId,
      };

      const log = createChildLogger({ prId, route: 'POST /api/v1/tools/static-analysis', traceId });
      log.info('Recebida requisicao para tool HTTP (static analysis)');

      const result = await staticAnalysisTool.execute(input);
      return reply.send({ data: result, traceId });
    },
  );

  app.get('/api/v1/traces/:traceId/audit', async (req) => {
    const { traceId } = req.params as { traceId: string };
    const entries = auditor.queryByTrace(traceId);
    return { traceId, count: entries.length, entries };
  });

  app.get('/api/v1/observability/audit', async (_req) => {
    const entries = auditor.tail(50);
    return { count: entries.length, entries };
  });

  app.get('/api/v1/observability/logs', async (_req, reply) => {
    const file = env.LOG_FILE;
    const MAX_LINES = 100;
    try {
      await fs.promises.access(file, fs.constants.R_OK);
    } catch {
      return reply
        .header('X-Trace-Store', file)
        .send({ lines: 0, entries: [], note: 'Arquivo de log ainda nao criado' });
    }
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, { encoding: 'utf8' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({
        error: new InternalServerError('Falha ao ler arquivo de log', {
          cause: msg,
          file,
        }).toJSON(),
      });
    }
    const allLines = raw
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const last = allLines.slice(-MAX_LINES).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
    return reply.send({ lines: last.length, totalLinesInFile: allLines.length, entries: last });
  });

  app.post('/api/v1/webhook/low-code', async (req, reply) => {
    const traceId = (req as typeof req & { $traceId?: string }).$traceId ?? uuidv4();
    const rawBody = req.body;
    if (typeof rawBody !== 'object' || rawBody === null) {
      const vErr = new ValidationError('Body do webhook low-code deve ser um objeto JSON', {
        receivedType: typeof rawBody,
      });
      return reply.status(400).send({ error: vErr.toJSON(), traceId });
    }
    const body = rawBody as {
      event?: unknown;
      prId?: unknown;
      status?: unknown;
      metadata?: unknown;
    };
    const event = typeof body.event === 'string' ? body.event.slice(0, 80) : undefined;
    const prId = typeof body.prId === 'string' ? body.prId.slice(0, 120) : undefined;
    const status = typeof body.status === 'string' ? body.status.slice(0, 80) : undefined;
    const metadata =
      typeof body.metadata === 'object' && body.metadata !== null
        ? (body.metadata as Record<string, unknown>)
        : undefined;

    if (!event && !prId) {
      const vErr = new ValidationError(
        'Webhook low-code requer ao menos um dos campos: event (string) ou prId (string)',
        { received: Object.keys(body) },
      );
      return reply.status(400).send({ error: vErr.toJSON(), traceId });
    }

    const log = createChildLogger({ webhook: 'low-code', event, traceId });
    log.info({ prId, status, hasMetadata: Boolean(metadata) }, 'Recebido webhook low-code');

    const entry = auditor.record({
      traceId,
      prId: prId ?? 'webhook-no-prid',
      actor: 'tool',
      action: `WEBHOOK_${event ?? 'UNKNOWN'}`,
      resource: 'low-code-integration',
      metadata: { ...(metadata ?? {}), status },
    });

    if (env.WEBHOOK_URL) {
      log.debug({ target: env.WEBHOOK_URL }, 'Encaminhando para webhook configurado (simulado)');
    }

    return reply.send({
      received: true,
      traceId,
      auditId: entry.auditId,
      echo: { event, prId, status },
    });
  });

  return app;
}

export async function startServer(preferredPort?: number): Promise<{ port: number; host: string }> {
  const app = buildApp();
  const host = '0.0.0.0';
  const startPort = typeof preferredPort === 'number' ? preferredPort : env.PORT;
  const MAX_ATTEMPTS = 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const port = startPort + attempt;
    try {
      await app.listen({ port, host });
      logger.info({ port, host, attempts: attempt + 1 }, 'Servidor iniciado com sucesso');
      process.stdout.write(
        `[code-review-agent] listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n`,
      );
      return { port, host };
    } catch (err) {
      lastErr = err;
      const isAddrInUse =
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'EADDRINUSE';
      if (!isAddrInUse) break;
      const msg = `Porta ${port} ocupada (EADDRINUSE). Tentando proxima porta em 250ms... (tentativa ${attempt + 1}/${MAX_ATTEMPTS})`;
      process.stderr.write(`[warn code-review-agent] ${msg}\n`);
      try {
        logger.warn({ port, attempts: attempt + 1, max: MAX_ATTEMPTS }, msg);
      } catch {
        /* noop - fallback stderr sincrono já escreveu */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const msg =
    lastErr instanceof Error
      ? lastErr.stack || lastErr.message
      : String(lastErr ?? 'Falha desconhecida ao iniciar servidor');
  process.stderr.write(`[FATAL CODE-REVIEW-AGENT startServer()] ${msg}\n`);
  try {
    logger.error(
      { attempts: MAX_ATTEMPTS, error: msg },
      'Falha ao fazer listen do servidor apos multiplas tentativas',
    );
  } catch {
    /* noop: fallback sincrono ja escreveu em stderr */
  }
  await app.close().catch(() => null);
  throw lastErr instanceof Error ? lastErr : new Error(msg);
}

const isMainModule = (() => {
  try {
    if (typeof process === 'undefined' || !process.argv || process.argv.length < 2) return false;
    if (!import.meta || !import.meta.url) return false;
    const invokedUrl = pathToFileURL(process.argv[1] as string).href;
    return import.meta.url === invokedUrl;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  startServer().catch((err) => {
    const msg = err && err.stack ? err.stack : String(err);
    try {
      logger.error({ error: msg }, 'Falha ao subir servidor');
    } catch {
      /* noop: fallback caso o logger ainda nao esteja disponivel */
      process.stderr.write('[FATAL CODE-REVIEW-AGENT] ' + msg + '\n');
    }
    setTimeout(() => process.exit(1), 50);
  });
}
