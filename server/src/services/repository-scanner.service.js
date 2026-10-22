
import { readdir, readFile, stat } from 'node:fs/promises';
import {
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import { getRepositoryPath } from './repository-ingestion.service.js';

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'vendor',
  'bower_components',
  '.venv',
  'venv',
]);

const SUPPORTED_EXTENSIONS = {
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',

  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',

  '.py': 'Python',
  '.pyi': 'Python',
};

const MAX_SOURCE_FILES = 10_000;
const MAX_DIRECTORY_DEPTH = 50;
const MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_READ_BYTES = 50 * 1024 * 1024;

// Temporary in-memory inventory, keyed by analysis job ID.
const inventories = new Map();

function isInsideRoot(root, target) {
  const relativePath = relative(root, target);

  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function countLines(content) {
  if (content.length === 0) {
    return 0;
  }

  const lines = content.split(/\r\n|\n|\r/);

  // A trailing newline terminates the last line; it does not
  // create an additional line of source code.
  if (content.endsWith('\n') || content.endsWith('\r')) {
    lines.pop();
  }

  return lines.length;
}

function isTestFile(filePath) {
  return (
    /(^|\/)(__tests__|tests?)(\/|$)/i.test(filePath) ||
    /\.(test|spec)\.[^.]+$/i.test(filePath)
  );
}

async function collectSourceFiles(
  root,
  currentDirectory,
  depth,
  files,
) {
  if (depth > MAX_DIRECTORY_DEPTH) {
    throw new Error('Repository directory nesting exceeds the scan limit.');
  }

  const entries = await readdir(currentDirectory, {
    withFileTypes: true,
  });

  // Sorting makes inventory ordering deterministic.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const absolutePath = resolve(currentDirectory, entry.name);

    if (!isInsideRoot(root, absolutePath)) {
      throw new Error('A repository path escaped the scan directory.');
    }

    // Never follow symbolic links during scanning.
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        continue;
      }

      await collectSourceFiles(
        root,
        absolutePath,
        depth + 1,
        files,
      );

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = extname(entry.name).toLowerCase();
    const language = SUPPORTED_EXTENSIONS[extension];

    if (!language) {
      continue;
    }

    if (files.length >= MAX_SOURCE_FILES) {
      throw new Error('Repository contains too many source files to scan.');
    }

    const metadata = await stat(absolutePath);
    const filePath = relative(root, absolutePath).split(sep).join('/');

    files.push({
      absolutePath,
      path: filePath,
      extension,
      language,
      sizeBytes: metadata.size,
      lineCount: null,
      isTestFile: isTestFile(filePath),
      scanStatus: 'pending',
      skipReason: null,
    });
  }
}

export async function scanRepository(
  jobId,
  onProgress = () => {},
) {
  const repositoryRoot = getRepositoryPath(jobId);

  if (!repositoryRoot) {
    throw new Error(
      'Repository files are unavailable for this analysis job.',
    );
  }

  onProgress('scanning_files', 35);

  const files = [];

  await collectSourceFiles(
    repositoryRoot,
    repositoryRoot,
    0,
    files,
  );

  onProgress('counting_lines', 40);

  let bytesRead = 0;
  let totalLines = 0;
  let filesWithLineCount = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];

    if (file.sizeBytes > MAX_SINGLE_FILE_BYTES) {
      file.scanStatus = 'skipped';
      file.skipReason = 'FILE_TOO_LARGE';
      continue;
    }

    if (
      bytesRead + file.sizeBytes >
      MAX_TOTAL_READ_BYTES
    ) {
      file.scanStatus = 'skipped';
      file.skipReason = 'READ_BUDGET_EXCEEDED';
      continue;
    }

    try {
      const contentBuffer = await readFile(file.absolutePath);
      const actualBytes = contentBuffer.byteLength;

      if (
        actualBytes > MAX_SINGLE_FILE_BYTES ||
        bytesRead + actualBytes > MAX_TOTAL_READ_BYTES
      ) {
        file.scanStatus = 'skipped';
        file.skipReason = 'READ_BUDGET_EXCEEDED';
        continue;
      }

      const content = contentBuffer.toString('utf8');
      const lineCount = countLines(content);

      file.sizeBytes = actualBytes;
      file.lineCount = lineCount;
      file.scanStatus = 'scanned';

      bytesRead += actualBytes;
      totalLines += lineCount;
      filesWithLineCount += 1;
    } catch {
      file.scanStatus = 'skipped';
      file.skipReason = 'UNREADABLE';
    }

    if ((index + 1) % 100 === 0) {
      const progress = Math.min(
        49,
        40 + Math.floor(((index + 1) / files.length) * 9),
      );

      onProgress('counting_lines', progress);
    }
  }

  // Do not expose absolute filesystem paths through the API.
  const inventory = files.map(
    ({
      absolutePath,
      ...publicMetadata
    }) => publicMetadata,
  );

  const countsByLanguage = {};
  const countsByExtension = {};

  for (const file of inventory) {
    countsByLanguage[file.language] =
      (countsByLanguage[file.language] ?? 0) + 1;

    countsByExtension[file.extension] =
      (countsByExtension[file.extension] ?? 0) + 1;
  }

  const summary = {
    totalSupportedFiles: inventory.length,
    filesWithLineCount,
    skippedFiles: inventory.length - filesWithLineCount,
    totalLines,
    bytesRead,
    countsByLanguage,
    countsByExtension,
  };

  inventories.set(jobId, inventory);

  onProgress('files_scanned', 50);

  return summary;
}

export function getRepositoryFilePage(jobId, limit = 50, offset = 0) {
  const inventory = inventories.get(jobId);

  if (!inventory) {
    return null;
  }

  return {
    items: inventory.slice(offset, offset + limit),
    pagination: {
      limit,
      offset,
      total: inventory.length,
      hasMore: offset + limit < inventory.length,
    },
  };
}

//for ast parser - needs complete list of files 
export function getRepositoryFiles(jobId) {
  const inventory = inventories.get(jobId);

  if (!inventory) {
    return null;
  }

  return inventory.map((file) => ({ ...file }));
}
