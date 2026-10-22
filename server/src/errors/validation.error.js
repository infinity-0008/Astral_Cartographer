export class ValidationError extends Error {
  constructor(message, code = 'INVALID_SOURCE') {
    super(message);

    this.name = 'ValidationError';
    this.code = code;
  }
}