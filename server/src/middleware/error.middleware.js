export function errorMiddleware(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  console.error(error);

  // Handle malformed JSON request bodies.
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'The request body contains invalid JSON.',
      },
    });
  }

  return res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected server error occurred.',
    },
  });
}