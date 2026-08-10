import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { ValidationError } from '../errors/AppError.js';
import type { Category, Finding, RiskAssessment, Severity } from '../schemas/index.js';

export interface HistoricalContext {
  prId: string;
  historicalFindings: Finding[];
  authorHistory: {
    totalReviews: number;
    avgScore: number;
    commonIssues: Category[];
  } | null;
}

const RiskInputSchema = z.object({
  filesCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  historical: z
    .object({
      totalReviews: z.number().int().nonnegative(),
      avgScore: z.number().min(0).max(100),
      commonIssues: z.array(z.string()),
    })
    .nullable(),
  criticalFindingsCount: z.number().int().nonnegative().default(0),
});

type RiskInput = z.infer<typeof RiskInputSchema>;

export function assessRisk(rawInput: unknown): RiskAssessment {
  const parsed = RiskInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError('Entrada invalida para avaliacao de risco', parsed.error.flatten());
  }

  const { filesCount, additions, deletions, priority, historical, criticalFindingsCount } =
    parsed.data;
  let score = 0;
  const factors: string[] = [];

  const size = additions + deletions;
  if (size > 1000) {
    score += 30;
    factors.push(`Diff muito grande (${size} linhas alteradas)`);
  } else if (size > 400) {
    score += 15;
    factors.push(`Diff acima do recomendado (${size} linhas)`);
  }

  if (filesCount > 20) {
    score += 15;
    factors.push(`Muitos arquivos modificados (${filesCount})`);
  }

  const priorityScore: Record<RiskInput['priority'], number> = {
    low: 0,
    medium: 5,
    high: 15,
    critical: 25,
  };
  score += priorityScore[priority];
  if (priorityScore[priority] > 0) factors.push(`Prioridade do PR: ${priority}`);

  if (criticalFindingsCount > 0) {
    score += Math.min(criticalFindingsCount * 10, 30);
    factors.push(`${criticalFindingsCount} achados criticos de seguranca/qualidade`);
  }

  if (historical) {
    if (historical.avgScore < 60) {
      score += 10;
      factors.push(`Historico baixo do autor (media ${historical.avgScore.toFixed(0)}/100)`);
    }
    if (historical.totalReviews < 3) {
      score += 5;
      factors.push('Autor novo / com poucas revisoes historicas');
    }
    if (historical.commonIssues.includes('security') && priority !== 'low') {
      score += 8;
      factors.push('Autor com recorrencia em problemas de seguranca');
    }
  } else {
    score += 5;
    factors.push('Sem historico previo do autor');
  }

  score = Math.min(100, Math.max(0, score));

  let level: RiskAssessment['level'];
  let recommendation: string;
  if (score >= 70) {
    level = 'critical';
    recommendation =
      'Requer revisao humana OBRIGATORIA de dois revisores. Nao aprovar automaticamente. Priorize a resolucao dos achados criticos.';
  } else if (score >= 45) {
    level = 'high';
    recommendation =
      'Requer aprovacao humana. Recomenda-se dividir o PR em menores partes e resolver os principais achados antes do merge.';
  } else if (score >= 20) {
    level = 'medium';
    recommendation =
      'Requer revisao atenta. Verificar os pontos levantados e validar testes de regressao.';
  } else {
    level = 'low';
    recommendation =
      'Risco baixo. Pode seguir o fluxo normal de revisao, mantendo a validacao dos testes e qualidade.';
  }

  return {
    level,
    score,
    factors: factors.length > 0 ? factors : ['Sem fatores de risco relevantes identificados'],
    recommendation,
  };
}

export function aggregateMetrics(
  files: Array<{ additions: number; deletions: number; path: string }>,
  findings: Finding[],
) {
  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
  const totalLines = totalAdditions + totalDeletions || 1;

  const sevWeight: Record<Severity, number> = { info: 1, warning: 3, error: 6, critical: 12 };
  const catWeight: Record<Category, number> = {
    security: 10,
    performance: 4,
    maintainability: 3,
    style: 1,
    bug_risk: 7,
    best_practice: 2,
    test_coverage: 5,
  };

  let penalty = 0;
  for (const f of findings) {
    penalty += sevWeight[f.severity] + catWeight[f.category] * f.confidence;
  }
  const complexityScore = Math.min(
    10,
    Math.round(Math.log10(1 + totalLines / 100) * 5 + penalty / 30),
  );
  const securityDeduction = findings
    .filter((f) => f.category === 'security')
    .reduce((s, f) => s + sevWeight[f.severity] * 2, 0);
  const maintainabilityDeduction = findings
    .filter((f) => f.category === 'maintainability' || f.category === 'bug_risk')
    .reduce((s, f) => s + sevWeight[f.severity], 0);

  const securityScore = Math.max(0, 100 - securityDeduction * 2);
  const maintainabilityScore = Math.max(0, 100 - maintainabilityDeduction * 1.5);
  const testCoverageEstimate = Math.max(
    0,
    Math.min(
      100,
      100 -
        Math.round(
          (files.filter((f) => /\.test\.|\.spec\./.test(f.path)).length === 0 ? 30 : 10) +
            penalty * 0.3,
        ),
    ),
  );

  return {
    totalFiles: files.length,
    totalAdditions,
    totalDeletions,
    filesAnalyzed: files.length,
    complexityScore: Math.min(10, Math.max(0, complexityScore)),
    testCoverageEstimate,
    securityScore: Math.round(securityScore),
    maintainabilityScore: Math.round(maintainabilityScore),
  };
}

export function computeFinalScore(
  metrics: { securityScore: number; maintainabilityScore: number; testCoverageEstimate: number },
  risk: { score: number },
  findingsCount: number,
): number {
  const weightedAvg =
    metrics.securityScore * 0.4 +
    metrics.maintainabilityScore * 0.35 +
    metrics.testCoverageEstimate * 0.25;
  const riskPenalty = risk.score * 0.3;
  const findingsPenalty = Math.min(findingsCount * 0.5, 10);
  return Math.max(0, Math.min(100, Math.round(weightedAvg - riskPenalty - findingsPenalty)));
}

export function generateTestSuggestions(
  findings: Finding[],
  files: Array<{ path: string }>,
): string[] {
  const suggestions: string[] = [];
  const criticalSev = findings.filter((f) => f.severity === 'critical' || f.severity === 'error');
  const hasSecurity = findings.some((f) => f.category === 'security');
  const changedTestFiles = files.filter((f) => /\.test\.|\.spec\./i.test(f.path));

  if (criticalSev.length > 0) {
    suggestions.push(
      `Criar testes unitarios cobrindo explicitamente os ${criticalSev.length} pontos criticos (${criticalSev.map((f) => `${f.file}:L${f.lineStart}`).join(', ')}).`,
    );
  }
  if (hasSecurity) {
    suggestions.push(
      'Adicionar testes de seguranca: entrada adversaria, validacao de parametros, e cobertura de authz/authn quando aplicavel.',
    );
  }
  if (changedTestFiles.length === 0) {
    suggestions.push(
      'Nenhum arquivo de teste modificado. Considerar testes de regressao para o fluxo alterado (happy path + erro).',
    );
  } else {
    suggestions.push(
      `Validar cobertura adicional para ${changedTestFiles.length} arquivos de teste alterados, incluindo casos de borda.`,
    );
  }
  if (files.some((f) => /\.tsx?|\.jsx?$/i.test(f.path))) {
    suggestions.push(
      'Executar testes de integracao/E2E para validar comportamento em fluxo completo.',
    );
  }
  return Array.from(new Set(suggestions)).slice(0, 6);
}

export function generateRecommendations(
  findings: Finding[],
  metrics: { securityScore: number; maintainabilityScore: number; complexityScore: number },
  risk: { level: string },
): string[] {
  const recs: string[] = [];
  const critical = findings.filter((f) => f.severity === 'critical');
  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warning');

  if (critical.length > 0) {
    recs.push(
      `Resolver ${critical.length} problema(s) CRITICO(s) ANTES do merge (seguranca/estabilidade).`,
    );
  }
  if (errors.length > 0) {
    recs.push(`Corrigir ${errors.length} erro(s) de qualidade antes da aprovacao.`);
  }
  if (warns.length > 4) {
    recs.push('Revisar warnings em excesso; considere rodar lint completo antes de submeter.');
  }
  if (metrics.securityScore < 80) {
    recs.push('Priorizar melhorias de seguranca: revisar segredos, sanitizacao e autorizacoes.');
  }
  if (metrics.maintainabilityScore < 70) {
    recs.push(
      'Refatorar para melhorar manutencao: quebrar funcoes longas, tipar anys, limpar TODOs.',
    );
  }
  if (metrics.complexityScore >= 7) {
    recs.push(
      'Complexidade alta detectada. Considerar split do PR em unidades menores para revisao segura.',
    );
  }
  if (risk.level === 'high' || risk.level === 'critical') {
    recs.push('Fluxo recomenda aprovacao multipla / quatro olhos (2 revisores) antes do merge.');
  }
  recs.push('Validar pipeline CI completo: lint, testes (unit + integracao), build sem regressao.');
  return Array.from(new Set(recs)).slice(0, 8);
}

export function newFindingId(): string {
  return uuidv4();
}
