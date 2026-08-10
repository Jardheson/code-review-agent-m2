import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env.js';
import type { Category, Finding } from '../schemas/index.js';
import type { MemoryRecord } from '../types/index.js';
import { logger } from '../observability/logger.js';
import { auditor } from '../observability/auditor.js';

export class MemoryStore {
  private readonly filePath: string;
  private data: Record<string, MemoryRecord>;

  constructor(filePath = env.MEMORY_STORAGE_PATH) {
    this.filePath = filePath;
    this.data = {};
    this.ensureDir();
    this.load();
  }

  private ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, { encoding: 'utf8' });
        if (raw.trim().length > 0) {
          this.data = JSON.parse(raw);
        }
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Falha ao carregar memoria; iniciando limpa');
      this.data = {};
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { encoding: 'utf8' });
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Falha ao persistir memoria em disco');
    }
  }

  public getOrCreate(prId: string): MemoryRecord {
    if (!this.data[prId]) {
      this.data[prId] = {
        prId,
        historicalFindings: [],
        authorReviewHistory: {
          totalReviews: 0,
          avgScore: 0,
          commonIssues: [],
        },
        updatedAt: new Date().toISOString(),
      };
      this.persist();
    }
    return this.data[prId];
  }

  public recordReview(prId: string, author: string, score: number, findings: Finding[]): void {
    const record = this.getOrCreate(prId);
    record.lastReview = {
      prId,
      status: score >= 70 ? 'approved' : score >= 50 ? 'needs_changes' : 'rejected',
      summary: 'Registro historico de revisao',
      score,
      metrics: {
        totalFiles: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        filesAnalyzed: 0,
        complexityScore: 0,
        testCoverageEstimate: 0,
        securityScore: 0,
        maintainabilityScore: 0,
      },
      findings,
      recommendations: [],
      testSuggestions: [],
      risks: [],
      humanApprovalRequired: false,
      reviewedAt: new Date().toISOString(),
      traceId: uuidv4(),
    };
    record.historicalFindings = [...record.historicalFindings, ...findings].slice(-200);

    const counts = new Map<Category, number>();
    for (const f of findings) {
      counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
    }
    const sortedCats = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c]) => c);

    const hist = record.authorReviewHistory;
    const newTotal = hist.totalReviews + 1;
    const newAvg = (hist.avgScore * hist.totalReviews + score) / newTotal;
    record.authorReviewHistory = {
      totalReviews: newTotal,
      avgScore: newAvg,
      commonIssues: sortedCats,
    };
    record.updatedAt = new Date().toISOString();
    this.persist();

    auditor.record({
      traceId: uuidv4(),
      prId,
      actor: 'system',
      action: 'MEMORY_UPDATE',
      resource: `memory:${prId}`,
      metadata: { author, score, newTotal, avgScore: newAvg },
    });
  }

  public getAuthorHistoryByKey(_key: string): {
    totalReviews: number;
    avgScore: number;
    commonIssues: Category[];
  } | null {
    const recs = Object.values(this.data);
    const matches = recs.filter((r) => r.lastReview);
    if (matches.length === 0) return null;
    let totalReviews = 0;
    let sum = 0;
    const allCats = new Map<Category, number>();
    for (const r of matches) {
      totalReviews += r.authorReviewHistory.totalReviews;
      sum += r.authorReviewHistory.avgScore * r.authorReviewHistory.totalReviews;
      for (const f of r.historicalFindings) {
        allCats.set(f.category, (allCats.get(f.category) ?? 0) + 1);
      }
    }
    if (totalReviews === 0) return null;
    const cats = [...allCats.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c]) => c);
    return {
      totalReviews,
      avgScore: sum / totalReviews,
      commonIssues: cats,
    };
  }

  public allRecords(): Record<string, MemoryRecord> {
    return this.data;
  }
}

export const memoryStore = new MemoryStore();
