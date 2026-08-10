import { v4 as uuidv4 } from 'uuid';
import type { AgentState, GraphStep, NodeName, ToolCallRecord } from '../types/index.js';
import {
  ValidationError,
  MaxStepsExceededError,
  HumanApprovalRequiredError,
  SecurityError,
} from '../errors/AppError.js';
import { PullRequestInputSchema, type PullRequestInput } from '../schemas/index.js';
import { createChildLogger } from '../observability/logger.js';
import { auditor } from '../observability/auditor.js';
import { securityGuard, newTraceId } from '../security/guard.js';
import { staticAnalysisTool } from '../tools/staticAnalysisTool.js';
import { memoryStore } from '../memory/store.js';
import {
  assessRisk,
  aggregateMetrics,
  computeFinalScore,
  generateTestSuggestions,
  generateRecommendations,
} from '../domain/analysis.js';
import type { Finding, ReviewResult } from '../schemas/index.js';
import { env } from '../config/env.js';

type NodeFn = (state: AgentState) => Promise<Partial<AgentState>>;
type EdgeFn = (state: AgentState) => NodeName | 'END';

export const INITIAL_NODE: NodeName = 'INPUT_VALIDATION';
const TERMINAL_NODE = 'FINAL_REPORT';

function emptyState(input: PullRequestInput, traceId: string): AgentState {
  return {
    traceId,
    requestId: input.requestId ?? uuidv4(),
    prId: input.prId,
    input: {
      repository: input.repository,
      author: input.author,
      title: input.title,
      description: input.description,
      files: input.files.map((f) => ({
        path: f.path,
        content: f.content,
        diff: f.diff,
        additions: f.additions,
        deletions: f.deletions,
      })),
      priority: input.priority,
    },
    currentNode: INITIAL_NODE,
    steps: [],
    staticFindings: [],
    llmFindings: [],
    metrics: {
      totalFiles: 0,
      totalAdditions: 0,
      totalDeletions: 0,
      filesAnalyzed: 0,
      complexityScore: 0,
      testCoverageEstimate: 0,
      securityScore: 100,
      maintainabilityScore: 100,
    },
    risk: { level: 'low', score: 0, factors: [], recommendation: '' },
    adversarial: { safe: true, threats: [] },
    recommendations: [],
    testSuggestions: [],
    risks: [],
    humanApproval: { required: false, granted: false },
    memory: { loaded: false, historicalFindings: [] },
    toolCalls: [],
    errors: [],
  };
}

function stepStart(state: AgentState, node: NodeName): AgentState {
  state.steps.push({
    node,
    startedAt: new Date().toISOString(),
    status: 'running',
  });
  state.currentNode = node;
  return state;
}

function stepEnd(
  state: AgentState,
  node: NodeName,
  status: GraphStep['status'],
  outputSummary?: string,
  error?: string,
): AgentState {
  const step = state.steps.find((s) => s.node === node && s.status === 'running');
  if (step) {
    step.finishedAt = new Date().toISOString();
    step.status = status;
    step.durationMs = new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime();
    step.outputSummary = outputSummary;
    step.error = error;
  }
  return state;
}

export const nodes: Record<NodeName, NodeFn> = {
  INPUT_VALIDATION: async (state) => {
    const log = createChildLogger({
      traceId: state.traceId,
      prId: state.prId,
      node: 'INPUT_VALIDATION',
    });
    log.info('Validando entrada do PR');

    const parsed = PullRequestInputSchema.safeParse({
      prId: state.prId,
      repository: state.input.repository,
      author: state.input.author,
      title: state.input.title,
      description: state.input.description,
      branch: 'feature',
      baseBranch: 'main',
      files: state.input.files,
      requestId: state.requestId,
      priority: state.input.priority,
    });
    if (!parsed.success) {
      const msg = 'Entrada do PR invalida na validacao schemaless';
      log.error({ issues: parsed.error.issues }, msg);
      throw new ValidationError(msg, parsed.error.flatten());
    }

    auditor.record({
      traceId: state.traceId,
      prId: state.prId,
      actor: 'system',
      action: 'INPUT_VALIDATED',
      resource: `pr:${state.prId}`,
      metadata: { filesCount: state.input.files.length, priority: state.input.priority },
    });

    return {
      metrics: aggregateMetrics(state.input.files, []),
    };
  },

  ADVERSARIAL_CHECK: async (state) => {
    const log = createChildLogger({
      traceId: state.traceId,
      prId: state.prId,
      node: 'ADVERSARIAL_CHECK',
    });
    log.info('Executando verificacao adversarial');

    const blob =
      state.input.title +
      '\n' +
      state.input.description +
      '\n' +
      state.input.files.map((f) => f.path + '\n' + f.content).join('\n---\n');

    const check = securityGuard.checkAdversarial(blob, state.traceId, state.prId);
    const threatsLimit = 5;
    if (check.threats.length >= threatsLimit) {
      securityGuard.assertSafe(check, state.traceId, state.prId, threatsLimit);
    }

    const threatsOut = check.threats.slice();
    if (threatsOut.length > 0) {
      log.warn({ threats: threatsOut }, 'Ameacas detectadas (continuando com sanitizacao)');
    }

    const approvalForcedByPolicy = threatsOut.length >= 2;
    return {
      adversarial: {
        safe: check.safe,
        threats: threatsOut,
      },
      humanApproval: {
        required: approvalForcedByPolicy || state.humanApproval.required,
        granted: state.humanApproval.granted,
        reason: approvalForcedByPolicy
          ? 'Politica: entrada com 2+ ameacas adversariais detectadas. Aprovacao humana obrigatoria.'
          : state.humanApproval.reason,
      },
      risks:
        threatsOut.length > 0
          ? ['Entrada contem padroes adversariais detectados pelo guard de seguranca.']
          : [],
    };
  },

  RISK_ASSESSMENT: async (state) => {
    const log = createChildLogger({
      traceId: state.traceId,
      prId: state.prId,
      node: 'RISK_ASSESSMENT',
    });
    log.info('Avaliando risco inicial do PR');

    const authorKey = state.input.author;
    const authorHistory = memoryStore.getAuthorHistoryByKey(authorKey);

    const criticalCount = [...state.staticFindings, ...state.llmFindings].filter(
      (f) => f.severity === 'critical',
    ).length;

    const risk = assessRisk({
      filesCount: state.input.files.length,
      additions: state.metrics.totalAdditions,
      deletions: state.metrics.totalDeletions,
      priority: state.input.priority,
      historical: authorHistory,
      criticalFindingsCount: criticalCount,
    });

    const approvalRequired =
      env.HUMAN_APPROVAL_REQUIRED &&
      (risk.level === 'critical' || risk.level === 'high' || state.adversarial.threats.length >= 1);

    auditor.record({
      traceId: state.traceId,
      prId: state.prId,
      actor: 'system',
      action: 'RISK_ASSESSMENT',
      resource: `pr:${state.prId}`,
      decision: risk.level,
      metadata: { riskScore: risk.score, humanApprovalRequired: approvalRequired },
    });

    return {
      risk,
      humanApproval: {
        required: approvalRequired,
        granted: false,
        reason: approvalRequired ? risk.recommendation : undefined,
      },
    };
  },

  STATIC_ANALYSIS: async (state) => {
    const log = createChildLogger({
      traceId: state.traceId,
      prId: state.prId,
      node: 'STATIC_ANALYSIS',
    });
    log.info('Executando analise estatica (tool)');

    const callStart = new Date().toISOString();
    const callRecord: ToolCallRecord = {
      toolName: 'static_code_analysis',
      startedAt: callStart,
      attempt: 1,
      success: false,
      inputHash: uuidv4(),
    };

    try {
      const result = await staticAnalysisTool.withRetry({
        files: state.input.files.map((f) => ({
          path: f.path,
          content: f.content,
          diff: f.diff,
          additions: f.additions,
          deletions: f.deletions,
        })),
        traceId: state.traceId,
        prId: state.prId,
      });

      callRecord.finishedAt = new Date().toISOString();
      callRecord.durationMs =
        new Date(callRecord.finishedAt).getTime() - new Date(callStart).getTime();
      callRecord.success = true;

      const newMetrics = aggregateMetrics(state.input.files, result.findings);

      return {
        staticFindings: result.findings,
        toolCalls: [...state.toolCalls, callRecord],
        metrics: { ...state.metrics, ...newMetrics },
      };
    } catch (err) {
      callRecord.finishedAt = new Date().toISOString();
      callRecord.success = false;
      callRecord.error = (err as Error).message;
      log.error({ error: (err as Error).message }, 'Falha na ferramenta de analise estatica');
      return {
        toolCalls: [...state.toolCalls, callRecord],
        errors: [...state.errors, `STATIC_ANALYSIS_TOOL_FAIL: ${(err as Error).message}`],
      };
    }
  },

  LLM_ANALYSIS: async (state) => {
    const log = createChildLogger({
      traceId: state.traceId,
      prId: state.prId,
      node: 'LLM_ANALYSIS',
    });
    log.info('Executando analise semantica LLM (heuristica + simulacao de LLM offline)');

    const llmFindings: Finding[] = [];
    for (const file of state.input.files) {
      const lines = file.content.split('\n');
      if (
        /require\(['"]child_process['"]\)/.test(file.content) ||
        /\bexec\s*\(/.test(file.content)
      ) {
        llmFindings.push({
          id: uuidv4(),
          file: file.path,
          lineStart: 1,
          lineEnd: Math.max(1, lines.length),
          severity: 'warning',
          category: 'security',
          title: 'Uso de child_process detectado',
          description:
            'Analise semantica identificou uso de subprocessos. Validar entrada e minimizar privilegios.',
          suggestion:
            'Use validacao rigorosa de entrada, escape de argumentos, e considere a opcao shell:false sempre que possivel.',
          confidence: 0.75,
        });
      }
      if (file.content.includes('// TODO') || file.content.includes('// FIXME')) {
        llmFindings.push({
          id: uuidv4(),
          file: file.path,
          lineStart: Math.max(
            1,
            lines.findIndex((l) => l.includes('TODO') || l.includes('FIXME')) + 1,
          ),
          lineEnd: Math.max(
            1,
            lines.findIndex((l) => l.includes('TODO') || l.includes('FIXME')) + 1,
          ),
          severity: 'info',
          category: 'maintainability',
          title: 'Comentario de divida tecnica',
          description:
            'Comentario TODO/FIXME encontrado; revisar se pode ser resolvido antes do merge.',
          confidence: 0.9,
        });
      }
    }

    auditor.record({
      traceId: state.traceId,
      prId: state.prId,
      actor: 'llm',
      action: 'LLM_ANALYSIS_DONE',
      resource: `pr:${state.prId}`,
      metadata: { findingsCount: llmFindings.length },
    });

    return { llmFindings };
  },

  PARALLEL_ANALYSIS: async (state) => {
    const log = createChildLogger({
      traceId: state.traceId,
      prId: state.prId,
      node: 'PARALLEL_ANALYSIS',
    });
    log.info('Executando analises paralelas (heuristica + memoria historica)');

    const rec = memoryStore.getOrCreate(state.prId);
    const authorKey = state.input.author;
    const authorHistory = memoryStore.getAuthorHistoryByKey(authorKey);

    return {
      memory: {
        loaded: true,
        historicalFindings: rec.historicalFindings,
        authorHistory: authorHistory ?? undefined,
      },
    };
  },

  AGGREGATE_RESULTS: async (state) => {
    const log = createChildLogger({
      traceId: state.traceId,
      prId: state.prId,
      node: 'AGGREGATE_RESULTS',
    });
    const allFindings = [...state.staticFindings, ...state.llmFindings];
    const newMetrics = aggregateMetrics(state.input.files, allFindings);

    const authorHistory = state.memory.authorHistory ?? null;
    const criticalCount = allFindings.filter((f) => f.severity === 'critical').length;
    const risk = assessRisk({
      filesCount: state.input.files.length,
      additions: newMetrics.totalAdditions,
      deletions: newMetrics.totalDeletions,
      priority: state.input.priority,
      historical: authorHistory,
      criticalFindingsCount: criticalCount,
    });

    log.info({ findingsCount: allFindings.length, riskLevel: risk.level }, 'Resultados agregados');

    return {
      metrics: { ...state.metrics, ...newMetrics },
      risk,
    };
  },

  GENERATE_RECOMMENDATIONS: async (state) => {
    const allFindings = [...state.staticFindings, ...state.llmFindings];
    const recs = generateRecommendations(allFindings, state.metrics, state.risk);
    const tests = generateTestSuggestions(allFindings, state.input.files);
    const extraRisks: string[] = [];
    if (state.adversarial.threats.length > 0) {
      extraRisks.push(
        `Ameacas adversarial detectadas (${state.adversarial.threats.join(', ')}); revisao manual obrigatoria.`,
      );
    }
    if (state.metrics.securityScore < 70) {
      extraRisks.push('Score de seguranca abaixo do limite recomendado (70).');
    }
    if (state.risk.factors.length > 0) {
      extraRisks.push(`Fatores de risco: ${state.risk.factors.join('; ')}.`);
    }

    return {
      recommendations: recs,
      testSuggestions: tests,
      risks: Array.from(new Set([...state.risks, ...extraRisks])),
    };
  },

  HUMAN_APPROVAL_CHECK: async (state) => {
    const log = createChildLogger({
      traceId: state.traceId,
      prId: state.prId,
      node: 'HUMAN_APPROVAL_CHECK',
    });

    if (!state.humanApproval.required) {
      log.info('Aprovacao humana nao requerida para este PR');
      return { humanApproval: { ...state.humanApproval, granted: true } };
    }

    const allFindings = [...state.staticFindings, ...state.llmFindings];
    const hasCritical = allFindings.some((f) => f.severity === 'critical');
    const score = computeFinalScore(state.metrics, state.risk, allFindings.length);

    if (hasCritical || score < 50 || state.risk.level === 'critical') {
      log.warn(
        { score, hasCritical, riskLevel: state.risk.level },
        'Bloqueado: requer aprovacao humana explicita',
      );
      throw new HumanApprovalRequiredError(
        'Revisao bloqueada. Aprovacao humana OBRIGATORIA antes do merge. Motivo: risco/score/achados criticos.',
        {
          traceId: state.traceId,
          prId: state.prId,
          score,
          riskLevel: state.risk.level,
          hasCritical,
        },
      );
    }

    log.info('Aprovacao humana pendente (politica exige validacao externa)');
    return state;
  },

  FINAL_REPORT: async (state) => {
    const allFindings = [...state.staticFindings, ...state.llmFindings];
    const score = computeFinalScore(state.metrics, state.risk, allFindings.length);

    let status: ReviewResult['status'];
    const needsHuman = state.humanApproval.required && !state.humanApproval.granted;
    if (needsHuman) status = 'pending';
    else if (score >= 75 && state.risk.level !== 'critical') status = 'approved';
    else if (score >= 50) status = 'needs_changes';
    else status = 'rejected';

    const summaryLines: string[] = [];
    summaryLines.push(
      `Revisao concluida para PR #${state.prId} (${state.input.title}). Score final ${score}/100. Status: ${status}.`,
    );
    summaryLines.push(
      `Foram analisados ${state.metrics.filesAnalyzed} arquivos com ${state.metrics.totalAdditions} adicoes e ${state.metrics.totalDeletions} remocoes.`,
    );
    if (allFindings.length > 0) {
      const sevCount = { critical: 0, error: 0, warning: 0, info: 0 } as Record<string, number>;
      for (const f of allFindings) sevCount[f.severity]++;
      summaryLines.push(
        `Total de ${allFindings.length} achados: ${Object.entries(sevCount)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${v} ${k}`)
          .join(', ')}.`,
      );
    }
    if (state.adversarial.threats.length > 0) {
      summaryLines.push(
        `Atencao: ${state.adversarial.threats.length} ameaca(s) adversariais detectadas. Conteudo tratado com sanitizacao.`,
      );
    }

    const finalResult: ReviewResult = {
      prId: state.prId,
      status,
      summary: summaryLines.join(' '),
      score,
      metrics: state.metrics,
      findings: allFindings,
      recommendations: state.recommendations,
      testSuggestions: state.testSuggestions,
      risks: state.risks,
      humanApprovalRequired: state.humanApproval.required,
      reviewedAt: new Date().toISOString(),
      traceId: state.traceId,
    };

    memoryStore.recordReview(state.prId, state.input.author, score, allFindings);

    auditor.record({
      traceId: state.traceId,
      prId: state.prId,
      actor: 'system',
      action: 'FINAL_REPORT_ISSUED',
      resource: `pr:${state.prId}`,
      decision: status,
      metadata: {
        score,
        findingsCount: allFindings.length,
        approvalRequired: state.humanApproval.required,
      },
    });

    return { finalResult };
  },
};

export const edges: Record<NodeName, EdgeFn> = {
  INPUT_VALIDATION: () => 'ADVERSARIAL_CHECK',
  ADVERSARIAL_CHECK: () => 'STATIC_ANALYSIS',
  STATIC_ANALYSIS: () => 'PARALLEL_ANALYSIS',
  PARALLEL_ANALYSIS: () => 'LLM_ANALYSIS',
  LLM_ANALYSIS: () => 'AGGREGATE_RESULTS',
  AGGREGATE_RESULTS: () => 'RISK_ASSESSMENT',
  RISK_ASSESSMENT: (s) =>
    s.errors.length > 0 ? 'GENERATE_RECOMMENDATIONS' : 'GENERATE_RECOMMENDATIONS',
  GENERATE_RECOMMENDATIONS: () => 'HUMAN_APPROVAL_CHECK',
  HUMAN_APPROVAL_CHECK: (s) =>
    s.humanApproval.required && !s.humanApproval.granted ? 'FINAL_REPORT' : 'FINAL_REPORT',
  FINAL_REPORT: () => 'END',
};

function mergeState(base: AgentState, patch: Partial<AgentState>): AgentState {
  for (const k of Object.keys(patch) as Array<keyof typeof patch>) {
    const v = patch[k];
    if (v !== undefined) {
      (base as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return base;
}

export interface RunGraphOptions {
  maxSteps?: number;
  humanGrantedOverride?: boolean;
}

export async function runGraph(
  rawInput: PullRequestInput,
  opts: RunGraphOptions = {},
): Promise<AgentState> {
  const maxSteps = opts.maxSteps ?? env.MAX_GRAPH_STEPS;
  const parsed = PullRequestInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError('Entrada do PullRequestInput invalida', parsed.error.flatten());
  }
  const traceId = newTraceId();
  const state = emptyState(parsed.data, traceId);

  const log = createChildLogger({ traceId, prId: state.prId });
  log.info(
    { priority: state.input.priority, filesCount: state.input.files.length },
    'Iniciando execucao do grafo',
  );

  let current: NodeName = INITIAL_NODE;
  let stepsExecuted = 0;

  while (current !== (TERMINAL_NODE as NodeName)) {
    if (stepsExecuted >= maxSteps) {
      stepEnd(state, current, 'failed', undefined, 'MAX_STEPS_EXCEEDED');
      throw new MaxStepsExceededError(
        `Limite maximo de ${maxSteps} passos excedido no grafo; loop potencial detectado`,
        { traceId, prId: state.prId, executedSteps: stepsExecuted },
      );
    }

    const fn = nodes[current];
    if (!fn) {
      throw new ValidationError(`Node desconhecido: ${current}`);
    }

    stepStart(state, current);
    stepsExecuted++;

    try {
      let patch: Partial<AgentState>;
      if (current === 'PARALLEL_ANALYSIS') {
        const [p1, p2] = await Promise.all([
          nodes.PARALLEL_ANALYSIS(state),
          (async (): Promise<Partial<AgentState>> => {
            const parallelRiskPrelim = assessRisk({
              filesCount: state.input.files.length,
              additions: state.input.files.reduce((s, f) => s + f.additions, 0),
              deletions: state.input.files.reduce((s, f) => s + f.deletions, 0),
              priority: state.input.priority,
              historical: state.memory.authorHistory ?? null,
              criticalFindingsCount: state.staticFindings.filter((f) => f.severity === 'critical')
                .length,
            });
            return {
              risks: [
                ...state.risks,
                ...(parallelRiskPrelim.factors.length >= 3
                  ? [
                      `Analise paralela: multiplos fatores de risco levantados (${parallelRiskPrelim.factors.length}).`,
                    ]
                  : []),
              ],
            };
          })(),
        ]);
        patch = {
          ...p1,
          ...p2,
          risks: Array.from(new Set([...(p1.risks ?? []), ...(p2.risks ?? state.risks)])),
        };
      } else if (current === 'HUMAN_APPROVAL_CHECK' && opts.humanGrantedOverride === true) {
        patch = { humanApproval: { ...state.humanApproval, granted: true } };
      } else {
        patch = await fn(state);
      }
      mergeState(state, patch);
      stepEnd(state, current, 'success');
    } catch (err) {
      const msg = (err as Error).message;
      const isHumanApproval = err instanceof HumanApprovalRequiredError;
      if (isHumanApproval) {
        log.info({ node: current }, 'Politica de aprovacao humana aplicada (pendente)');
        const step = state.steps.find((s) => s.node === current && s.status === 'running');
        if (step) {
          step.status = 'success';
          step.finishedAt = new Date().toISOString();
          step.durationMs =
            new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime();
          step.outputSummary =
            'Aprovacao humana requerida pela politica; grafo continuara para relatorio pendente.';
        }
        state.errors = [...state.errors, msg];
        current = 'FINAL_REPORT';
        continue;
      }
      log.error({ node: current, error: msg }, 'Node falhou');
      stepEnd(state, current, 'failed', undefined, msg);
      const isPolicyError =
        err instanceof SecurityError ||
        err instanceof ValidationError ||
        (err as Error).name === 'PolicyViolationError';
      state.errors = [...state.errors, `${current}_FAIL: ${msg}`];
      if (current === 'FINAL_REPORT') throw err;
      if (isPolicyError) {
        const edgeFn = edges[current];
        const next = edgeFn(state);
        current =
          next === 'END' || next === TERMINAL_NODE
            ? ('FINAL_REPORT' as NodeName)
            : (next as NodeName);
      } else {
        current = 'GENERATE_RECOMMENDATIONS';
      }
      continue;
    }

    const edgeFn = edges[current];
    const next = edgeFn(state);
    if (next === TERMINAL_NODE || next === 'END') break;
    current = next;
  }

  if (!state.finalResult) {
    const existing = state.steps.find((s) => s.node === TERMINAL_NODE && s.status !== 'pending');
    if (!existing) stepStart(state, TERMINAL_NODE);
    try {
      const finalPatch = await nodes.FINAL_REPORT(state);
      mergeState(state, finalPatch);
      if (!existing) stepEnd(state, TERMINAL_NODE, 'success');
    } catch (err) {
      if (!existing) stepEnd(state, TERMINAL_NODE, 'failed', undefined, (err as Error).message);
      throw err;
    }
  }

  log.info(
    {
      score: state.finalResult?.score,
      status: state.finalResult?.status,
      stepsCount: stepsExecuted,
    },
    'Grafo concluido com sucesso',
  );
  return state;
}
