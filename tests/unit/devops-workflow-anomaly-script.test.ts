import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Workflow DevOps Inteligente - análise de anomalias', () => {
  it('usa heredoc com delimitador quoted na etapa de análise IA', () => {
    const workflowPath = path.resolve(process.cwd(), '.github/workflows/devops-inteligente.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    const stepMatch = workflow.match(
      /- name: Analise IA explicativa de anomalias[\s\S]*?(?=\n\s*- name:|\n\s*$)/,
    );

    expect(stepMatch).not.toBeNull();

    const step = stepMatch![0];
    expect(step).toMatch(/node\s+<<\s*'NODE'/);
    expect(step).not.toMatch(/\bnode\s+-e\b/);
    expect(step).toMatch(/fs\.appendFileSync\(['"]\.\/tmp-devops\/ai-analysis\.md['"],\s*`/);
  });
});
