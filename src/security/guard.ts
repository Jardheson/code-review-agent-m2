import { v4 as uuidv4 } from 'uuid';
import { SecurityError } from '../errors/AppError.js';
import type { AdversarialCheck } from '../schemas/index.js';
import { logger } from '../observability/logger.js';
import { auditor } from '../observability/auditor.js';

const INJECTION_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: 'ignore_previous_instructions',
    regex:
      /ignore (as instru[çc][õo]es|todas as instru[çc][õo]es|as regras|previous instructions|all instructions|system prompt|todas as regras|suas instru[çc][õo]es)/i,
  },
  {
    name: 'reveal_system_prompt',
    regex:
      /(revele|mostre|imprima|exiba|print|reveal|show|output).*(o prompt|o system prompt|suas instru[çc][õo]es|your instructions|system prompt|suas regras)/i,
  },
  {
    name: 'role_override',
    regex:
      /(a partir de agora|from now on|agora voc[êe] [ée]|you are now|voc[êe] deve agir como|you must act as|agora voce e|agora você é)/i,
  },
  {
    name: 'external_content_injection',
    regex: /<!\s*--\s*IGNORE/i,
  },
  {
    name: 'secrets_request',
    regex:
      /(vazou|vazar|revelar|leak|disclose|reveal|mostrar|extrair)[\s\S]{0,80}(chave|senha|token|secret|password|credencial|api[.\-_ ]?key)|(chave|senha|token|secret|password|credencial|api[.\-_ ]?key)[\s\S]{0,80}(vazou|vazar|revelar|leak|disclose|reveal|extrair|mostrar)/i,
  },
  {
    name: 'command_injection',
    regex:
      /(;\s*(rm|chmod|curl|wget|eval|exec|bash|sh|cat|nc)\s)|(`.*`)|(\$\(.*\))|(\|\s*(rm|bash|sh))/i,
  },
  {
    name: 'base64_exfiltration',
    regex: /(base64|btoa|atob).*(encode|decode|enviar|send|exfiltrar)/i,
  },
];

const SYSTEM_TOKENS = new Set([
  '---SYSTEM PROMPT END---',
  '---INÍCIO DADOS USUÁRIO---',
  '---FIM DADOS USUÁRIO---',
]);

export class SecurityGuard {
  public checkAdversarial(content: string, traceId: string, prId: string): AdversarialCheck {
    const threats: string[] = [];
    const sanitizedTokens: string[] = [];

    for (const line of content.split('\n')) {
      let safeLine = line;
      for (const token of SYSTEM_TOKENS) {
        safeLine = safeLine.replaceAll(token, '[TOKEN SISTEMA BLOQUEADO]');
      }
      sanitizedTokens.push(safeLine);
    }

    const sanitized = sanitizedTokens.join('\n');

    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.regex.test(sanitized)) {
        threats.push(pattern.name);
        logger.warn(
          { traceId, prId, pattern: pattern.name, match: pattern.regex.source },
          'Padrao adversarial detectado',
        );
      }
    }

    if (threats.length > 0) {
      auditor.record({
        traceId,
        prId,
        actor: 'system',
        action: 'ADVERSARIAL_DETECTED',
        resource: 'pr.input',
        decision: 'BLOCK_SANITIZE',
        metadata: { threats, contentLength: content.length },
      });
    }

    return {
      safe: threats.length === 0,
      threats,
      sanitizedContent: threats.length > 0 ? sanitized : undefined,
    };
  }

  public validateActionPermission(
    action: string,
    resource: string,
    {
      isDestructive,
      requiresHumanApproval,
      traceId,
      prId,
    }: {
      isDestructive: boolean;
      requiresHumanApproval: boolean;
      traceId: string;
      prId: string;
    },
  ): { allowed: boolean; reason?: string } {
    if (isDestructive && requiresHumanApproval) {
      auditor.record({
        traceId,
        prId,
        actor: 'system',
        action: 'POLICY_CHECK',
        resource,
        decision: 'REQUIRES_HUMAN_APPROVAL',
        metadata: { action, destructive: isDestructive },
      });
      return { allowed: false, reason: 'Acao destrutiva requer aprovacao humana' };
    }

    auditor.record({
      traceId,
      prId,
      actor: 'system',
      action: 'POLICY_CHECK',
      resource,
      decision: 'ALLOWED',
      metadata: { action, destructive: isDestructive },
    });
    return { allowed: true };
  }

  public assertSafe(check: AdversarialCheck, traceId: string, prId: string, maxThreats = 2): void {
    if (!check.safe && check.threats.length >= maxThreats) {
      throw new SecurityError(
        'Entrada bloqueada por politicas de seguranca: multiplas ameacas detectadas',
        { threats: check.threats, traceId, prId },
      );
    }
  }
}

export function newTraceId(): string {
  return uuidv4();
}

export const securityGuard = new SecurityGuard();
