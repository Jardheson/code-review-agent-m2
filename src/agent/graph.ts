import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { AgentState, GraphStep, NodeName, ToolCallRecord } from '../types/index.js';
import {
  ValidationError,
  MaxStepsExceededError,
  HumanApprovalRequiredError,
  SecurityError,
  ToolExecutionError,
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

function buildLlmFindingSchemas() {
  const LlmFindingSchema = z.object({
    file: z.string().min(1),
    lineStart: z.number().int().min(1),
    lineEnd: z.number().int().min(1),
    severity: z.enum(['info', 'warning', 'error', 'critical']),
    category: z.enum([
      'security',
      'performance',
      'maintainability',
      'style',
      'bug_risk',
      'best_practice',
      'test_coverage',
    ]),
    title: z.string().min(1),
    description: z.string().min(1),
    suggestion: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  });

  const LlmOutSchema = z
    .object({
      findings: z.array(LlmFindingSchema).default([]),
    })
    .passthrough();

  return { LlmFindingSchema, LlmOutSchema };
}

function buildLlmReviewPrompt(state: AgentState): { system: string; user: string } {
  const filesSection = state.input.files
    .map((f) => {
      const diff = (f.diff ?? '').slice(0, 12000);
      return `Arquivo: ${f.path}\nDiff:\n${diff}`;
    })
    .join('\n\n');

  const system = [
    'Voce e um agente de revisao de codigo.',
    'Retorne APENAS JSON valido com a chave "findings" (array). Nao inclua markdown, comentarios ou texto fora do JSON.',
    'Cada finding deve conter as chaves obrigatorias a seguir:',
    '  - file (string): caminho do arquivo analisado.',
    '  - lineStart (inteiro >= 1): linha inicial do problema.',
    '  - lineEnd (inteiro >= lineStart): linha final do problema.',
    '  - severity (enum exato): info | warning | error | critical.',
    '  - category (enum exato): security | performance | maintainability | style | bug_risk | best_practice | test_coverage.',
    '  - title (string): titulo curto do problema.',
    '  - description (string): explicacao detalhada.',
    '  - suggestion (string opcional): como corrigir.',
    '  - confidence (numero 0..1 opcional): nivel de confianca.',
    'Caso identifique um campo simples "line" mapeie para lineStart=line e lineEnd=line.',
    'Caso receba "message" use como description e gere um title curto baseado no message.',
    'Use category=bug_risk por padrao quando nao puder classificar melhor.',
  ].join('\n');

  const user = `PR: ${state.input.title}\nRepo: ${state.input.repository}\nAutor: ${state.input.author}\nPrioridade: ${state.input.priority}\n\nDescricao:\n${state.input.description}\n\n${filesSection}\n\nRetorne JSON: {"findings":[...]} (apenas findings).`;

  return { system, user };
}

function parseFindingsFromJsonBlob(rawText: string): Finding[] {
  const { LlmFindingSchema, LlmOutSchema } = buildLlmFindingSchemas();
  const cleaned = rawText.trim();
  const json = extractJsonFromBlob(cleaned);
  const raw = JSON.parse(json) as unknown;
  const rawObj =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const rawArray = Array.isArray(rawObj?.findings)
    ? ((rawObj as { findings: unknown[] }).findings as Record<string, unknown>[])
    : Array.isArray(raw)
      ? (raw as Record<string, unknown>[])
      : [];

  const normalized = rawArray
    .map((r) => {
      const obj = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      const file = typeof obj.file === 'string' ? obj.file : '';
      const lineStartRaw =
        typeof obj.lineStart === 'number'
          ? Math.max(1, Math.round(obj.lineStart))
          : typeof obj.line === 'number'
            ? Math.max(1, Math.round(obj.line))
            : 1;
      const lineEndRaw =
        typeof obj.lineEnd === 'number'
          ? Math.max(lineStartRaw, Math.round(obj.lineEnd))
          : lineStartRaw;
      const severityRaw =
        typeof obj.severity === 'string' ? obj.severity.toLowerCase().trim() : 'warning';
      const severity: 'info' | 'warning' | 'error' | 'critical' =
        severityRaw === 'critical'
          ? 'critical'
          : severityRaw === 'error' || severityRaw === 'err'
            ? 'error'
            : severityRaw === 'info'
              ? 'info'
              : 'warning';
      const categoryRaw =
        typeof obj.category === 'string' ? obj.category.toLowerCase().trim() : 'bug_risk';
      const allowedCategories = new Set([
        'security',
        'performance',
        'maintainability',
        'style',
        'bug_risk',
        'best_practice',
        'test_coverage',
      ]);
      const category:
        | 'security'
        | 'performance'
        | 'maintainability'
        | 'style'
        | 'bug_risk'
        | 'best_practice'
        | 'test_coverage' = allowedCategories.has(categoryRaw)
        ? (categoryRaw as
            | 'security'
            | 'performance'
            | 'maintainability'
            | 'style'
            | 'bug_risk'
            | 'best_practice'
            | 'test_coverage')
        : 'bug_risk';
      const descriptionRaw =
        typeof obj.description === 'string' && obj.description.trim().length > 0
          ? obj.description.trim()
          : typeof obj.message === 'string' && obj.message.trim().length > 0
            ? obj.message.trim()
            : 'Problema identificado por analise semantica LLM.';
      const titleRaw =
        typeof obj.title === 'string' && obj.title.trim().length > 0
          ? obj.title.trim()
          : descriptionRaw.length <= 100
            ? descriptionRaw
            : descriptionRaw.slice(0, 97) + '...';
      const suggestionRaw =
        typeof obj.suggestion === 'string' && obj.suggestion.trim().length > 0
          ? obj.suggestion.trim()
          : undefined;
      const confidenceRaw =
        typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : undefined;

      return {
        file,
        lineStart: lineStartRaw,
        lineEnd: lineEndRaw,
        severity,
        category,
        title: titleRaw,
        description: descriptionRaw,
        suggestion: suggestionRaw,
        confidence: confidenceRaw,
      };
    })
    .filter((f) => f.file.trim().length > 0);

  const envelope = { findings: normalized };
  const parsed = LlmOutSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new ToolExecutionError('Resposta LLM nao segue schema esperado', {
      issues: parsed.error.issues,
    });
  }

  return parsed.data.findings.map((f) => ({
    id: uuidv4(),
    file: f.file,
    lineStart: f.lineStart,
    lineEnd: f.lineEnd,
    severity: f.severity,
    category: f.category,
    title: f.title,
    description: f.description,
    suggestion: f.suggestion,
    confidence: f.confidence ?? 0.7,
    ruleId: 'LLM_SEMANTIC_REVIEW',
  }));
  void LlmFindingSchema;
}

function extractJsonFromBlob(blob: string): string {
  const trimmed = blob.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const firstOpen = trimmed.indexOf('{');
  const lastClose = trimmed.lastIndexOf('}');
  if (firstOpen >= 0 && lastClose > firstOpen) {
    return trimmed.slice(firstOpen, lastClose + 1);
  }

  const fences = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fences && fences[1] && fences[1].trim().length > 0) {
    return fences[1].trim();
  }

  throw new ToolExecutionError('Resposta LLM sem JSON valido para extracao', {
    body: trimmed.slice(0, 1000),
  });
}

async function callGeminiForFindings(state: AgentState): Promise<Finding[]> {
  if (!env.GOOGLE_API_KEY || env.GOOGLE_API_KEY.trim().length === 0) {
    throw new ToolExecutionError('GOOGLE_API_KEY nao configurada para provedor Gemini', {});
  }

  const { system, user } = buildLlmReviewPrompt(state);
  const body = {
    systemInstruction: {
      role: 'user' as const,
      parts: [{ text: system }],
    },
    contents: [
      {
        role: 'user' as const,
        parts: [{ text: user }],
      },
    ],
    generationConfig: {
      temperature: env.OPENAI_TEMPERATURE,
      candidateCount: 1,
      responseMimeType: 'application/json',
    },
  };

  const base = env.GOOGLE_BASE_URL.replace(/\/+$/, '');
  const version = env.GOOGLE_API_VERSION === 'v1' ? 'v1' : 'v1beta';
  const endpoint = `${base}/${version}/models/${encodeURIComponent(env.GOOGLE_MODEL)}:generateContent?key=${encodeURIComponent(env.GOOGLE_API_KEY)}`;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 20000);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-client': 'code-review-agent-m2/1.0.0',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new ToolExecutionError('Falha ao chamar Gemini para analise LLM', {
        status: res.status,
        body: text.slice(0, 2000),
      });
    }

    const json = JSON.parse(text) as Record<string, unknown> | null;
    const candidates = Array.isArray((json as { candidates?: unknown })?.candidates)
      ? ((json as { candidates: unknown[] }).candidates as Record<string, unknown>[])
      : [];
    if (candidates.length === 0) {
      throw new ToolExecutionError('Resposta da Gemini sem candidates', {
        body: text.slice(0, 2000),
      });
    }

    const first = candidates[0] as Record<string, unknown>;
    const content =
      first && typeof (first as { content?: unknown }).content === 'object'
        ? ((first as { content: Record<string, unknown> }).content as Record<string, unknown>)
        : undefined;
    const parts =
      content && Array.isArray((content as { parts?: unknown }).parts)
        ? ((content as { parts: unknown[] }).parts as Record<string, unknown>[])
        : [];
    const textParts = parts
      .map((p) =>
        p && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '',
      )
      .filter((t) => t.length > 0);
    if (textParts.length === 0) {
      throw new ToolExecutionError('Resposta da Gemini sem parts/text', {
        body: text.slice(0, 2000),
      });
    }

    return parseFindingsFromJsonBlob(textParts.join('\n'));
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAiForFindings(state: AgentState): Promise<Finding[]> {
  if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY.trim().length === 0) {
    throw new ToolExecutionError('OPENAI_API_KEY nao configurada para provedor OpenAI', {});
  }

  const { system, user } = buildLlmReviewPrompt(state);
  const payload = {
    model: env.OPENAI_MODEL,
    temperature: env.OPENAI_TEMPERATURE,
    messages: [
      {
        role: 'system' as const,
        content: system,
      },
      {
        role: 'user' as const,
        content: user,
      },
    ],
    response_format: { type: 'json_object' as const },
  };

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 20000);

  try {
    const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new ToolExecutionError('Falha ao chamar OpenAI para analise LLM', {
        status: res.status,
        body: text.slice(0, 2000),
      });
    }

    const json = JSON.parse(text) as Record<string, unknown> | null;
    const choices = Array.isArray((json as { choices?: unknown })?.choices)
      ? ((json as { choices: unknown[] }).choices[0] as Record<string, unknown> | undefined)
      : undefined;
    const message =
      choices && typeof (choices as { message?: unknown }).message === 'object'
        ? ((choices as { message: Record<string, unknown> }).message as Record<string, unknown>)
        : undefined;
    const content =
      message && typeof (message as { content?: unknown }).content === 'string'
        ? ((message as { content: string }).content as string)
        : undefined;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ToolExecutionError('Resposta da OpenAI sem conteudo JSON', {
        body: text.slice(0, 2000),
      });
    }

    return parseFindingsFromJsonBlob(content);
  } finally {
    clearTimeout(timeout);
  }
}

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

    const llmFindings: Finding[] = [];

    const provider = env.LLM_PROVIDER === 'gemini' ? 'gemini' : 'openai';
    const keyRaw = provider === 'gemini' ? env.GOOGLE_API_KEY : env.OPENAI_API_KEY;
    const llmEnabled = keyRaw.trim().length > 0 && !keyRaw.trim().startsWith('__');

    const canCallExternal = llmEnabled && state.adversarial.threats.length === 0;

    if (canCallExternal) {
      try {
        const call = provider === 'gemini' ? callGeminiForFindings : callOpenAiForFindings;
        const out = await call(state);
        llmFindings.push(...out);
        const model = provider === 'gemini' ? env.GOOGLE_MODEL : env.OPENAI_MODEL;
        log.info({ findingsCount: llmFindings.length, provider, model }, 'Analise LLM concluida');

        auditor.record({
          traceId: state.traceId,
          prId: state.prId,
          actor: 'llm',
          action: 'LLM_ANALYSIS_DONE',
          resource: `pr:${state.prId}`,
          metadata: { findingsCount: llmFindings.length, mode: provider, provider, model },
        });

        return { llmFindings };
      } catch (err) {
        log.warn(
          { error: (err as Error).message, provider },
          'Falha na analise LLM. Fazendo fallback para heuristica local.',
        );
        state.errors.push(`LLM_ANALYSIS_FAIL: ${(err as Error).message}`);
      }
    } else {
      const reason = !llmEnabled
        ? `LLM desabilitado (${provider === 'gemini' ? 'GOOGLE_API_KEY' : 'OPENAI_API_KEY'} ausente/placeholder)`
        : 'LLM bloqueado por seguranca (entrada adversarial)';
      log.info({ reason, provider }, 'Analise LLM externa nao executada; usando heuristica local');
    }

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
            'Analise semantica heuristica identificou uso de subprocessos. Validar entrada e minimizar privilegios.',
          suggestion:
            'Use validacao rigorosa de entrada, escape de argumentos, e considere a opcao shell:false sempre que possivel.',
          confidence: 0.75,
        });
      }
      if (file.content.includes('// TODO') || file.content.includes('// FIXME')) {
        const idx = lines.findIndex((l) => l.includes('TODO') || l.includes('FIXME'));
        const line = Math.max(1, idx + 1);
        llmFindings.push({
          id: uuidv4(),
          file: file.path,
          lineStart: line,
          lineEnd: line,
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
      metadata: {
        findingsCount: llmFindings.length,
        mode: 'heuristic',
        blockedByAdversarial: state.adversarial.threats.length > 0,
      },
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
