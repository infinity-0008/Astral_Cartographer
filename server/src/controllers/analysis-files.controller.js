//for inspecting the results of the scanning 
import {
  getAnalysisJob,
} from '../services/analysis.service.js';

import {
  getRepositoryFilePage,
} from '../services/repository-scanner.service.js';

function parseIntegerQuery(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  if (
    typeof value !== 'string' ||
    !/^\d+$/.test(value)
  ) {
    return null;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function getAnalysisJobFilesController(req, res) {
  const job = getAnalysisJob(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      error: {
        code: 'JOB_NOT_FOUND',
        message: 'The requested analysis job was not found.',
      },
    });
  }

  if (job.status !== 'files_scanned') {
    return res.status(409).json({
      error: {
        code: 'FILES_NOT_READY',
        message: 'The repository file inventory is not ready.',
      },
    });
  }

  const limit = parseIntegerQuery(req.query.limit, 50);
  const offset = parseIntegerQuery(req.query.offset, 0);

  if (
    limit === null ||
    offset === null ||
    limit < 1 ||
    limit > 100 ||
    offset < 0
  ) {
    return res.status(400).json({
      error: {
        code: 'INVALID_PAGINATION',
        message:
          'limit must be between 1 and 100, and offset must be a non-negative integer.',
      },
    });
  }

  const page = getRepositoryFilePage(
    job.id,
    limit,
    offset,
  );

  if (!page) {
    return res.status(409).json({
      error: {
        code: 'FILES_NOT_AVAILABLE',
        message:
          'The file inventory is unavailable. Submit the repository again.',
      },
    });
  }

  return res.status(200).json({
    jobId: job.id,
    ...page,
  });
}
