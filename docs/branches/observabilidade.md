## feature/observabilidade
- Sinal 1 (logs estruturados): Pino com transport file + console, campos: traceId, prId, action, durationMs, level, redact secrets/tokens/passwords
- Sinal 2 (Auditoria JSON-Lines): data/audit.log append-only por traceId com entrada e saida de cada node
- Rotas: GET /api/v1/observability/audit, /api/v1/observability/logs, /api/v1/traces/:traceId/audit

