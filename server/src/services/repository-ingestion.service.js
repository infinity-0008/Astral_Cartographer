// server/src/services/repository-ingestion.service.js

import { createWriteStream } from 'node:fs';
import {  mkdir,  rm, } from 'node:fs/promises';

import {  dirname,  isAbsolute,  relative,  resolve} from 'node:path';

import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import yauzl from 'yauzl';

const SERVER_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const DATA_DIR = resolve(
  SERVER_DIR,
  'data',
  'repositories',
);

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_EXTRACTED_BYTES = 200 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_REPOSITORY_FILES = 12_000;
const MAX_ARCHIVE_ENTRIES = 25_000;

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Astral-Cartographer',
  'X-GitHub-Api-Version': '2026-03-10',
};

// Internal lookup for the extracted directories.
// Absolute filesystem paths are not returned to API clients.
const repositoryPaths = new Map();

function parseGitHubSource(sourceUrl) {
  const url = new URL(sourceUrl);

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com'
  ) {
    throw new Error('Invalid GitHub repository source.');
  }

  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  if (segments.length !== 2) {
    throw new Error('Expected a GitHub owner and repository name.');
  }

  const [owner, rawRepo] = segments;

  // Allow common Git URL notation, such as repo.git.
  const repo = rawRepo.endsWith('.git')
    ? rawRepo.slice(0, -4)
    : rawRepo;

  if (!owner || !repo) {
    throw new Error('Repository owner or name is missing.');
  }

  return { owner, repo };
}

async function fetchRepositoryMetadata(owner, repo) {
  const url =
    `https://api.github.com/repos/` +
    `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const response = await fetch(url, {
    headers: GITHUB_HEADERS,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 404) {
    throw new Error(
      'Repository not found, private, or inaccessible.',
    );
  }

  if (response.status === 403) {
    throw new Error(
      'GitHub denied the metadata request. Check API rate limits.',
    );
  }

  if (!response.ok) {
    throw new Error(
      `GitHub metadata request returned HTTP ${response.status}.`,
    );
  }

  const metadata = await response.json();

  if (!metadata.default_branch) {
    throw new Error(
      'The repository has no available default branch.',
    );
  }

  return metadata;
}

async function downloadRepositoryArchive(
  owner,
  repo,
  archivePath,
) {
  const repositoryApiUrl =
    `https://api.github.com/repos/` +
    `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  // GitHub's archive endpoint responds with a redirect.
  // Do not follow it automatically: validate the destination first.
  const redirectResponse = await fetch(
    `${repositoryApiUrl}/zipball`,
    {
      headers: GITHUB_HEADERS,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (redirectResponse.status !== 302) {
    const status = redirectResponse.status;

    await redirectResponse.body?.cancel().catch(() => {});

    throw new Error(
      `Expected a GitHub archive redirect; received HTTP ${status}.`,
    );
  }

  const location = redirectResponse.headers.get('location');

  if (!location) {
    throw new Error('GitHub did not provide an archive URL.');
  }

  const archiveUrl = new URL(location);

  // Only allow the expected HTTPS archive host.
  if (
    archiveUrl.protocol !== 'https:' ||
    archiveUrl.hostname !== 'codeload.github.com' ||
    archiveUrl.username ||
    archiveUrl.password ||
    archiveUrl.port
  ) {
    throw new Error(
      'GitHub returned an archive URL from an unexpected host.',
    );
  }

  // Do not automatically follow any further redirects.
  const signal = AbortSignal.timeout(60_000);

  const response = await fetch(archiveUrl, {
    headers: {
      'User-Agent': 'Astral-Cartographer',
    },
    redirect: 'error',
    signal,
  });

  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});

    throw new Error(
      `Archive download failed with HTTP ${response.status}.`,
    );
  }

  const contentLength = response.headers.get('content-length');

  if (
    contentLength &&
    Number(contentLength) > MAX_ARCHIVE_BYTES
  ) {
    await response.body.cancel().catch(() => {});

    throw new Error('Repository archive exceeds the size limit.');
  }

  let downloadedBytes = 0;

  const sizeLimiter = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length;

      if (downloadedBytes > MAX_ARCHIVE_BYTES) {
        callback(
          new Error('Repository archive exceeds the size limit.'),
        );
        return;
      }

      callback(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body),
    sizeLimiter,
    createWriteStream(archivePath, {
      flags: 'wx',
      mode: 0o600,
    }),
    { signal },
  );

  return downloadedBytes;
}

function openZipEntry(zipfile, entry) {
  return new Promise((resolveStream, rejectStream) => {
    zipfile.openReadStream(entry, (error, readStream) => {
      if (error) {
        rejectStream(error);
        return;
      }

      resolveStream(readStream);
    });
  });
}

async function extractZipArchive(zipPath, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });

  return new Promise((resolveExtraction, rejectExtraction) => {
    yauzl.open(
      zipPath,
      {
        lazyEntries: true,
        decodeStrings: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (openError, zipfile) => {
        if (openError) {
          rejectExtraction(openError);
          return;
        }

        let settled = false;
        let archiveRoot = null;
        let entryCount = 0;
        let fileCount = 0;
        let totalBytes = 0;

        function fail(error) {
          if (settled) {
            return;
          }

          settled = true;

          try {
            zipfile.close();
          } catch {
            // Preserve the original extraction error.
          }

          rejectExtraction(error);
        }

        async function processEntry(entry) {
          entryCount += 1;

          if (entryCount > MAX_ARCHIVE_ENTRIES) {
            throw new Error('Repository archive contains too many entries.');
          }

          const filename = entry.fileName;

          if (
            !filename ||
            filename.includes('\\') ||
            filename.includes('\0') ||
            filename.startsWith('/') ||
            /^[A-Za-z]:/.test(filename)
          ) {
            throw new Error('Archive contains an unsafe file path.');
          }

          // Detect Unix file types encoded in ZIP attributes.
          const unixMode =
            (entry.externalFileAttributes >>> 16) & 0xffff;

          const unixFileType = unixMode & 0o170000;

          if (unixFileType === 0o120000) {
            throw new Error(
              'Repository archive contains a symbolic link.',
            );
          }

          if (
            unixFileType !== 0 &&
            unixFileType !== 0o040000 &&
            unixFileType !== 0o100000
          ) {
            throw new Error(
              'Repository archive contains an unsupported file type.',
            );
          }

          const isDirectory =
            filename.endsWith('/') ||
            unixFileType === 0o040000;

          const candidateName = filename.endsWith('/')
            ? filename.slice(0, -1)
            : filename;

          const pathParts = candidateName.split('/');

          if (
            pathParts.some(
              (part) =>
                !part ||
                part === '.' ||
                part === '..' ||
                /[<>:"|?*\u0000-\u001f]/.test(part) ||
                /[. ]$/.test(part),
            )
          ) {
            throw new Error('Archive contains an unsafe file path.');
          }

          // GitHub ZIPs normally contain one top-level directory.
          // Strip it so source files land directly in outputDirectory.
          archiveRoot ??= pathParts[0];

          if (pathParts[0] !== archiveRoot) {
            throw new Error(
              'Archive contains unexpected top-level paths.',
            );
          }

          const relativeParts = pathParts.slice(1);

          // Handle the ZIP's root-directory entry.
          if (relativeParts.length === 0) {
            if (!isDirectory) {
              throw new Error('Archive root is not a directory.');
            }

            return;
          }

          const targetPath = resolve(
            outputDirectory,
            ...relativeParts,
          );

          const relativeTarget = relative(
            outputDirectory,
            targetPath,
          );

          if (
            !relativeTarget ||
            relativeTarget.startsWith('..') ||
            isAbsolute(relativeTarget)
          ) {
            throw new Error(
              'Archive entry would escape the extraction directory.',
            );
          }

          if (isDirectory) {
            await mkdir(targetPath, { recursive: true });
            return;
          }

          if (
            !Number.isSafeInteger(entry.uncompressedSize) ||
            entry.uncompressedSize < 0 ||
            entry.uncompressedSize > MAX_SINGLE_FILE_BYTES
          ) {
            throw new Error(
              'Archive contains a file that exceeds the size limit.',
            );
          }

          if (
            totalBytes + entry.uncompressedSize >
            MAX_TOTAL_EXTRACTED_BYTES
          ) {
            throw new Error(
              'Extracted repository would exceed the total size limit.',
            );
          }

          if (fileCount >= MAX_REPOSITORY_FILES) {
            throw new Error('Repository contains too many files.');
          }

          await mkdir(dirname(targetPath), { recursive: true });

          const readStream = await openZipEntry(zipfile, entry);

          let actualFileBytes = 0;

          const extractionLimiter = new Transform({
            transform(chunk, encoding, callback) {
              actualFileBytes += chunk.length;

              if (
                actualFileBytes > MAX_SINGLE_FILE_BYTES ||
                totalBytes + actualFileBytes >
                  MAX_TOTAL_EXTRACTED_BYTES
              ) {
                callback(
                  new Error(
                    'Extracted repository exceeds a size limit.',
                  ),
                );
                return;
              }

              callback(null, chunk);
            },
          });

          await pipeline(
            readStream,
            extractionLimiter,
            createWriteStream(targetPath, {
              flags: 'wx',
              mode: 0o600,
            }),
          );

          totalBytes += actualFileBytes;
          fileCount += 1;
        }

        zipfile.on('error', fail);

        zipfile.on('entry', (entry) => {
          processEntry(entry)
            .then(() => {
              if (!settled) {
                zipfile.readEntry();
              }
            })
            .catch(fail);
        });

        zipfile.on('end', () => {
          if (settled) {
            return;
          }

          settled = true;

          resolveExtraction({
            fileCount,
            extractedBytes: totalBytes,
          });
        });

        zipfile.readEntry();
      },
    );
  });
}

export async function ingestGitHubRepository(
  source,
  jobId,
  onProgress = () => {},
) {
  // Job IDs are generated internally, but validate them before using
  // one as part of a filesystem path.
  if (
    typeof jobId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      jobId,
    )
  ) {
    throw new Error('Invalid internal job ID.');
  }

  const { owner, repo } = parseGitHubSource(source.url);

  const jobDirectory = resolve(DATA_DIR, jobId);
  const archivePath = resolve(jobDirectory, 'repository.zip');
  const sourceDirectory = resolve(jobDirectory, 'source');

  try {
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(jobDirectory);

    onProgress('fetching_metadata', 5);

    const metadata = await fetchRepositoryMetadata(owner, repo);

    onProgress('downloading_archive', 10);

    const archiveBytes = await downloadRepositoryArchive(
      owner,
      repo,
      archivePath,
    );

    onProgress('extracting_archive', 20);

    const extraction = await extractZipArchive(
      archivePath,
      sourceDirectory,
    );

    if (extraction.fileCount === 0) {
      throw new Error('No files were found in the repository archive.');
    }

    // The ZIP is no longer required after successful extraction.
    await rm(archivePath, { force: true });

    // Keep the local path internal for the next analysis stage.
    repositoryPaths.set(jobId, sourceDirectory);

    onProgress('repository_ready', 30);

    return {
      fullName: metadata.full_name || `${owner}/${repo}`,
      defaultBranch: metadata.default_branch,
      archiveBytes,
      fileCount: extraction.fileCount,
      extractedBytes: extraction.extractedBytes,
    };
  } catch (error) {
    repositoryPaths.delete(jobId);

    // Remove partial downloads or extraction output on failure.
    await rm(jobDirectory, {
      recursive: true,
      force: true,
    }).catch(() => {});

    throw error;
  }
}

export function getRepositoryPath(jobId) {
  return repositoryPaths.get(jobId) ?? null;
}