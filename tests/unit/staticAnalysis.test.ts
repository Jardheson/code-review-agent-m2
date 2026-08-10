import { describe, it, expect } from 'vitest';
import { staticAnalysisTool } from '../../src/tools/staticAnalysisTool.js';
import { v4 as uuidv4 } from 'uuid';

const BASE = { traceId: uuidv4(), prId: 'PR-TOOL-TEST' };

describe('StaticAnalysisTool', () => {
  it('deve detectar segredo hardcoded', async () => {
    const r = await staticAnalysisTool.execute({
      ...BASE,
      files: [
        {
          path: 'src/config.ts',
          content: `export const secret = 'sk-abc123xyz';\n`,
          diff: `+ export const secret = 'sk-abc123xyz';`,
          additions: 1,
          deletions: 0,
        },
      ],
    });
    const found = r.findings.find((f) => f.ruleId === 'HARDCODED_SECRET');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('critical');
  });

  it('deve detectar console.log', async () => {
    const r = await staticAnalysisTool.execute({
      ...BASE,
      files: [
        {
          path: 'src/app.ts',
          content: `function main() { console.log('starting app'); }`,
          diff: '+ function main() { console.log(...) }',
          additions: 1,
          deletions: 0,
        },
      ],
    });
    const found = r.findings.find((f) => f.ruleId === 'CONSOLE_LOG_IN_PROD');
    expect(found).toBeDefined();
    expect(found?.category).toBe('maintainability');
  });

  it('deve detectar uso de eval', async () => {
    const r = await staticAnalysisTool.execute({
      ...BASE,
      files: [
        {
          path: 'src/utils/eval.ts',
          content: `export function run(code: string) { eval(code); }`,
          diff: '+ export function run(code: string) { eval(code); }',
          additions: 1,
          deletions: 0,
        },
      ],
    });
    const found = r.findings.find((f) => f.ruleId === 'UNSAFE_EVAL');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('error');
  });

  it('deve detectar TODO/FIXME pendente', async () => {
    const r = await staticAnalysisTool.execute({
      ...BASE,
      files: [
        {
          path: 'src/feature.ts',
          content: `// TODO: implementar validacao de permissao\nconst x = 1;`,
          diff: '+ // TODO: implementar validacao',
          additions: 2,
          deletions: 0,
        },
      ],
    });
    const found = r.findings.find((f) => f.ruleId === 'TODO_FIXME');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('info');
  });

  it('deve detectar SQL Injection por concatenacao', async () => {
    const r = await staticAnalysisTool.execute({
      ...BASE,
      files: [
        {
          path: 'src/db/users.ts',
          content: `async function find(email) { return db.query("SELECT * FROM users WHERE email='\${email}'"); }`,
          diff: `+ db.query("SELECT ... email='\${email}'")`,
          additions: 1,
          deletions: 0,
        },
      ],
    });
    const found = r.findings.find((f) => f.ruleId === 'SQL_INJECTION_RISK');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('error');
  });

  it('deve lancar ValidationError para entrada invalida', async () => {
    await expect(
      staticAnalysisTool.execute({ traceId: 'x', prId: 'y', files: [] }),
    ).rejects.toThrow(/Entrada invalida/);
  });

  it('deve rejeitar arquivo com extensao proibida na tool (via StaticAnalysisInputSchema)', async () => {
    try {
      await staticAnalysisTool.execute({
        ...BASE,
        files: [
          {
            path: 'readme.bat',
            content: `echo hello`,
            diff: '',
            additions: 1,
            deletions: 0,
          },
        ],
      });
      expect.fail('deveria ter falhado');
    } catch (err) {
      expect((err as Error).message).toMatch(/Entrada invalida|extensao nao permitida/);
    }
  });
});
