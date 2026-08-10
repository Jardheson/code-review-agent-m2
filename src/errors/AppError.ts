export abstract class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly timestamp: string;

  constructor(message: string, code: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }

  public toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      timestamp: this.timestamp,
      details: this.details,
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

export class SecurityError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'SECURITY_ERROR', 403, details);
  }
}

export class ToolExecutionError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'TOOL_EXECUTION_ERROR', 502, details);
  }
}

export class ResourceNotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'RESOURCE_NOT_FOUND', 404, details);
  }
}

export class PolicyViolationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'POLICY_VIOLATION', 403, details);
  }
}

export class HumanApprovalRequiredError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'HUMAN_APPROVAL_REQUIRED', 412, details);
  }
}

export class MaxStepsExceededError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'MAX_STEPS_EXCEEDED', 422, details);
  }
}

export class InternalServerError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'INTERNAL_SERVER_ERROR', 500, details);
  }
}
