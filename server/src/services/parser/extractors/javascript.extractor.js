import {
  createFunctionRecord,
  getDeclaredNames,
  getLine,
  getNodeName,
  getStringValue,
  isAtModuleLevel,
  walkTree,
} from './node-utils.js';

const FUNCTION_DECLARATIONS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
]);

const CLASS_DECLARATIONS = new Set([
  'class_declaration',
  'abstract_class_declaration',
]);

const TYPE_DECLARATIONS = new Set([
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
]);

function getCaptures(query, root) {
  return query.captures(root);
}

function addImport(imports, source, kind, line) {
  if (source === null || source === '') {
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

  const alreadyPresent = declarations.some(
    (item) =>
      item.name === name &&
      item.kind === kind &&
      item.line === line,
  );

  if (!alreadyPresent) {
    declarations.push({ name, kind, line });
  }
}

function addExportsFromStatement(
  node,
  imports,
  exports,
) {
  const text = node.text;
  const line = getLine(node);

  const sourceNode = node.childForFieldName('source');
  const source = sourceNode
    ? getStringValue(sourceNode)
    : null;

  if (source) {
    addImport(imports, source, 're-export', line);
  }

  // export default function / class / expression
  if (/^\s*export\s+default\b/.test(text)) {
    const declaration = node.childForFieldName('declaration');
    const localNames = getDeclaredNames(declaration);

    exports.push({
      name: 'default',
      local: localNames[0] ?? null,
      kind: 'default',
      source,
      line,
    });

    return;
  }

  // export * from './module.js'
  if (/^\s*export\s+(?:type\s+)?\*/.test(text)) {
    exports.push({
      name: '*',
      kind: 'all',
      source,
      line,
    });

    return;
  }

  const declaration = node.childForFieldName('declaration');

  if (declaration) {
    for (const name of getDeclaredNames(declaration)) {
      exports.push({
        name,
        local: name,
        kind: 'named',
        source: null,
        line,
      });
    }

    return;
  }

  // export { localName, localName as publicName }
  const braceContent = text.match(/\{([\s\S]*?)\}/)?.[1];

  if (braceContent === undefined) {
    return;
  }

  for (const rawSpecifier of braceContent.split(',')) {
    const specifier = rawSpecifier
      .trim()
      .replace(/^type\s+/, '');

    if (!specifier) {
      continue;
    }

    const [local, exported] = specifier
      .split(/\s+as\s+/);

    exports.push({
      name: exported ?? local,
      local,
      kind: source ? 're-export' : 'named',
      source,
      line,
    });
  }
}

export function extractJavaScriptData(root, query, family) {
  const imports = [];
  const exports = [];
  const declarations = [];
  const functions = [];

  const seenFunctions = new Set();

  for (const capture of getCaptures(query, root)) {
    const { name: captureName, node } = capture;
    const line = getLine(node);

    if (captureName === 'import') {
      const sourceNode =
        node.childForFieldName('source') ??
        node.namedChildren.find(
          (child) => child.type === 'string',
        );

      addImport(
        imports,
        getStringValue(sourceNode),
        'static',
        line,
      );

      continue;
    }

    if (captureName === 'export') {
      addExportsFromStatement(
        node,
        imports,
        exports,
      );

      continue;
    }

    if (captureName === 'function') {
      const key = `${node.startIndex}:${node.endIndex}`;

      if (!seenFunctions.has(key)) {
        seenFunctions.add(key);

        functions.push(
          createFunctionRecord(node, family),
        );
      }

      if (
        FUNCTION_DECLARATIONS.has(node.type) &&
        isAtModuleLevel(node, root)
      ) {
        for (const declaredName of getDeclaredNames(node)) {
          addDeclaration(
            declarations,
            declaredName,
            'function',
            line,
          );
        }
      }

      continue;
    }

    if (captureName === 'class') {
      if (
        CLASS_DECLARATIONS.has(node.type) &&
        isAtModuleLevel(node, root)
      ) {
        addDeclaration(
          declarations,
          getNodeName(node),
          'class',
          line,
        );
      }

      continue;
    }

    if (captureName === 'type') {
      if (isAtModuleLevel(node, root)) {
        addDeclaration(
          declarations,
          getNodeName(node),
          node.type,
          line,
        );
      }

      continue;
    }

    if (captureName === 'declaration') {
      if (!isAtModuleLevel(node, root)) {
        continue;
      }

      let kind = 'variable';

      if (/^\s*const\b/.test(node.text)) {
        kind = 'const';
      } else if (/^\s*let\b/.test(node.text)) {
        kind = 'let';
      } else if (/^\s*var\b/.test(node.text)) {
        kind = 'var';
      }

      for (const declaredName of getDeclaredNames(node)) {
        addDeclaration(
          declarations,
          declaredName,
          kind,
          line,
        );
      }
    }
  }

  // Static syntax captures do not include require() and import().
  // Inspect call expressions for literal module names.
  walkTree(root, (node) => {
    if (node.type !== 'call_expression') {
      return;
    }

    const callee = node.childForFieldName('function');
    const argumentsNode = node.childForFieldName('arguments');
    const firstArgument = argumentsNode?.namedChildren[0];

    if (
      !callee ||
      !firstArgument ||
      !['string', 'template_string'].includes(firstArgument.type)
    ) {
      return;
    }

    const source = getStringValue(firstArgument);

    if (callee.text === 'require') {
      addImport(imports, source, 'commonjs', getLine(node));
    } else if (callee.text === 'import') {
      addImport(imports, source, 'dynamic', getLine(node));
    }
  });

  // JavaScript/TypeScript module exports are explicit, so we can
  // use export statements rather than assuming every public name
  // is automatically exported.
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