import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { runGraph } from '../../src/agent/graph.js';
import type { PullRequestInput } from '../../src/schemas/index.js';
import { env } from '../../src/config/env.js';

function buildSample(): PullRequestInput {
  return {
    prId: 'PR-TEST-LLM-' + uuidv4().slice(0, 6),
    repository: 'corp/test-llm',
    author: 'tester',
    title: 'fix: integração LLM real',
    description: 'Ajuste de provider com fallback heurístico.',
    branch: 'fix/llm-real',
    baseBranch: 'main',
    priority: 'medium',
    files: [
      {
        path: 'src/index.js',
        content: `
import jwt from 'jsonwebtoken';
const SECRET = '__INTERNAL_SECRET_PLACEHOLDER_DO_NOT_USE__';
export function run(payload) {
  // TODO: validar assinatura
  return jwt.sign(payload, SECRET);
}
        `.trim(),
        diff: `@@ -1,2 +1,8 @@
+import jwt from 'jsonwebtoken';
+const SECRET = '__INTERNAL_SECRET_PLACEHOLDER_DO_NOT_USE__';
+export function run(payload) { /* todo */ }
`,
        additions: 8,
        deletions: 2,
      },
    ],
  };
}

describe('Graph - LLM providers (chamada externa real)', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...env };

  beforeEach(() => {
    Object.assign(env, originalEnv);
    delete (env as Partial<typeof env>).LLM_PROVIDER;
    env.LLM_PROVIDER = 'openai';
    env.OPENAI_API_KEY = '';
    env.GOOGLE_API_KEY = '';
  });

  afterEach(() => {
    Object.assign(env, originalEnv);
    global.fetch = originalFetch;
  });

  it('chama OpenAI via REST quando LLM_PROVIDER=openai e há chave válida', async () => {
    env.LLM_PROVIDER = 'openai';
    env.OPENAI_API_KEY = 'sk-integration-stub';
    env.OPENAI_MODEL = 'gpt-4o-mini';
    env.HUMAN_APPROVAL_REQUIRED = false;

    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-stub',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  findings: [
                    {
                      file: 'src/index.js',
                      lineStart: 2,
                      lineEnd: 2,
                      severity: 'error',
                      category: 'security',
                      title: 'Secret placeholder detectado',
                      description: 'Chave hardcoded em formato placeholder detectada.',
                      suggestion: 'Mover para variável de ambiente.',
                      confidence: 0.98,
                    },
                  ],
                }),
              },
              finish_reason: 'stop',
            },
          ],
          model: 'gpt-4o-mini',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    global.fetch = fetcher as typeof global.fetch;

    const state = await runGraph(buildSample());

    expect(fetcher).toHaveBeenCalledTimes(1);
    const calledUrl = (fetcher.mock.calls[0] as [RequestInfo, RequestInit?])[0] as string;
    expect(calledUrl.toString()).toContain('api.openai.com/v1/chat/completions');
    const llmF = state.llmFindings.find((f) => f.ruleId === 'LLM_SEMANTIC_REVIEW');
    expect(llmF).toBeDefined();
    expect(llmF?.severity).toBe('error');
    expect(llmF?.category).toBe('security');
  });

  it('chama Gemini REST via generateContent quando LLM_PROVIDER=gemini e GOOGLE_API_KEY', async () => {
    env.LLM_PROVIDER = 'gemini';
    env.GOOGLE_API_KEY = 'GOOGLE-STUB-INTEGRATION-TOKEN';
    env.GOOGLE_MODEL = 'gemini-1.5-flash';
    env.HUMAN_APPROVAL_REQUIRED = false;

    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      findings: [
                        {
                          file: 'src/index.js',
                          lineStart: 2,
                          lineEnd: 2,
                          severity: 'critical',
                          category: 'security',
                          title: 'Gemini detectou segredo hardcoded',
                          description:
                            'Gemini REST identificou placeholder como segredo em src/index.js.',
                          suggestion: 'Usar variável de ambiente e documentar no .env.example.',
                          confidence: 0.99,
                        },
                      ],
                    }),
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 40 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    global.fetch = fetcher as typeof global.fetch;

    const state = await runGraph(buildSample());

    expect(fetcher).toHaveBeenCalledTimes(1);
    const calledUrl = (fetcher.mock.calls[0] as [RequestInfo, RequestInit?])[0] as string;
    expect(calledUrl.toString()).toContain('generativelanguage.googleapis.com');
    expect(calledUrl.toString()).toContain('generateContent');
    const llmF = state.llmFindings.find((f) => f.ruleId === 'LLM_SEMANTIC_REVIEW');
    expect(llmF).toBeDefined();
    expect(llmF?.severity).toBe('critical');
    expect(llmF?.title).toContain('Gemini');
  });

  it('faz fallback para heurística quando a chamada externa falha (LLM_FAILURE_GUARD)', async () => {
    env.LLM_PROVIDER = 'openai';
    env.OPENAI_API_KEY = 'sk-integration-stub';
    env.HUMAN_APPROVAL_REQUIRED = false;

    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response('{"error":{"message":"Rate limited"}}', {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );

    global.fetch = fetcher as typeof global.fetch;

    const state = await runGraph(buildSample());

    expect(fetcher).toHaveBeenCalledTimes(1);
    const hasHeuristic = state.llmFindings.some(
      (f) =>
        f.title === 'Uso de child_process detectado' || f.title === 'Comentario de divida tecnica',
    );
    expect(hasHeuristic).toBe(true);
    const errorLogged = state.errors.some((e) => e.startsWith('LLM_ANALYSIS_FAIL:'));
    expect(errorLogged).toBe(true);
  });
});
