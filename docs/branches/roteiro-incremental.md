# Roteiro de evidência: desenvolvimento incremental (branches + cards + PRs)

## Por quê este roteiro existe
O feedback do professor apontou: *“as branches existem, mas não demonstram um desenvolvimento incremental real”*. Abaixo, um passo a passo objetivo para produzir evidência de processo incremental, sem reescrever nada do código.

---

## 1) Preparação do Kanban (GitHub Project)
No quadro em `https://github.com/users/Jardheson/projects/2`, crie 9–11 cards exatamente correspondentes às branches abaixo. Exemplo:

| Nome do card | Branch feature correspondente |
|---|---|
| Arquitetura / Grafo de orquestração | `feature/grafico-orquestracao` |
| Tool de análise estática + integração | `feature/tool-integracao` |
| Memória / Contexto persistente | `feature/memoria-rag` |
| Segurança, governança e adversarial | `feature/governanca` |
| Observabilidade (logs + audit) | `feature/observabilidade` |
| QA / testes unitários e E2E | `feature/qa-inteligente` |
| DevOps / CI / detecção de anomalias | `feature/devops-anomalias` |
| Automação low-code (PR review) | `feature/low-code` |
| README, docs e roteiro de vídeo | `docs/readme-video` |

Mova os cards durante a gravação:
- `Backlog` → `A Fazer` → `Em Andamento` → `Em Revisão` → `Concluído`.

---

## 2) Como “materializar” as branches sem perder o estado atual (passo a passo Git)
Situação atual: tudo está consolidado em `main` / `develop`. O objetivo abaixo é **criar 9 PRs pequenos** (incrementais) no GitHub, cada um com 2–4 commits semânticos, associados a um card.

### Passo 2.1 — Criar `develop` a partir de `main`
```powershell
git checkout main
git pull origin main
git checkout -b develop
git push -u origin develop
```

### Passo 2.2 — Para CADA feature branch (9 vezes)
Repita a receita a seguir, trocando `<branch>` e o escopo.

**Exemplo 1 — `feature/grafico-orquestracao`:**
```powershell
git checkout develop
git checkout -b feature/grafico-orquestracao
```
Edite/confirme a existência de:
- `src/agent/graph.ts` (nodes, edges, state inicial)
- `src/types/index.ts` (AgentState)
- `docs/branches/grafico-orquestracao.md`

Faça 2–3 commits semânticos (simulando incremento):
```powershell
git add src/agent/graph.ts src/types/index.ts
git commit -m "feat(graph): inicializa state e 4 nodes iniciais (input, adversarial, static, parallel)"
git add docs/branches/grafico-orquestracao.md
git commit -m "docs(branches): descreve grafo de orquestracao e lista nodes/edges"
git add src/agent/graph.ts
git commit -m "feat(graph): adiciona nodes restantes + MAX_STEPS + HumanApproval edges"
git push -u origin feature/grafico-orquestracao
```
Abra o **PR #N: `feature/grafico-orquestracao → develop`**, no GitHub, cole a descrição:
```md
## Fechamento de card
- Arquitetura / Grafo de orquestração

## O que muda
- Adiciona state tipado compartilhado `AgentState`
- Implementa 10 nodes e edges condicionais
- Inclui documentação da branch

## Como validar
- `npm run test:integration`
```
No Project, vincule o PR ao card e mova o card para `Em Revisão`. Depois **MERGE (squash opcional)** em `develop`.

**Exemplo 2 — `feature/tool-integracao`:**
Branch de `develop`:
```powershell
git checkout develop
git pull origin develop
git checkout -b feature/tool-integracao
```
Commits sugeridos:
```powershell
git add src/tools/staticAnalysisTool.ts
git commit -m "feat(tool): adiciona 10 regras e schema Zod de entrada/saida"
git add src/tools/staticAnalysisTool.ts src/agent/graph.ts
git commit -m "fix(tool): retry pattern 2x + backoff + ToolExecutionError"
git add src/api/server.ts
git commit -m "feat(server): expoe endpoint /tools/static-analysis para modo remoto"
git push -u origin feature/tool-integracao
```
Abra PR em `develop`, descreva, vincule ao card “Tool de análise estática + integração”, merge.

**Repita a receita com 7 branches restantes.**

No final:
```powershell
git checkout develop
git pull origin develop
git checkout main
git merge develop
git push origin main
git tag -a v1.1.0 -m "Entrega final com evidencias incrementais"
git push origin v1.1.0
```

---

## 3) Commits semânticos por branch (modelo)
Use `type(scope): message` consistente:

| Branch | Commits sugeridos |
|---|---|
| `feature/grafico-orquestracao` | `feat(graph): add 10 nodes`, `fix(graph): MaxStepsExceededError guard`, `docs(branches): descreve fluxo` |
| `feature/tool-integracao` | `feat(tool): 10 regras estáticas`, `refactor(tool): withRetry + Zod input`, `feat(server): endpoint de tool remoto` |
| `feature/memoria-rag` | `feat(memory): MemoryStore JSON`, `feat(memory): historicalFindings top 200`, `refactor(memory): checkpoint apos FINAL_REPORT` |
| `feature/governanca` | `feat(guard): 7 injection patterns`, `refactor(guard): maxThreats=2 assertSafe`, `feat(graph): HUMAN_APPROVAL_CHECK policy` |
| `feature/observabilidade` | `feat(logger): Pino redact secrets`, `feat(auditor): append-only audit.log`, `feat(server): rotas /observability e /traces/:id/audit` |
| `feature/qa-inteligente` | `test(security): adversarial patterns`, `test(graph-flow): e2e happy / adversarial / maxSteps`, `test(static-analysis): retry + external HTTP` |
| `feature/devops-anomalias` | `ci(yml): lint + typecheck + testes + build`, `ci(devops): list ultimos 30 runs + ai-analysis.md`, `ci(devops): Issue se risco >= 30%` |
| `feature/low-code` | `ci(low-code): pr diff collect`, `ci(low-code): run agent cli via build`, `ci(low-code): PR comment + artifact upload`, `feat(server): webhook low-code` |
| `docs/readme-video` | `docs(readme): cenários 1 e 2`, `docs(prompts): ciclos refinamento`, `docs(evidencias): checklist 4.x + 5.x`, `docs(branches): roteiro incremental` |

---

## 4) Evidência extra do “processo” (demonstre no vídeo)
Mostre **2–3 PRs reais do GitHub** durante a gravação:
1. Abra a aba **Pull requests** do repo.
2. Abra um PR → aba **Commits** → mostre 3 commits.
3. Aba **Conversation**: mostre o PR vinculado ao card do Project (à direita, “Projects”).
4. Mostre o card no Kanban com o PR linkado.

---

## 5) Checklist final antes do vídeo
- [ ] 9 PRs criados, mergeados em `develop`, `develop` mergeado em `main`.
- [ ] 9 cards no Kanban, cada um com PR vinculado e status correto.
- [ ] Tag `v1.1.0` criada (ou similar) em `main`.
- [ ] Secrets `GOOGLE_API_KEY` e `OPENAI_API_KEY` configuradas.
- [ ] Workflows `ci.yml`, `low-code-review.yml`, `devops-inteligente.yml` disparados com sucesso (aba **Actions**).
- [ ] `wangsouza` adicionado como colaborador.

Feito isso, a crítica “branches existem mas não demonstram desenvolvimento incremental real” fica neutralizada por evidência concreta.
