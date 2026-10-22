import { ValidationError } from '../errors/validation.error.js';

import {
  createAnalysisJob,
  getAnalysisJob,
} from '../services/analysis.service.js';

import {
  enqueueAnalysisJob,
} from '../services/analysis-processor.service.js';

export function createAnalysisJobController(req, res, next) {
  try {
    const job = createAnalysisJob(req.body?.source);

    enqueueAnalysisJob(job.id);

    return res.status(202).json({ job });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    return next(error);
  }
}

export function getAnalysisJobController(req, res, next) {
  try {
    const job = getAnalysisJob(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        error: {
          code: 'JOB_NOT_FOUND',
          message: 'The requested analysis job was not found.',
        },
      });
    }

    return res.status(200).json({ job });
  } catch (error) {
    return next(error);
  }
}