import type {
  Finding,
  ReviewResult,
  RiskAssessment,
  Severity,
  Category,
} from '../schemas/index.js';

export { Finding, ReviewResult, RiskAssessment, Severity, Category };

export type NodeName =
  | 'INPUT_VALIDATION'
  | 'ADVERSARIAL_CHECK'
  | 'RISK_ASSESSMENT'
  | 'STATIC_ANALYSIS'
  | 'LLM_ANALYSIS'
  | 'PARALLEL_ANALYSIS'
  | 'AGGREGATE_RESULTS'
  | 'GENERATE_RECOMMENDATIONS'
  | 'HUMAN_APPROVAL_CHECK'
  | 'FINAL_REPORT';

export interface GraphStep {
  node: NodeName;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  outputSummary?: string;
  error?: string;
}

export interface AuditEntry {
  auditId: string;
  traceId: string;
  prId: string;
  timestamp: string;
  actor: 'system' | 'llm' | 'tool' | 'human';
  action: string;
  resource?: string;
  decision?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryRecord {
  prId: string;
  lastReview?: ReviewResult;
  historicalFindings: Finding[];
  authorReviewHistory: {
    totalReviews: number;
    avgScore: number;
    commonIssues: Category[];
  };
  updatedAt: string;
}

export interface ToolCallRecord {
  toolName: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  attempt: number;
  success: boolean;
  error?: string;
  inputHash: string;
}

export interface AgentState {
  traceId: string;
  requestId: string;
  prId: string;
  input: {
    repository: string;
    author: string;
    title: string;
    description: string;
    files: Array<{
      path: string;
      content: string;
      diff: string;
      additions: number;
      deletions: number;
    }>;
    priority: 'low' | 'medium' | 'high' | 'critical';
  };
  currentNode: NodeName;
  steps: GraphStep[];
  staticFindings: Finding[];
  llmFindings: Finding[];
  metrics: {
    totalFiles: number;
    totalAdditions: number;
    totalDeletions: number;
    filesAnalyzed: number;
    complexityScore: number;
    testCoverageEstimate: number;
    securityScore: number;
    maintainabilityScore: number;
  };
  risk: RiskAssessment;
  adversarial: {
    safe: boolean;
    threats: string[];
  };
  recommendations: string[];
  testSuggestions: string[];
  risks: string[];
  humanApproval: {
    required: boolean;
    granted: boolean;
    reason?: string;
  };
  memory: {
    loaded: boolean;
    historicalFindings: Finding[];
    authorHistory?: {
      totalReviews: number;
      avgScore: number;
      commonIssues: Category[];
    };
  };
  toolCalls: ToolCallRecord[];
  errors: string[];
  finalResult?: ReviewResult;
}
