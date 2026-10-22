import { readFileSync } from 'node:fs';
import Parser from 'tree-sitter';

import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';

function createLanguageConfig({
  language,
  family,
  grammar,
  queryFile,
}) {
  const querySource = readFileSync(
    new URL(`./queries/${queryFile}`, import.meta.url),
    'utf8',
  );

  return {
    language,
    family,
    grammar,
    query: new Parser.Query(grammar, querySource),
  };
}

const javascript = createLanguageConfig({
  language: 'JavaScript',
  family: 'javascript',
  grammar: JavaScript,
  queryFile: 'javascript.scm',
});

const typescript = createLanguageConfig({
  language: 'TypeScript',
  family: 'javascript',
  grammar: TypeScript.typescript,
  queryFile: 'typescript.scm',
});

const tsx = createLanguageConfig({
  language: 'TSX',
  family: 'javascript',
  grammar: TypeScript.tsx,
  queryFile: 'typescript.scm',
});

const python = createLanguageConfig({
  language: 'Python',
  family: 'python',
  grammar: Python,
  queryFile: 'python.scm',
});

const configs = new Map();

function register(config, extensions) {
  for (const extension of extensions) {
    configs.set(extension, config);
  }
}

register(javascript, ['.js', '.jsx', '.mjs', '.cjs']);
register(typescript, ['.ts', '.mts', '.cts']);
register(tsx, ['.tsx']);
register(python, ['.py', '.pyi']);

export function getLanguageConfig(extension) {
  return configs.get(extension.toLowerCase()) ?? null;
}