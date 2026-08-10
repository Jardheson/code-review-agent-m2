import { describe, it, expect } from 'vitest';
import {
  assessRisk,
  aggregateMetrics,
  computeFinalScore,
  generateRecommendations,
  generateTestSuggestions,
} from '../../src/domain/analysis.js';
import type { Finding } from '../../src/schemas/index.js';
import { v4 as uuidv4 } from 'uuid';

function mkFinding(
  severity: Finding['severity'],
  category: Finding['category'],
  file = 'src/x.ts',
): Finding {
  return {
    id: uuidv4(),
    file,
    lineStart: 1,
    lineEnd: 1,
    severity,
    category,
    title: 'x',
    description: 'x',
    confidence: 1,
  };
}

describe('assessRisk', () => {
  it('diff pequeno autor experiente -> low', () => {
    const r = assessRisk({
      filesCount: 2,
      additions: 30,
      deletions: 10,
      priority: 'low',
      historical: { totalReviews: 20, avgScore: 85, commonIssues: ['style'] },
      criticalFindingsCount: 0,
    });
    expect(r.level).toBe('low');
    expect(r.score).toBeLessThan(20);
  });

  it('diff gigante + critical + prioridade critical -> critical', () => {
    const r = assessRisk({
      filesCount: 40,
      additions: 3000,
      deletions: 1200,
      priority: 'critical',
      historical: { totalReviews: 1, avgScore: 40, commonIssues: ['security'] },
      criticalFindingsCount: 3,
    });
    expect(r.level).toBe('critical');
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.recommendation).toMatch(/revisao humana OBRIGATORIA/i);
  });

  it('entrada invalida deve lançar ValidationError', () => {
    expect(() =>
      assessRisk({ filesCount: -1, additions: 0, deletions: 0, priority: 'low' } as never),
    ).toThrow(/Entrada invalida/);
  });
});

describe('aggregateMetrics', () => {
  it('deve penalizar score de seguranca por findings de seguranca', () => {
    const f = [mkFinding('critical', 'security'), mkFinding('error', 'security')];
    const m = aggregateMetrics([{ path: 'a.ts', additions: 10, deletions: 2 }], f);
    expect(m.securityScore).toBeLessThan(80);
  });

  it('metrics inicial sem achados -> scores altos', () => {
    const m = aggregateMetrics([{ path: 'a.ts', additions: 5, deletions: 1 }], []);
    expect(m.securityScore).toBe(100);
    expect(m.maintainabilityScore).toBe(100);
  });
});

describe('computeFinalScore', () => {
  it('score alto -> bom score final', () => {
    const s = computeFinalScore(
      { securityScore: 95, maintainabilityScore: 90, testCoverageEstimate: 80 },
      { score: 10 },
      1,
    );
    expect(s).toBeGreaterThan(70);
  });

  it('risco alto penaliza', () => {
    const good = computeFinalScore(
      { securityScore: 90, maintainabilityScore: 90, testCoverageEstimate: 90 },
      { score: 0 },
      0,
    );
    const bad = computeFinalScore(
      { securityScore: 90, maintainabilityScore: 90, testCoverageEstimate: 90 },
      { score: 80 },
      0,
    );
    expect(bad).toBeLessThan(good);
  });
});

describe('generateTestSuggestions', () => {
  it('sugere teste de seguranca quando ha achados de seguranca', () => {
    const f = [mkFinding('critical', 'security')];
    const s = generateTestSuggestions(f, [{ path: 'src/a.ts' }]);
    expect(s.some((x) => /seguranca|segurança/i.test(x))).toBe(true);
  });

  it('sugere adicionar testes quando nenhum arquivo .test foi modificado', () => {
    const s = generateTestSuggestions([], [{ path: 'src/a.ts' }]);
    expect(s.some((x) => /Nenhum arquivo de teste modificado/i.test(x))).toBe(true);
  });
});

describe('generateRecommendations', () => {
  it('exige resolver criticos antes do merge', () => {
    const recs = generateRecommendations(
      [mkFinding('critical', 'security')],
      { securityScore: 90, maintainabilityScore: 90, complexityScore: 3 },
      { level: 'medium' },
    );
    expect(recs.some((r) => /CRITICO/i.test(r))).toBe(true);
  });

  it('complexidade alta sugere split do PR', () => {
    const recs = generateRecommendations(
      [],
      { securityScore: 100, maintainabilityScore: 100, complexityScore: 8 },
      { level: 'low' },
    );
    expect(recs.some((r) => /split do PR|complexidade/i.test(r))).toBe(true);
  });
});
