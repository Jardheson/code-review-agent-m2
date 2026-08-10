import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore } from '../../src/memory/store.js';
import type { Finding } from '../../src/schemas/index.js';
import { v4 as uuidv4 } from 'uuid';

function mkFinding(): Finding {
  return {
    id: uuidv4(),
    file: 'a.ts',
    lineStart: 1,
    lineEnd: 1,
    severity: 'warning',
    category: 'maintainability',
    title: 't',
    description: 'd',
    confidence: 0.9,
  };
}

describe('MemoryStore', () => {
  let tmpFile: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `memory-test-${Date.now()}-${Math.random()}.json`);
    store = new MemoryStore(tmpFile);
  });

  it('cria registro vazio para prId desconhecido', () => {
    const rec = store.getOrCreate('PR-NOVO');
    expect(rec.prId).toBe('PR-NOVO');
    expect(rec.authorReviewHistory.totalReviews).toBe(0);
  });

  it('persiste e recupera historico apos novo store mesmo arquivo', () => {
    const f1 = mkFinding();
    store.recordReview('PR-PERSIST', 'autor1', 65, [f1]);
    const store2 = new MemoryStore(tmpFile);
    const rec = store2.getOrCreate('PR-PERSIST');
    expect(rec.authorReviewHistory.totalReviews).toBe(1);
    expect(rec.authorReviewHistory.avgScore).toBe(65);
  });

  it('incrementa totalReviews e calcula media corretamente', () => {
    store.recordReview('PR-A', 'autorA', 80, []);
    store.recordReview('PR-B', 'autorA', 60, []);
    const h = store.getAuthorHistoryByKey('autorA');
    expect(h?.totalReviews).toBe(2);
    expect(Math.abs((h?.avgScore ?? 0) - 70)).toBeLessThan(0.001);
  });

  it('escreve em disco apos atualizacao', () => {
    store.recordReview('PR-X', 'autorX', 90, []);
    const raw = fs.readFileSync(tmpFile, { encoding: 'utf8' });
    expect(raw.includes('PR-X')).toBe(true);
    const data = JSON.parse(raw);
    expect(data['PR-X']).toBeDefined();
    expect(data['PR-X'].authorReviewHistory.totalReviews).toBe(1);
    expect(data['PR-X'].authorReviewHistory.avgScore).toBe(90);
  });
});
