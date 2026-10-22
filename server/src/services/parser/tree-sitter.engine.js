import Parser from 'tree-sitter';

import {
  getLanguageConfig,
} from './language-registry.js';

import {
  extractJavaScriptData,
} from './extractors/javascript.extractor.js';

import {
  extractPythonData,
} from './extractors/python.extractor.js';

export function parseSource(source, extension) {
  const config = getLanguageConfig(extension);

  if (!config) {
    throw new Error(
      `Unsupported source extension: ${extension}`,
    );
  }

  const parser = new Parser();
  parser.setLanguage(config.grammar);

  const tree = parser.parse(source);
  const root = tree.rootNode;

  const extracted =
    config.family === 'python'
      ? extractPythonData(root, config.query)
      : extractJavaScriptData(
          root,
          config.query,
          config.family,
        );

  const hasSyntaxErrors = root.hasError;
  const firstError = root.descendantsOfType('ERROR')[0];

  return {
    language: config.language,
    hasSyntaxErrors,

    parseError: hasSyntaxErrors
      ? {
          message:
            'Tree-sitter recovered from syntax errors in this file.',
          line: firstError
            ? firstError.startPosition.row + 1
            : root.startPosition.row + 1,
          column: firstError
            ? firstError.startPosition.column + 1
            : root.startPosition.column + 1,
        }
      : null,

    ...extracted,

    metrics: {
      astNodeCount: root.descendantCount + 1,
      importCount: extracted.imports.length,
      dependencyCount: extracted.dependencies.length,
      exportCount: extracted.exports.length,
      declarationCount: extracted.declarations.length,
      functionCount: extracted.functions.length,
    },
  };
}