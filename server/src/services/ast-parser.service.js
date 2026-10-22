import { readFile } from 'node:fs/promises';
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import {
  getRepositoryPath,
} from './repository-ingestion.service.js';

import {
  getRepositoryFiles,
} from './repository-scanner.service.js';

import {
  parseSource,
} from './parser/tree-sitter.engine.js';

const MAX_AST_FILES = 5_000;
const MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_AST_BYTES = 50 * 1024 * 1024;

const parsedFilesByJob = new Map();

function isInsideRoot(root, target) {
  const relativePath = relative(root, target);

  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function createSkippedRecord(file, reason) {
  return {
    path: file.path,
    language: file.language,
    parseStatus: 'skipped',
    skipReason: reason,
    hasSyntaxErrors: false,
    parseError: null,
    imports: [],
    dependencies: [],
    exports: [],
    declarations: [],
    functions: [],
    metrics: {
      astNodeCount: 0,
      importCount: 0,
      dependencyCount: 0,
      exportCount: 0,
      declarationCount: 0,
      functionCount: 0,
    },
  };
}

export async function parseRepositoryAst(
  jobId,
  onProgress = () => {},
) {
  const repositoryRoot = getRepositoryPath(jobId);
  const inventory = getRepositoryFiles(jobId);

  if (!repositoryRoot || !inventory) {
    throw new Error(
      'Repository inventory is unavailable for AST parsing.',
    );
  }

  const results = [];
  let totalBytesRead = 0;
  let eligibleFiles = 0;

  onProgress('parsing_ast', 52);

  for (let index = 0; index < inventory.length; index += 1) {
    const file = inventory[index];

    if (file.scanStatus !== 'scanned') {
      results.push(
        createSkippedRecord(
          file,
          file.skipReason ?? 'FILE_NOT_SCANNED',
        ),
      );

      continue;
    }

    if (eligibleFiles >= MAX_AST_FILES) {
      results.push(
        createSkippedRecord(file, 'AST_FILE_LIMIT'),
      );

      continue;
    }

    eligibleFiles += 1;

    if (file.sizeBytes > MAX_SINGLE_FILE_BYTES) {
      results.push(
        createSkippedRecord(file, 'FILE_TOO_LARGE'),
      );

      continue;
    }

    if (
      totalBytesRead + file.sizeBytes >
      MAX_TOTAL_AST_BYTES
    ) {
      results.push(
        createSkippedRecord(
          file,
          'AST_READ_BUDGET_EXCEEDED',
        ),
      );

      continue;
    }

    const absolutePath = resolve(
      repositoryRoot,
      ...file.path.split('/'),
    );

    if (!isInsideRoot(repositoryRoot, absolutePath)) {
      results.push(
        createSkippedRecord(file, 'UNSAFE_PATH'),
      );

      continue;
    }

    try {
      const buffer = await readFile(absolutePath);

      if (buffer.byteLength > MAX_SINGLE_FILE_BYTES) {
        results.push(
          createSkippedRecord(file, 'FILE_TOO_LARGE'),
        );

        continue;
      }

      if (
        totalBytesRead + buffer.byteLength >
        MAX_TOTAL_AST_BYTES
      ) {
        results.push(
          createSkippedRecord(
            file,
            'AST_READ_BUDGET_EXCEEDED',
          ),
        );

        continue;
      }

      totalBytesRead += buffer.byteLength;

      const source = buffer.toString('utf8');

      try {
        const parsed = parseSource(
          source,
          file.extension,
        );

        results.push({
          path: file.path,
          language: parsed.language,
          parseStatus: 'parsed',
          skipReason: null,
          ...parsed,
        });
      } catch (error) {
        results.push({
          ...createSkippedRecord(file, null),
          parseStatus: 'parse_error',
          parseError: {
            message: String(error.message).slice(0, 500),
          },
        });
      }
    } catch {
      results.push(
        createSkippedRecord(file, 'FILE_READ_FAILED'),
      );
    }

    const progress =
      inventory.length === 0
        ? 70
        : Math.min(
            70,
            52 + Math.floor(
              ((index + 1) / inventory.length) * 18,
            ),
          );

    onProgress('parsing_ast', progress);
  }

  const parsedFiles = results.filter(
    (file) => file.parseStatus === 'parsed',
  );

  const summary = {
    totalFiles: results.length,
    parsedFiles: parsedFiles.length,

    // These files could not be processed by the parser itself.
    parseErrors: results.filter(
      (file) => file.parseStatus === 'parse_error',
    ).length,

    // Tree-sitter may still provide a useful tree for these files.
    filesWithSyntaxErrors: parsedFiles.filter(
      (file) => file.hasSyntaxErrors,
    ).length,

    skippedFiles: results.filter(
      (file) => file.parseStatus === 'skipped',
    ).length,

    bytesRead: totalBytesRead,

    importCount: results.reduce(
      (total, file) => total + file.metrics.importCount,
      0,
    ),

    dependencyCount: results.reduce(
      (total, file) => total + file.metrics.dependencyCount,
      0,
    ),

    exportCount: results.reduce(
      (total, file) => total + file.metrics.exportCount,
      0,
    ),

    declarationCount: results.reduce(
      (total, file) => total + file.metrics.declarationCount,
      0,
    ),

    functionCount: results.reduce(
      (total, file) => total + file.metrics.functionCount,
      0,
    ),
  };

  parsedFilesByJob.set(jobId, results);

  onProgress('ast_parsed', 70);

  return summary;
}

export function getParsedFilePage(
  jobId,
  limit = 25,
  offset = 0,
) {
  const results = parsedFilesByJob.get(jobId);

  if (!results) {
    return null;
  }

  return {
    items: results.slice(offset, offset + limit),
    pagination: {
      limit,
      offset,
      total: results.length,
      hasMore: offset + limit < results.length,
    },
  };
}