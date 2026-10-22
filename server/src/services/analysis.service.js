// server/src/services/analysis.service.js

import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors/validation.error.js';

const jobs = new Map();

export function createAnalysisJob(source) {
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source)
  ) {
    throw new ValidationError('Source must be an object.');
  }

  if (source.type !== 'github') {
    throw new ValidationError('Source type must be github.');
  }

  if (
    typeof source.url !== 'string' ||
    source.url.length === 0 ||
    source.url !== source.url.trim()
  ) {
    throw new ValidationError(
      'A valid GitHub repository URL is required.',
    );
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(source.url);
  } catch {
    throw new ValidationError('The repository URL is invalid.');
  }

  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== 'github.com' ||
    parsedUrl.port !== ''
  ) {
    throw new ValidationError(
      'Repository URLs must use HTTPS on github.com.',
    );
  }

  if (
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash ||
    source.url.includes('?') ||
    source.url.includes('#')
  ) {
    throw new ValidationError(
      'Credentials, query parameters, and fragments are not allowed.',
    );
  }

  const pathMatches = parsedUrl.pathname.match(
    /^\/([^/]+)\/([^/]+)\/?$/,
  );

  if (!pathMatches) {
    throw new ValidationError(
      'Repository URL must contain an owner and a repository name.',
    );
  }

  const pathSegments = pathMatches.slice(1);

  let decodedSegments;

  try {
    decodedSegments = pathSegments.map((segment) =>
      decodeURIComponent(segment),
    );
  } catch {
    throw new ValidationError(
      'The repository URL contains an invalid path.',
    );
  }

  if (
    decodedSegments.some(
      (segment) =>
        segment === '.' ||
        segment === '..' ||
        segment.includes('/') ||
        segment.includes('\\'),
    )
  ) {
    throw new ValidationError(
      'The repository URL contains an invalid path.',
    );
  }

  const normalizedUrl =
    `${parsedUrl.origin}/${pathSegments.join('/')}`;

  const createdAt = new Date().toISOString();

  const job = {
    id: randomUUID(),
    status: 'queued',
    phase: 'queued',
    progress: 0,
    source: {
      type: 'github',
      url: normalizedUrl,
    },
    createdAt,
    updatedAt: createdAt,
  };

  jobs.set(job.id, job);

  return { ...job };
}

export function getAnalysisJob(jobId) {
  return jobs.get(jobId) ?? null;
}

export function updateAnalysisJob(jobId, changes) {
  const existingJob = jobs.get(jobId);

  if (!existingJob) {
    return null;
  }

  const updatedJob = {
    ...existingJob,
    ...changes,
    updatedAt: new Date().toISOString(),
  };

  jobs.set(jobId, updatedJob);

  return { ...updatedJob };
}