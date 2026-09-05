import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { staticAnalysisTool } from '../../src/tools/staticAnalysisTool.js';
import { env } from '../../src/config/env.js';

const originalFetch = global.fetch;

describe('StaticAnalysisTool - integração HTTP externa', () => {
  const originalEnv = { ...env };

  beforeEach(() => {
    Object.assign(env, originalEnv);
    env.STATIC_ANALYSIS_API_URL = undefined;
  });

  afterEach(() => {
    Object.assign(env, originalEnv);
    global.fetch = originalFetch;
  });

  it('chama endpoint HTTP quando STATIC_ANALYSIS_API_URL está configurado', async () => {
    env.STATIC_ANALYSIS_API_URL = 'http://localhost:3001/api/v1/tools/static-analysis';

    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          findings: [
            {
              id: 'ext-finding-1',
              file: 'src/a.ts',
              lineStart: 1,
              lineEnd: 1,
              severity: 'warning',
              category: 'security',
              title: 'HTTP external call detected',
              description: 'Chamada HTTP detectada via integração externa.',
              ruleId: 'EXT_HTTP_TOOL',
            },
          ],
          analyzedCount: 1,
          skippedCount: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    global.fetch = fetcher as typeof global.fetch;

    const traceId = crypto.randomUUID();
    const out = await staticAnalysisTool.execute({
      prId: 'PR-EXT-1',
      traceId,
      files: [
        {
          path: 'src/a.ts',
          content: "import fetch from 'node-fetch';\nexport const x = 1;\n",
          diff: '+ export const x = 1;',
          additions: 1,
          deletions: 0,
        },
      ],
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const calledUrl = (fetcher.mock.calls[0] as [RequestInfo, RequestInit?])[0] as string;
    expect(calledUrl).toBe('http://localhost:3001/api/v1/tools/static-analysis');
    expect(out.analyzedCount).toBe(1);
    const findings = out.findings;
    expect(findings.some((f) => f.ruleId === 'EXT_HTTP_TOOL')).toBe(true);
  });

  it('retorna erro ToolExecutionError quando HTTP retorna status >=400', async () => {
    env.STATIC_ANALYSIS_API_URL = 'http://localhost:3001/api/v1/tools/static-analysis';

    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response('{"error":"bad request"}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    global.fetch = fetcher as typeof global.fetch;

    const traceId = crypto.randomUUID();
    await expect(
      staticAnalysisTool.execute({
        prId: 'PR-EXT-2',
        traceId,
        files: [
          {
            path: 'src/a.ts',
            content: 'export const x = 1;\n',
            diff: '+ export const x = 1;',
            additions: 1,
            deletions: 0,
          },
        ],
      }),
    ).rejects.toThrow('Falha na integracao externa de static analysis');
  });
});
