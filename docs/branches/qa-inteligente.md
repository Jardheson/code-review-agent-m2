## feature/qa-inteligente
- Unit tests (59 testes): security, staticAnalysis, analysis, memory, auditor, app-errors, static-analysis-retry
- E2E: tests/integration/graph-flow.test.ts (3 cenarios: feliz, adversarial, resiliencia maxSteps)
- Priorizacao de risco: cenario adversarial E2E considerado CRITICAL (risco de aprovacao automatica de PR injection) -> coberto por E2E + unit

