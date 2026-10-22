export function getHealth(req, res) {
  res.status(200).json({
    status: 'ok',
    message: 'Astral Cartographer API is running',
  });
}