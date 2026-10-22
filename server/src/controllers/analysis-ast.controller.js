
import {
  getAnalysisJob,
} from '../services/analysis.service.js';

import {
  getParsedFilePage,
} from '../services/ast-parser.service.js';

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

export function getAnalysisJobAstController(req, res) {
  const job = getAnalysisJob(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      error: {
        code: 'JOB_NOT_FOUND',
        message: 'The requested analysis job was not found.',
      },
    });
  }

  if (job.status !== 'ast_parsed') {
    return res.status(409).json({
      error: {
        code: 'AST_NOT_READY',
        message: 'AST analysis has not finished yet.',
      },
    });
  }

  const limit = parseIntegerQuery(req.query.limit, 25);
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

  const page = getParsedFilePage(
    job.id,
    limit,
    offset,
  );

  if (!page) {
    return res.status(409).json({
      error: {
        code: 'AST_NOT_AVAILABLE',
        message: 'AST results are unavailable for this job.',
      },
    });
  }

  return res.status(200).json({
    jobId: job.id,
    summary: job.result?.ast ?? null,
    ...page,
  });
}
