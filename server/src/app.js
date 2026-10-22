import express from 'express';

import healthRoutes from './routes/health.routes.js';
import analysisRoutes from './routes/analysis.routes.js';

import { notFoundMiddleware } from './middleware/not-found.middleware.js';
import { errorMiddleware } from './middleware/error.middleware.js';

const app = express();

// Parse JSON request bodies, with a request-size limit.
app.use(express.json({ limit: '1mb' }));

// Register API routes.
app.use('/api/health', healthRoutes);
app.use('/api/analysis', analysisRoutes);

// These must come after the routes.
app.use(notFoundMiddleware);
app.use(errorMiddleware);

export default app;