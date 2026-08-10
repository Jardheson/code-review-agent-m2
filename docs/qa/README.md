# IA para QA - Evidências

## 1. Revisão de Código Assistida por IA (diff real)

Arquivo alvo: [security/guard.ts](file:///e:/Projeto%20Avaliativo%20-%20M%C3%B3dulo%202/src/security/guard.ts)

Diff analisado (resumo):
```diff
+ export function assertSafe(check, traceId, prId, maxThreats=2): void {
+   if (!check.safe && check.threats.length >= maxThreats) {
+     throw new SecurityError(...);
+   }
+ }
```

### Análise da IA heurística (regras corporativas aplicadas):

| Item | Descrição | Severidade | Ação |
|------|-----------|------------|------|
| `throw new SecurityError` | Diferencia corretamente de ValidationError, segue hierarquia `AppError`. | OK | Mantido |
| `maxThreats=2` default | Limite baixo por padrão, adequado para segurança. | OK | Mantido |
| Tratamento de `undefined` em `threats` | Schema garante `string[]` via Zod, mas adicionar `?? []` defensivo seria melhor. | warning | Coberto via `AdversarialCheckSchema`. |
| Log de auditoria ausente no throw | Auditoria já é gravada no `checkAdversarial`, duplicidade OK. | info | Não necessário. |

---

## 2. Testes Refinados / Gerados com IA

### Cobertura:
- [tests/unit/security.test.ts](file:///e:/Projeto%20Avaliativo%20-%20M%C3%B3dulo%202/tests/unit/security.test.ts) → 8 casos (injeções variadas + limiar assertSafe + policy destrutiva)
- [tests/unit/staticAnalysis.test.ts](file:///e:/Projeto%20Avaliativo%20-%20M%C3%B3dulo%202/tests/unit/staticAnalysis.test.ts) → 7 casos (8 regras + extensao proibida + entrada invalida)
- [tests/integration/graph-flow.test.ts](file:///e:/Projeto%20Avaliativo%20-%20M%C3%B3dulo%202/tests/integration/graph-flow.test.ts) → 3 cenários E2E (feliz / adversarial crítico / max steps)

### Tipo de Teste Prioritário (por risco / criticidade)

**Cenário selecionado:** `Graph E2E - Cenário de risco: entrada adversarial + PR critico` (graph-flow.test.ts)

**Justificativa de prioridade (Risco × Impacto):**
| Fator | Valor | Peso |
|-------|-------|------|
| Probabilidade de ataque adversarial em repositórios reais | Alta (desenvolvedores maliciosos / contas comprometidas) | **5/5** |
| Impacto: se bypassar segurança → segredos vazados / aprovação automática de PR crítico | Catastrófico (credenciais, integridade do código) | **5/5** |
| Detecção por testes manuais é lenta e fácil de omitir | Sim | **5/5** |
| Cobertura atual do cenário | 1 teste E2E + 8 unitários em segurança | 4/5 |

**Conclusão:** Este é o cenário **CRÍTICO (prioridade 0)**. Nenhum merge para main pode ocorrer sem passar por este teste.

---

## 3. Plano de Testes E2E (gerado com suporte de IA heurística)

Entradas:
1. `POST /api/v1/review` com payload de exemplo `SAMPLE` do CLI.
2. `POST /api/v1/review` com payload adversarial (prompt injection + achados criticos).
3. `GET /api/v1/traces/:traceId/audit` para confirmar 2+ sinais correlacionados.

Saídas esperadas:
1. Status 200, `finalResult.status !== 'pending'` (para PR seguro exemplo).
2. `finalResult.status === 'pending'` + `humanApproval.required === true` (cenário inseguro).
3. Auditoria contendo `ADVERSARIAL_DETECTED`, `STATIC_ANALYSIS_COMPLETED` e `FINAL_REPORT_ISSUED`.
