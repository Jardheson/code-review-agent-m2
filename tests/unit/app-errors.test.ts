import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  SecurityError,
  ToolExecutionError,
  ResourceNotFoundError,
  PolicyViolationError,
  HumanApprovalRequiredError,
  MaxStepsExceededError,
  InternalServerError,
} from '../../src/errors/AppError.js';

describe('AppError hierarchy', () => {
  it('ValidationError mapeia code e status corretos', () => {
    const err = new ValidationError('falha validação', { a: 1 });
    expect(err.name).toBe('ValidationError');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.statusCode).toBe(400);
    expect(err.details).toEqual({ a: 1 });
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AppError).toBe(true);
    const json = err.toJSON();
    expect(json.code).toBe('VALIDATION_ERROR');
    expect(json.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('SecurityError mapeia corretamente', () => {
    const err = new SecurityError('bloqueado');
    expect(err.code).toBe('SECURITY_ERROR');
    expect(err.statusCode).toBe(403);
    expect(err.toJSON().message).toBe('bloqueado');
  });

  it('ToolExecutionError mapeia corretamente', () => {
    const err = new ToolExecutionError('tool down', { attempts: 2 });
    expect(err.code).toBe('TOOL_EXECUTION_ERROR');
    expect(err.statusCode).toBe(502);
    expect(err.details).toEqual({ attempts: 2 });
  });

  it('ResourceNotFoundError mapeia corretamente', () => {
    const err = new ResourceNotFoundError('nao existe');
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
    expect(err.statusCode).toBe(404);
  });

  it('PolicyViolationError mapeia corretamente', () => {
    const err = new PolicyViolationError('nao permitido');
    expect(err.code).toBe('POLICY_VIOLATION');
    expect(err.statusCode).toBe(403);
  });

  it('HumanApprovalRequiredError mapeia corretamente', () => {
    const err = new HumanApprovalRequiredError('precisa de aprovação', { reason: 'risk' });
    expect(err.code).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(err.statusCode).toBe(412);
    expect(err.details).toEqual({ reason: 'risk' });
  });

  it('MaxStepsExceededError mapeia corretamente', () => {
    const err = new MaxStepsExceededError('estouro de passos', { max: 15 });
    expect(err.code).toBe('MAX_STEPS_EXCEEDED');
    expect(err.statusCode).toBe(422);
  });

  it('InternalServerError mapeia corretamente', () => {
    const err = new InternalServerError('deu ruim', { cause: 'boom' });
    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    expect(err.statusCode).toBe(500);
  });

  it('AppError.toJSON captura timestamp ISO e não inclui stack diretamente', () => {
    const err = new ValidationError('err');
    const j = err.toJSON();
    expect(typeof j.timestamp).toBe('string');
    expect(Date.parse(j.timestamp)).toBeGreaterThan(0);
    expect(j).not.toHaveProperty('stack');
  });
});
