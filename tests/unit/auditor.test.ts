import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Auditor } from '../../src/observability/auditor.js';
import { v4 as uuidv4 } from 'uuid';

describe('Auditor', () => {
  let auditFile: string;
  let auditor: Auditor;

  beforeEach(() => {
    auditFile = path.join(os.tmpdir(), `audit-${Date.now()}-${Math.random()}.log`);
    auditor = new Auditor(auditFile);
  });

  it('grava e recupera entrada por traceId', () => {
    const traceId = uuidv4();
    auditor.record({
      traceId,
      prId: 'PR-AUD-1',
      actor: 'system',
      action: 'TEST_ACTION',
      resource: 'res:1',
      decision: 'ALLOWED',
    });
    const entries = auditor.queryByTrace(traceId);
    expect(entries.length).toBe(1);
    expect(entries[0]!.action).toBe('TEST_ACTION');
    expect(entries[0]!.auditId).toBeDefined();
    expect(entries[0]!.timestamp).toBeDefined();
  });

  it('tail retorna ultimas N entradas', () => {
    for (let i = 0; i < 10; i++) {
      auditor.record({
        traceId: uuidv4(),
        prId: 'P',
        actor: 'system',
        action: `A${i}`,
      });
    }
    const last3 = auditor.tail(3);
    expect(last3.length).toBe(3);
    expect(last3[0]!.action).toBe('A7');
    expect(last3[2]!.action).toBe('A9');
  });

  it('escreve em arquivo existente (append)', () => {
    auditor.record({ traceId: 't1', prId: 'p1', actor: 'system', action: 'FIRST' });
    auditor.record({ traceId: 't2', prId: 'p2', actor: 'tool', action: 'SECOND' });
    const lines = fs.readFileSync(auditFile, { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('FIRST');
    expect(lines[1]).toContain('SECOND');
  });
});
