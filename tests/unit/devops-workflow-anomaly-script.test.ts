import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('workflow devops-inteligente', () => {
  it('mantem template literals validos no heredoc node', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/devops-inteligente.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain("node <<'NODE'");
    expect(workflow).toContain(
      "if (slowRuns > 0) anomalySignals.push(`${slowRuns} execucao(oes) com latencia > 150% da media (media ${avg.toFixed(1)}min)`);",
    );
    expect(workflow).toContain(
      "if (recentFail >= 2) anomalySignals.push(`${recentFail} falhas nos ultimos 7 runs (tendencia: ${recencyTrend})`);",
    );
  });
});
