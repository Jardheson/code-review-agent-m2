import { runGraph } from '../agent/graph.js';
import { PullRequestInputSchema, type PullRequestInput } from '../schemas/index.js';
import { logger } from '../observability/logger.js';
import fs from 'node:fs';

export const SAMPLE: PullRequestInput = {
  prId: 'PR-1001',
  repository: 'corp/my-app',
  author: 'jardheson',
  title: 'feat: adiciona autenticacao JWT no servico de usuarios',
  description:
    'Implementa login, refresh token e middleware de autenticacao. Inclui validacao de role e migracao de schema.',
  branch: 'feature/jwt-auth',
  baseBranch: 'main',
  priority: 'high',
  files: [
    {
      path: 'src/auth/jwt.ts',
      content: `import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-hardcoded-fallback';

export function sign(payload: Record<string, unknown>): string {
  // TODO: trocar HS256 por RS256
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

export function middleware(req: any, res: any, next: any) {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).send({ error: 'missing token' });
    const decoded: any = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    // TODO: log error structure
    return res.status(401).send({ error: 'invalid token' });
  }
}

export const apiKey = 'EXAMPLE_INTERNAL_API_KEY_PLACEHOLDER_DO_NOT_USE_IN_PRODUCTION';
`,
      diff: `@@ -1,3 +1,28 @@
+import jwt from 'jsonwebtoken';
+const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-hardcoded-fallback';`,
      additions: 28,
      deletions: 3,
    },
    {
      path: 'src/db/users.ts',
      content: `import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function findUserByEmail(email: string) {
  const query = \`SELECT * FROM users WHERE email = '\${email}' LIMIT 1\`;
  const result = await pool.query(query);
  return result.rows[0];
}

export function exec(cmd: string) {
  eval(cmd);
}
`,
      diff: `@@ -0,0 +1,15 @@
+import { Pool } from 'pg';
+export async function findUserByEmail(email: string) { ... }`,
      additions: 15,
      deletions: 0,
    },
    {
      path: 'src/auth/auth.test.ts',
      content: `describe('auth middleware', () => {
  it('rejeita sem token', () => { /* placeholder */ });
});
`,
      diff: `@@ -0,0 +1,4 @@
+describe('auth middleware'...`,
      additions: 4,
      deletions: 0,
    },
  ],
};

function printUsage() {
  console.log(`Uso: code-review-agent [comando]

Comandos:
  review                Executa revisao com dados de exemplo
  review --file <path>  Executa revisao a partir de um JSON
  validate              Valida schemas do projeto
  sample                Imprime o JSON de exemplo
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'review';

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      return;
    case 'sample':
      console.log(JSON.stringify(SAMPLE, null, 2));
      return;
    case 'validate': {
      const res = PullRequestInputSchema.safeParse(SAMPLE);
      if (!res.success) {
        console.error('Schema INVALIDO:', res.error.flatten());
        process.exit(1);
      }
      console.log('Schemas validados com sucesso.');
      return;
    }
    case 'review': {
      let input: PullRequestInput = SAMPLE;
      const fileIdx = args.indexOf('--file');
      if (fileIdx >= 0) {
        const filePath = args[fileIdx + 1];
        if (!filePath || !fs.existsSync(filePath)) {
          console.error('Arquivo nao encontrado:', filePath);
          process.exit(1);
        }
        const raw = JSON.parse(fs.readFileSync(filePath, { encoding: 'utf8' }));
        const parsed = PullRequestInputSchema.safeParse(raw);
        if (!parsed.success) {
          console.error('JSON invalido:', parsed.error.flatten());
          process.exit(1);
        }
        input = parsed.data;
      }
      logger.info({ prId: input.prId }, 'Revisao CLI iniciando');
      const state = await runGraph(input);
      const r = state.finalResult;
      if (!r) {
        console.error('Falha: sem resultado final');
        process.exit(1);
      }
      console.log('\n===============================');
      console.log(`PR: ${r.prId}  |  STATUS: ${r.status}  |  SCORE: ${r.score}/100`);
      console.log(`TRACE: ${r.traceId}`);
      console.log('===============================');
      console.log(r.summary);
      console.log('');
      console.log(`Achados (${r.findings.length}):`);
      for (const f of r.findings.slice(0, 10)) {
        console.log(
          `  - [${f.severity.toUpperCase()}/${f.category}] ${f.file}:L${f.lineStart} - ${f.title}`,
        );
      }
      if (r.recommendations.length > 0) {
        console.log('\nRecomendacoes:');
        r.recommendations.forEach((rec: string, i: number) => console.log(`  ${i + 1}. ${rec}`));
      }
      if (r.risks.length > 0) {
        console.log('\nRiscos:');
        r.risks.forEach((rsk: string, i: number) => console.log(`  ${i + 1}. ${rsk}`));
      }
      console.log('');
      return;
    }
    default:
      console.error('Comando desconhecido:', cmd);
      printUsage();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error('Falha na CLI:', err);
  process.exit(1);
});
