
import { parse } from '@babel/parser';
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

const MAX_AST_FILES = 5_000;
const MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_AST_BYTES = 50 * 1024 * 1024;

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
  'TSDeclareFunction',
  'TSDeclareMethod',
  'DeclareFunction',
]);

const NODE_METADATA_KEYS = new Set([
  'loc',
  'start',
  'end',
  'extra',
  'leadingComments',
  'innerComments',
  'trailingComments',
  'comments',
  'tokens',
  'errors',
]);

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

function getNodeName(node) {
  if (!node) {
    return null;
  }

  if (node.type === 'Identifier') {
    return node.name;
  }

  if (
    node.type === 'StringLiteral' ||
    node.type === 'NumericLiteral'
  ) {
    return String(node.value);
  }

  return null;
}

function getExpressionName(node) {
  if (!node) {
    return null;
  }

  if (node.type === 'Identifier') {
    return node.name;
  }

  if (node.type === 'MemberExpression') {
    const objectName = getExpressionName(node.object);
    const propertyName = node.computed
      ? getNodeName(node.property)
      : node.property?.name;

    if (objectName && propertyName) {
      return `${objectName}.${propertyName}`;
    }
  }

  return null;
}

function getPatternNames(pattern) {
  if (!pattern) {
    return [];
  }

  if (pattern.type === 'Identifier') {
    return [pattern.name];
  }

  if (pattern.type === 'RestElement') {
    return getPatternNames(pattern.argument);
  }

  if (pattern.type === 'AssignmentPattern') {
    return getPatternNames(pattern.left);
  }

  if (pattern.type === 'ArrayPattern') {
    return pattern.elements.flatMap(getPatternNames);
  }

  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap((property) => {
      if (property.type === 'RestElement') {
        return getPatternNames(property.argument);
      }

      return getPatternNames(property.value);
    });
  }

  if (pattern.type === 'TSParameterProperty') {
    return getPatternNames(pattern.parameter);
  }

  return [];
}

function getDeclarationNames(node) {
  if (!node) {
    return [];
  }

  if (node.type === 'VariableDeclaration') {
    return node.declarations.flatMap((declaration) =>
      getPatternNames(declaration.id).map((name) => ({
        name,
        kind: node.kind,
        line: node.loc?.start?.line ?? null,
      })),
    );
  }

  const declarationKinds = {
    FunctionDeclaration: 'function',
    ClassDeclaration: 'class',
    TSInterfaceDeclaration: 'interface',
    TSTypeAliasDeclaration: 'type',
    TSEnumDeclaration: 'enum',
    TSModuleDeclaration: 'namespace',
    TSDeclareFunction: 'function',
    DeclareFunction: 'function',
    TSImportEqualsDeclaration: 'import-alias',
  };

  const kind = declarationKinds[node.type];

  if (kind && node.id) {
    return [
      {
        name: getNodeName(node.id),
        kind,
        line: node.loc?.start?.line ?? null,
      },
    ].filter((item) => item.name);
  }

  return [];
}

function collectTopLevelDeclarations(program) {
  const declarations = [];

  for (const statement of program.body) {
    let declaration = statement;

    if (
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration'
    ) {
      declaration = statement.declaration;
    }

    declarations.push(...getDeclarationNames(declaration));
  }

  return declarations;
}

function getImportSpecifiers(node) {
  return node.specifiers.map((specifier) => {
    if (specifier.type === 'ImportDefaultSpecifier') {
      return {
        imported: 'default',
        local: specifier.local.name,
        kind: 'value',
      };
    }

    if (specifier.type === 'ImportNamespaceSpecifier') {
      return {
        imported: '*',
        local: specifier.local.name,
        kind: 'value',
      };
    }

    return {
      imported: getNodeName(specifier.imported),
      local: specifier.local.name,
      kind: specifier.importKind ?? node.importKind ?? 'value',
    };
  });
}

function getStringSource(node) {
  if (node?.type === 'StringLiteral') {
    return node.value;
  }

  return null;
}

function walkAst(node, visitor, parent = null) {
  if (!node || typeof node !== 'object') {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      walkAst(item, visitor, parent);
    }

    return;
  }

  if (typeof node.type === 'string') {
    visitor(node, parent);
  }

  for (const [key, value] of Object.entries(node)) {
    if (NODE_METADATA_KEYS.has(key)) {
      continue;
    }

    if (value && typeof value === 'object') {
      walkAst(value, visitor, node);
    }
  }
}

function calculateFunctionComplexity(body) {
  let complexity = 1;

  function visit(node) {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }

      return;
    }

    // Do not charge an outer function for branches inside
    // a nested function.
    if (typeof node.type === 'string') {
      if (FUNCTION_TYPES.has(node.type)) {
        return;
      }

      if (
        node.type === 'IfStatement' ||
        node.type === 'ForStatement' ||
        node.type === 'ForInStatement' ||
        node.type === 'ForOfStatement' ||
        node.type === 'WhileStatement' ||
        node.type === 'DoWhileStatement' ||
        node.type === 'CatchClause' ||
        node.type === 'ConditionalExpression'
      ) {
        complexity += 1;
      }

      if (
        node.type === 'LogicalExpression' &&
        ['&&', '||', '??'].includes(node.operator)
      ) {
        complexity += 1;
      }

      if (
        node.type === 'SwitchCase' &&
        node.test !== null
      ) {
        complexity += 1;
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (NODE_METADATA_KEYS.has(key)) {
        continue;
      }

      if (value && typeof value === 'object') {
        visit(value);
      }
    }
  }

  if (body) {
    visit(body);
  }

  return complexity;
}

function inferFunctionName(node, parent) {
  if (node.id?.name) {
    return node.id.name;
  }

  if (parent?.type === 'VariableDeclarator') {
    return getPatternNames(parent.id)[0] ?? null;
  }

  if (parent?.type === 'AssignmentExpression') {
    return getExpressionName(parent.left);
  }

  if (parent?.type === 'ObjectProperty') {
    return getNodeName(parent.key);
  }

  if (parent?.type === 'ExportDefaultDeclaration') {
    return 'default';
  }

  if (node.key) {
    return getNodeName(node.key) ?? 'computed-method';
  }

  return null;
}

function extractModuleData(ast) {
  const imports = [];
  const exports = [];
  const dependencies = new Set();
  const declarations = collectTopLevelDeclarations(ast.program);
  const functions = [];

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') {
      const source = getStringSource(statement.source);

      if (source !== null) {
        imports.push({
          source,
          kind: statement.importKind ?? 'static',
          line: statement.loc?.start?.line ?? null,
          specifiers: getImportSpecifiers(statement),
        });

        dependencies.add(source);
      }
    }

    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.declaration) {
        for (const declaration of getDeclarationNames(
          statement.declaration,
        )) {
          exports.push({
            name: declaration.name,
            kind: 'named',
            exportKind: statement.exportKind ?? 'value',
            source: null,
            line: statement.loc?.start?.line ?? null,
          });
        }
      }

      const reexportSource = getStringSource(statement.source);

      for (const specifier of statement.specifiers) {
        const exportedName = getNodeName(specifier.exported);

        if (reexportSource !== null) {
          imports.push({
            source: reexportSource,
            kind: 're-export',
            line: statement.loc?.start?.line ?? null,
            specifiers: [
              {
                imported: getNodeName(specifier.local),
                exported: exportedName,
                kind: statement.exportKind ?? 'value',
              },
            ],
          });

          dependencies.add(reexportSource);

          exports.push({
            name: exportedName,
            kind: 're-export',
            source: reexportSource,
            line: statement.loc?.start?.line ?? null,
          });
        } else {
          exports.push({
            name: exportedName,
            local: getNodeName(specifier.local),
            kind: 'named',
            exportKind: specifier.exportKind ?? 'value',
            source: null,
            line: statement.loc?.start?.line ?? null,
          });
        }
      }
    }

    if (statement.type === 'ExportDefaultDeclaration') {
      exports.push({
        name: 'default',
        kind: 'default',
        source: null,
        line: statement.loc?.start?.line ?? null,
      });
    }

    if (statement.type === 'ExportAllDeclaration') {
      const source = getStringSource(statement.source);

      if (source !== null) {
        imports.push({
          source,
          kind: 're-export-all',
          line: statement.loc?.start?.line ?? null,
          specifiers: [],
        });

        dependencies.add(source);

        exports.push({
          name: getNodeName(statement.exported) ?? '*',
          kind: 'all',
          source,
          line: statement.loc?.start?.line ?? null,
        });
      }
    }
  }

  let astNodeCount = 0;

  walkAst(ast, (node, parent) => {
    astNodeCount += 1;

    // Dynamic import: import('./module.js')
    if (
      node.type === 'ImportExpression' ||
      (
        node.type === 'CallExpression' &&
        node.callee?.type === 'Import'
      )
    ) {
      const source =
        node.type === 'ImportExpression'
          ? getStringSource(node.source)
          : getStringSource(node.arguments?.[0]);

      if (source !== null) {
        imports.push({
          source,
          kind: 'dynamic',
          line: node.loc?.start?.line ?? null,
          specifiers: [],
        });

        dependencies.add(source);
      }
    }

    // CommonJS dependency: require('./module.js')
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'require'
    ) {
      const source = getStringSource(node.arguments?.[0]);

      if (source !== null) {
        imports.push({
          source,
          kind: 'commonjs',
          line: node.loc?.start?.line ?? null,
          specifiers: [],
        });

        dependencies.add(source);
      }
    }

    if (FUNCTION_TYPES.has(node.type)) {
      const name =
        inferFunctionName(node, parent) ??
        `anonymous@${node.loc?.start?.line ?? 0}`;

      functions.push({
        name,
        kind: node.type,
        async: Boolean(node.async),
        generator: Boolean(node.generator),
        parameterCount: Array.isArray(node.params)
          ? node.params.length
          : 0,
        startLine: node.loc?.start?.line ?? null,
        endLine: node.loc?.end?.line ?? null,
        complexity: node.body
          ? calculateFunctionComplexity(node.body)
          : null,
      });
    }
  });

  return {
    imports,
    dependencies: [...dependencies].sort(),
    exports,
    declarations,
    functions,
    metrics: {
      astNodeCount,
      importCount: imports.length,
      dependencyCount: dependencies.size,
      exportCount: exports.length,
      declarationCount: declarations.length,
      functionCount: functions.length,
    },
  };
}

function getParserPlugins(file) {
  const plugins = [];
  const extension = file.extension.toLowerCase();

  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) {
    plugins.push([
      'typescript',
      {
        dts: file.path.toLowerCase().endsWith('.d.ts'),
      },
    ]);
  }

  if (['.jsx', '.tsx'].includes(extension)) {
    plugins.push('jsx');
  }

  return plugins;
}

function createSkippedRecord(file, reason) {
  return {
    path: file.path,
    language: file.language,
    parseStatus: 'skipped',
    skipReason: reason,
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

    if (totalBytesRead + file.sizeBytes > MAX_TOTAL_AST_BYTES) {
      results.push(
        createSkippedRecord(file, 'AST_READ_BUDGET_EXCEEDED'),
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
          createSkippedRecord(file, 'AST_READ_BUDGET_EXCEEDED'),
        );
        continue;
      }

      totalBytesRead += buffer.byteLength;

      const sourceCode = buffer.toString('utf8');

      try {
        const ast = parse(sourceCode, {
          sourceType: 'unambiguous',
          sourceFilename: file.path,
          plugins: getParserPlugins(file),
          attachComment: false,
          errorRecovery: false,
        });

        results.push({
          path: file.path,
          language: file.language,
          parseStatus: 'parsed',
          skipReason: null,
          parseError: null,
          ...extractModuleData(ast),
        });
      } catch (error) {
        results.push({
          path: file.path,
          language: file.language,
          parseStatus: 'parse_error',
          skipReason: null,
          parseError: {
            message: String(error.message).slice(0, 500),
            line: error.loc?.line ?? null,
            column: error.loc?.column ?? null,
            reasonCode: error.reasonCode ?? null,
          },
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
            52 + Math.floor(((index + 1) / inventory.length) * 18),
          );

    onProgress('parsing_ast', progress);
  }

  const parsedFiles = results.filter(
    (file) => file.parseStatus === 'parsed',
  );

  const summary = {
    totalFiles: results.length,
    parsedFiles: parsedFiles.length,
    parseErrors: results.filter(
      (file) => file.parseStatus === 'parse_error',
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
