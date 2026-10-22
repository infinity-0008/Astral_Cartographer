
import {
  getAnalysisJob,
  updateAnalysisJob,
} from './analysis.service.js';

import {
  ingestGitHubRepository,
} from './repository-ingestion.service.js';

import {
  scanRepository,
} from './repository-scanner.service.js';

import {
  parseRepositoryAst,
} from './ast-parser.service.js';

async function processAnalysisJob(jobId) {
  const job = getAnalysisJob(jobId);

  if (!job || job.status !== 'queued') {
    return;
  }

  try {
    updateAnalysisJob(jobId, {
      status: 'processing',
      phase: 'starting',
      progress: 1,
    });

    const repository = await ingestGitHubRepository(
      job.source,
      jobId,
      (phase, progress) => {
        updateAnalysisJob(jobId, {
          status: 'processing',
          phase,
          progress,
        });
      },
    );

    const scan = await scanRepository(
      jobId,
      (phase, progress) => {
        updateAnalysisJob(jobId, {
          status: 'processing',
          phase,
          progress,
          result: {
            repository,
          },
        });
      },
    );

    updateAnalysisJob(jobId, {
      status: 'processing',
      phase: 'files_scanned',
      progress: 50,
      result: {
        repository,
        scan,
      },
    });

    const ast = await parseRepositoryAst(
      jobId,
      (phase, progress) => {
        updateAnalysisJob(jobId, {
          status: 'processing',
          phase,
          progress,
          result: {
            repository,
            scan,
          },
        });
      },
    );

    updateAnalysisJob(jobId, {
      status: 'ast_parsed',
      phase: 'ast_parsed',
      progress: 70,
      result: {
        repository,
        scan,
        ast,
      },
    });
  } catch (error) {
    console.error(
      `Analysis job ${jobId} failed:`,
      error,
    );

    const currentJob = getAnalysisJob(jobId);

    updateAnalysisJob(jobId, {
      status: 'failed',
      phase: 'failed',
      progress: currentJob?.progress ?? 0,
      error: {
        code: 'ANALYSIS_FAILED',
        message:
          'Repository ingestion, scanning, or AST parsing failed. ' +
          'Check the server logs for details.',
      },
    });
  }
}

export function enqueueAnalysisJob(jobId) {
  setImmediate(() => {
    void processAnalysisJob(jobId).catch((error) => {
      console.error(
        `Unexpected processor error for job ${jobId}:`,
        error,
      );
    });
  });
}
