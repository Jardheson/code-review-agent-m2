import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { AuditEntry } from '../types/index.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const auditDir = path.dirname(env.AUDIT_LOG_PATH);
if (!fs.existsSync(auditDir)) {
  fs.mkdirSync(auditDir, { recursive: true });
}

export class Auditor {
  private filePath: string;

  constructor(filePath = env.AUDIT_LOG_PATH) {
    this.filePath = filePath;
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '', { encoding: 'utf8' });
    }
  }

  public record(entry: Omit<AuditEntry, 'auditId' | 'timestamp'>): AuditEntry {
    const fullEntry: AuditEntry = {
      ...entry,
      auditId: uuidv4(),
      timestamp: new Date().toISOString(),
    };

    const line = JSON.stringify(fullEntry) + '\n';
    fs.appendFileSync(this.filePath, line, { encoding: 'utf8' });

    logger.debug({ audit: fullEntry }, 'Audit entry recorded');
    return fullEntry;
  }

  public queryByTrace(traceId: string): AuditEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    const content = fs.readFileSync(this.filePath, { encoding: 'utf8' });
    return content
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AuditEntry)
      .filter((e) => e.traceId === traceId);
  }

  public tail(limit = 50): AuditEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    const content = fs.readFileSync(this.filePath, { encoding: 'utf8' });
    const entries = content
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AuditEntry);
    return entries.slice(-limit);
  }
}

export const auditor = new Auditor();
