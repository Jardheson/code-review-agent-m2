import { describe, it, expect, afterEach } from 'vitest';
import { StaticAnalysisTool } from '../../src/tools/staticAnalysisTool.js';
import { ToolExecutionError } from '../../src/errors/AppError.js';
import { v4 as uuidv4 } from 'uuid';

const BASE = { traceId: uuidv4(), prId: 'PR-RETRY' };
const SECRET_FILE = {
  path: 'src/secret.ts',
  content: `export const TOKEN = 'sk-example-retry';\n`,
  diff: `+ export const TOKEN = 'sk-example-retry';`,
  additions: 1,
  deletions: 0,
};

describe('StaticAnalysisTool - withRetry / execute fallback', () => {
  const tool = new StaticAnalysisTool();
  const spies: Array<{ restore: () => void }> = [];
  afterEach(() => {
    spies.splice(0).forEach((s) => s.restore());
  });

  it('execute retorna findings validos com severity/file', async () => {
    const r = await tool.execute({ ...BASE, files: [SECRET_FILE] });
    expect(r.analyzedCount).toBe(1);
    expect(r.skippedCount).toBe(0);
    const f = r.findings.find((x) => x.ruleId === 'HARDCODED_SECRET');
    expect(f).toBeDefined();
    expect(f?.file).toBe(SECRET_FILE.path);
    expect(f?.severity).toBe('critical');
    expect(typeof f?.id).toBe('string');
  });

  it('withRetry retorna sucesso na primeira tentativa', async () => {
    const result = await tool.withRetry({ ...BASE, files: [SECRET_FILE] }, 1);
    expect(result.analyzedCount).toBe(1);
  });

  it('withRetry com 2 maxRetries aplica retentativas e retorna sucesso', async () => {
    const patchedTool = new StaticAnalysisTool();
    type Patched = StaticAnalysisTool & {
      retry<T>(fn: () => Promise<T>, maxRetries: number, traceId: string, prId: string): Promise<T>;
      analyzeFile: (f: never) => never[];
    };
    const self = patchedTool as Patched;
    const originalRetry = self.retry.bind(self);
    const originalAnalyze = self.analyzeFile;
    let totalAttempts = 0;
    self.retry = (fn, maxRetries, traceId, prId) => {
      return originalRetry(
        async () => {
          totalAttempts++;
          if (totalAttempts < 3) {
            throw new Error('simula falha temporaria');
          }
          return fn();
        },
        maxRetries,
        traceId,
        prId,
      );
    };
    spies.push({
      restore: () => {
        self.retry = originalRetry;
        self.analyzeFile = originalAnalyze;
      },
    });
    const r = await patchedTool.withRetry({ ...BASE, files: [SECRET_FILE] }, 3);
    expect(totalAttempts).toBe(3);
    expect(r.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('retry interno do tool dispara ToolExecutionError apos falhas repetidas quando auditor lança', async () => {
    const badTool = new StaticAnalysisTool();
    type T = StaticAnalysisTool & {
      analyzeFile: (f: never) => never[];
      countSeverities: (findings: never[]) => Record<string, number>;
    };
    const self = badTool as T;
    const originalAnalyze = self.analyzeFile;
    const originalCount = self.countSeverities;
    // Faz analyze lançar sempre + countSeverities lançar sempre → forçar falha não tratada no for
    self.analyzeFile = () => {
      throw new Error('always fail analyze');
    };
    self.countSeverities = () => {
      throw new Error('always fail count');
    };
    spies.push({
      restore: () => {
        self.analyzeFile = originalAnalyze;
        self.countSeverities = originalCount;
      },
    });
    await expect(badTool.withRetry({ ...BASE, files: [SECRET_FILE] }, 2)).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });

  it('execute lança ValidationError para entrada invalida e nao retorna findings', async () => {
    await expect(tool.execute({ traceId: 'x', prId: 'y', files: [] } as never)).rejects.toThrow(
      /Entrada invalida/,
    );
  });

  it('executa múltiplos arquivos, pula com erro em um e retorna contagens coerentes', async () => {
    const badTool = new StaticAnalysisTool();
    type T = StaticAnalysisTool & { analyzeFile: (f: never) => never[] };
    const self = badTool as T;
    const origAnalyze = self.analyzeFile;
    let i = 0;
    self.analyzeFile = (f: never) => {
      i++;
      if (i === 1) throw new Error('skip me');
      return origAnalyze(f);
    };
    spies.push({
      restore: () => {
        self.analyzeFile = origAnalyze;
      },
    });
    const r = await badTool.execute({
      ...BASE,
      files: [
        { path: 'src/skip.ts', content: '', diff: '', additions: 1, deletions: 0 },
        SECRET_FILE,
      ],
    });
    expect(r.analyzedCount).toBe(1);
    expect(r.skippedCount).toBe(1);
    expect(r.findings.find((x) => x.ruleId === 'HARDCODED_SECRET')).toBeDefined();
  });
});
