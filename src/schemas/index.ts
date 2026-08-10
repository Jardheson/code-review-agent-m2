import { z } from 'zod';
import { allowedExtensions, env } from '../config/env.js';

export const SeveritySchema = z.enum(['info', 'warning', 'error', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

export const CategorySchema = z.enum([
  'security',
  'performance',
  'maintainability',
  'style',
  'bug_risk',
  'best_practice',
  'test_coverage',
]);
export type Category = z.infer<typeof CategorySchema>;

export const FileDiffSchema = z.object({
  path: z
    .string()
    .min(1)
    .refine(
      (p) => {
        const ext = '.' + p.split('.').pop()?.toLowerCase();
        return allowedExtensions.has(ext);
      },
      (p) => ({
        message: `Arquivo "${p}" com extensao nao permitida. Extensoes aceitas: ${[...allowedExtensions].join(', ')}`,
      }),
    ),
  content: z.string().min(0),
  diff: z.string().min(0),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

export const PullRequestInputSchema = z.object({
  prId: z.string().min(1).max(100),
  repository: z.string().min(1).max(200),
  author: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).default(''),
  branch: z.string().min(1).max(200),
  baseBranch: z.string().min(1).max(200).default('main'),
  files: z
    .array(FileDiffSchema)
    .min(1, 'Pelo menos um arquivo deve ser informado')
    .max(50, 'Maximo 50 arquivos por PR')
    .refine(
      (files) => {
        const totalBytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.diff, 'utf8'), 0);
        return totalBytes <= env.MAX_DIFF_SIZE_BYTES;
      },
      { message: `Tamanho total do diff excede ${env.MAX_DIFF_SIZE_BYTES} bytes` },
    ),
  requestId: z.string().uuid().optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
});
export type PullRequestInput = z.infer<typeof PullRequestInputSchema>;

export const FindingSchema = z.object({
  id: z.string().uuid(),
  file: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  severity: SeveritySchema,
  category: CategorySchema,
  title: z.string().min(1),
  description: z.string().min(1),
  suggestion: z.string().optional(),
  ruleId: z.string().optional(),
  confidence: z.number().min(0).max(1).default(1),
});
export type Finding = z.infer<typeof FindingSchema>;

export const CodeMetricsSchema = z.object({
  totalFiles: z.number().int().nonnegative(),
  totalAdditions: z.number().int().nonnegative(),
  totalDeletions: z.number().int().nonnegative(),
  filesAnalyzed: z.number().int().nonnegative(),
  complexityScore: z.number().min(0).max(10).default(0),
  testCoverageEstimate: z.number().min(0).max(100).default(0),
  securityScore: z.number().min(0).max(100).default(100),
  maintainabilityScore: z.number().min(0).max(100).default(100),
});
export type CodeMetrics = z.infer<typeof CodeMetricsSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'needs_changes']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ReviewResultSchema = z.object({
  prId: z.string(),
  status: ApprovalStatusSchema,
  summary: z.string().min(1),
  score: z.number().min(0).max(100),
  metrics: CodeMetricsSchema,
  findings: z.array(FindingSchema),
  recommendations: z.array(z.string()),
  testSuggestions: z.array(z.string()),
  risks: z.array(z.string()),
  humanApprovalRequired: z.boolean(),
  reviewedAt: z.string().datetime(),
  traceId: z.string().uuid(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const RiskAssessmentSchema = z.object({
  level: z.enum(['low', 'medium', 'high', 'critical']),
  score: z.number().min(0).max(100),
  factors: z.array(z.string()),
  recommendation: z.string(),
});
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

export const AdversarialCheckSchema = z.object({
  safe: z.boolean(),
  threats: z.array(z.string()),
  sanitizedContent: z.string().optional(),
});
export type AdversarialCheck = z.infer<typeof AdversarialCheckSchema>;
