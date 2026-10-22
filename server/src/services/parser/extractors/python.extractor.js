import {
  createFunctionRecord,
  getLine,
  getNodeName,
  isAtModuleLevel,
} from './node-utils.js';

function addImport(imports, source, kind, line) {
  if (!source) {
    return;
  }

  imports.push({
    source,
    kind,
    line,
    specifiers: [],
  });
}

function addDeclaration(declarations, name, kind, line) {
  if (!name) {
    return;
  }

  if (
    declarations.some(
      (item) =>
        item.name === name &&
        item.kind === kind &&
        item.line === line,
    )
  ) {
    return;
  }

  declarations.push({ name, kind, line });
}

function addImplicitExport(exports, name, kind, line) {
  // Python has no JavaScript-style export keyword.
  // This is a convention-based public API approximation.
  if (!name || name.startsWith('_')) {
    return;
  }

  exports.push({
    name,
    kind: 'implicit_public',
    declarationKind: kind,
    source: null,
    line,
  });
}

function extractPythonImport(node, imports) {
  const line = getLine(node);

  if (node.type === 'import_from_statement') {
    const moduleNode = node.childForFieldName('module_name');
    const source = moduleNode?.text ?? '';

    addImport(imports, source, 'python-from', line);
    return;
  }

  // Handle statements such as:
  // import os
  // import pathlib as p
  // import os, sys
  const content = node.text
    .replace(/^\s*import\s+/, '')
    .trim();

  for (const entry of content.split(',')) {
    const source = entry
      .trim()
      .split(/\s+as\s+/)[0];

    addImport(imports, source, 'python', line);
  }
}

export function extractPythonData(root, query) {
  const imports = [];
  const exports = [];
  const declarations = [];
  const functions = [];

  const seenFunctions = new Set();

  for (const capture of query.captures(root)) {
    const { name: captureName, node } = capture;
    const line = getLine(node);

    if (captureName === 'import') {
      extractPythonImport(node, imports);
      continue;
    }

    if (captureName === 'function') {
      const key = `${node.startIndex}:${node.endIndex}`;

      if (!seenFunctions.has(key)) {
        seenFunctions.add(key);

        functions.push(
          createFunctionRecord(node, 'python'),
        );
      }

      if (isAtModuleLevel(node, root)) {
        const name = getNodeName(node);

        addDeclaration(
          declarations,
          name,
          'function',
          line,
        );

        addImplicitExport(
          exports,
          name,
          'function',
          line,
        );
      }

      continue;
    }

    if (captureName === 'class') {
      if (isAtModuleLevel(node, root)) {
        const name = getNodeName(node);

        addDeclaration(
          declarations,
          name,
          'class',
          line,
        );

        addImplicitExport(
          exports,
          name,
          'class',
          line,
        );
      }

      continue;
    }

    if (captureName === 'declaration') {
      if (!isAtModuleLevel(node, root)) {
        continue;
      }

      const left = node.childForFieldName('left');
      const name = left?.text ?? null;

      addDeclaration(
        declarations,
        name,
        'variable',
        line,
      );

      addImplicitExport(
        exports,
        name,
        'variable',
        line,
      );
    }
  }

  const dependencies = [
    ...new Set(imports.map((item) => item.source)),
  ].sort();

  return {
    imports,
    dependencies,
    exports,
    declarations,
    functions,
  };
}