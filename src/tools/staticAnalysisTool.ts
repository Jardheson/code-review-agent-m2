import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { ToolExecutionError, ValidationError } from '../errors/AppError.js';
import { FileDiffSchema, type Category, type Finding, type Severity } from '../schemas/index.js';
import type { FileDiff } from '../schemas/index.js';
import { logger } from '../observability/logger.js';
import { auditor } from '../observability/auditor.js';
import { env } from '../config/env.js';

const StaticAnalysisInputSchema = z.object({
  files: z.array(FileDiffSchema).min(1),
  traceId: z.string().uuid(),
  prId: z.string().min(1),
});

type StaticAnalysisInput = z.infer<typeof StaticAnalysisInputSchema>;

interface PatternRule {
  id: string;
  name: string;
  category: Category;
  severity: Severity;
  regex: RegExp;
  description: (match: RegExpMatchArray, file: string) => string;
  suggestion?: (match: RegExpMatchArray, file: string) => string;
  confidence: number;
}

const RULES: PatternRule[] = [
  {
    id: 'HARDCODED_SECRET',
    name: 'Hardcoded Secret Detected',
    category: 'security',
    severity: 'critical',
    regex:
      /(?:(?:api[_-]?key|password|secret|token|authorization|credential|pat)\s*[:=]\s*["'`])([^"'`]{4,})["'`]|(["'`])(sk-|ghp_|gho_|ghs_|ghu_|xox[baprs]-|eyJ[A-Za-z0-9_-]{10,})\3|__[A-Z0-9_]+(?:KEY|TOKEN|PAT|SECRET|PASSWORD|CREDENTIAL)__(?:_DO_NOT_USE(?:_IN_PRODUCTION)?)?/i,
    description: (_, file) =>
      `Possivel chave secreta hardcoded ou placeholder de credencial encontrada no arquivo ${file}. Credenciais reais nao devem ser versionadas no codigo.`,
    suggestion: () =>
      'Mova a credencial para variaveis de ambiente, secret manager ou cofre seguro. Utilize .env com gitignore.',
    confidence: 0.9,
  },
  {
    id: 'SQL_INJECTION_RISK',
    name: 'SQL Injection Risk',
    category: 'security',
    severity: 'error',
    regex:
      /(?:\bSELECT\b.*\bFROM\b|\bquery\s*\(|\bexecute\s*\()[\s\S]{0,200}(?:\$\{[^}]+\}|["']\s*\+\s*\w+|\w+\s*\+\s*["'])/i,
    description: (_, file) =>
      `Risco de SQL Injection detectado no arquivo ${file}. Concatenacao/interpolacao de strings em consulta SQL.`,
    suggestion: () =>
      'Utilize parametros preparados (prepared statements / parameterized queries) ou query builders seguros.',
    confidence: 0.8,
  },
  {
    id: 'CONSOLE_LOG_IN_PROD',
    name: 'Console.log em codigo de producao',
    category: 'maintainability',
    severity: 'warning',
    regex: /console\.(log|debug|info|warn|error|trace)\s*\(/,
    description: (_, file) => `Uso de console.* detectado no arquivo ${file}.`,
    suggestion: () =>
      'Utilize uma biblioteca de logging estruturado (Pino, Winston) com niveis adequados e redacao de dados sensiveis.',
    confidence: 0.9,
  },
  {
    id: 'UNSAFE_EVAL',
    name: 'Uso inseguro de eval()',
    category: 'security',
    severity: 'error',
    regex: /\beval\s*\(/,
    description: (_, file) => `Uso de eval() detectado no arquivo ${file}.`,
    suggestion: () =>
      'Evite eval(). Utilize JSON.parse, new Function com escopo controlado, ou refatore para logica explicita.',
    confidence: 0.95,
  },
  {
    id: 'TODO_FIXME',
    name: 'TODO / FIXME pendente',
    category: 'maintainability',
    severity: 'info',
    regex: /(TODO|FIXME|HACK|XXX)(?::|\s|$)/,
    description: (m, file) =>
      `Comentario pendente "${m[0]}" encontrado no arquivo ${file}. Deve ser resolvido antes do merge.`,
    confidence: 0.8,
  },
  {
    id: 'EMPTY_CATCH',
    name: 'Catch vazio ou supressao de erro',
    category: 'bug_risk',
    severity: 'warning',
    regex: /catch\s*\([^)]*\)\s*\{\s*\}/,
    description: (_, file) => `Bloco catch vazio detectado no arquivo ${file}.`,
    suggestion: () =>
      'Registre o erro com logging estruturado, faca tratamento adequado ou propague o erro apropriadamente.',
    confidence: 0.9,
  },
  {
    id: 'ANY_TYPE_USAGE',
    name: 'Uso de tipo any',
    category: 'maintainability',
    severity: 'warning',
    regex: /:\s*any(?:\[\])?\b|<any>|as any\b/,
    description: (_, file) => `Uso de tipo "any" detectado no arquivo ${file}.`,
    suggestion: () =>
      'Defina tipos explicitos, use unknown com guardas de tipo, ou generics para manter a seguranca de tipos.',
    confidence: 0.85,
  },
  {
    id: 'COMPLEX_FUNCTION',
    name: 'Funcao muito longa / complexa',
    category: 'maintainability',
    severity: 'warning',
    regex: /(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>)\s*\{[\s\S]{800,}?\}/,
    description: (_, file) => `Funcao com corpo excessivamente longo detectada no arquivo ${file}.`,
    suggestion: () =>
      'Refatore em funcoes menores com responsabilidade unica (SRP). Extraia logica auxiliar e constantes.',
    confidence: 0.65,
  },
  {
    id: 'NO_ERROR_HANDLING_ASYNC',
    name: 'Promise sem tratamento de erro',
    category: 'bug_risk',
    severity: 'error',
    regex: /\b(await\s+)?\w+\s*\([^)]*\)(?!\s*\.catch)(?!\s*\.then\s*\([^,]+,\s*[a-zA-Z_])/,
    description: (_, file) =>
      `Chamada potencialmente assincrona sem .catch() ou try/catch no arquivo ${file}.`,
    suggestion: () =>
      'Envolva chamadas assincronas em try/catch ou encadeie .catch() para tratar rejeicoes.',
    confidence: 0.55,
  },
  {
    id: 'DEPRECATED_NODE_API',
    name: 'API Node depreciada',
    category: 'best_practice',
    severity: 'info',
    regex: /\bnew\s+Buffer\s*\(|\bls\s*--color\b/,
    description: (_, file) => `Uso de API depreciada detectado no arquivo ${file}.`,
    suggestion: () => 'Utilize Buffer.from() / Buffer.alloc() no lugar de new Buffer().',
    confidence: 0.9,
  },
];

export interface StaticAnalysisResult {
  findings: Finding[];
  analyzedCount: number;
  skippedCount: number;
}

export class StaticAnalysisTool {
  public readonly name = 'static_code_analysis';
  public readonly version = '1.0.0';

  public async execute(rawInput: unknown): Promise<StaticAnalysisResult> {
    const parsed = StaticAnalysisInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ValidationError('Entrada invalida para StaticAnalysisTool', parsed.error.flatten());
    }

    const { files, traceId, prId } = parsed.data;

    logger.debug({ traceId, prId, filesCount: files.length }, 'Iniciando analise estatica');

    const findings: Finding[] = [];
    let analyzed = 0;
    let skipped = 0;

    for (const file of files) {
      try {
        const fileFindings = this.analyzeFile(file);
        findings.push(...fileFindings);
        analyzed++;
      } catch (err) {
        skipped++;
        logger.warn(
          { traceId, prId, file: file.path, error: (err as Error).message },
          'Erro ao analisar arquivo (pulando)',
        );
      }
    }

    auditor.record({
      traceId,
      prId,
      actor: 'tool',
      action: 'STATIC_ANALYSIS_COMPLETED',
      resource: `pr:${prId}`,
      metadata: {
        analyzedCount: analyzed,
        skippedCount: skipped,
        findingsCount: findings.length,
        severities: this.countSeverities(findings),
      },
    });

    return { findings, analyzedCount: analyzed, skippedCount: skipped };
  }

  private analyzeFile(file: FileDiff): Finding[] {
    const findings: Finding[] = [];
    const content = file.content;

    for (const rule of RULES) {
      const regex = new RegExp(
        rule.regex.source,
        rule.regex.flags.includes('g') ? rule.regex.flags : rule.regex.flags + 'g',
      );
      let match: RegExpExecArray | null;

      while ((match = regex.exec(content)) !== null) {
        const matchStart = match.index ?? 0;
        const lineStart = content.slice(0, matchStart).split('\n').length;
        const lineEnd = lineStart + (match[0].split('\n').length - 1);

        findings.push({
          id: uuidv4(),
          file: file.path,
          lineStart: Math.max(1, lineStart),
          lineEnd: Math.max(1, lineEnd),
          severity: rule.severity,
          category: rule.category,
          title: rule.name,
          description: rule.description(match, file.path),
          suggestion: rule.suggestion?.(match, file.path),
          ruleId: rule.id,
          confidence: rule.confidence,
        });

        if (findings.length >= 100) break;
      }
    }

    return findings;
  }

  private countSeverities(findings: Finding[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const f of findings) {
      counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    }
    return counts;
  }

  public withRetry(input: StaticAnalysisInput, maxRetries = env.MAX_TOOL_RETRIES) {
    return this.retry(() => this.execute(input), maxRetries, input.traceId, input.prId);
  }

  private async retry<T>(
    fn: () => Promise<T>,
    maxRetries: number,
    traceId: string,
    prId: string,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        auditor.record({
          traceId,
          prId,
          actor: 'tool',
          action: 'TOOL_CALL_ATTEMPT',
          resource: this.name,
          metadata: { attempt, tool: this.name },
        });
        return await fn();
      } catch (err) {
        lastError = err;
        logger.warn(
          { traceId, prId, attempt, maxRetries, error: (err as Error).message },
          'Tentativa de tool falhou',
        );
        if (attempt <= maxRetries) {
          await new Promise((r) => setTimeout(r, Math.min(100 * attempt, 1000)));
        }
      }
    }
    throw new ToolExecutionError(
      `Falha apos ${maxRetries + 1} tentativas na ferramenta ${this.name}`,
      { tool: this.name, error: (lastError as Error).message },
    );
  }
}

export const staticAnalysisTool = new StaticAnalysisTool();
