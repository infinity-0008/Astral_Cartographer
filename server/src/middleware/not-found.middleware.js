export function notFoundMiddleware(req, res) {
  return res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No route found for ${req.method} ${req.originalUrl}.`,
    },
  });
}