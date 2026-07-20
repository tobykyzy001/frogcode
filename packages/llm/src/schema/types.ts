export interface ValidationError {
  path: string;
  message: string;
  expected: string;
  received: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  data?: unknown;
}

export interface SchemaValidator {
  validate(data: unknown): ValidationResult;
}
