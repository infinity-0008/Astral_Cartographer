const FUNCTION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
  'function_definition',
  'function_signature',
  'method_signature',
  'abstract_method_signature',
  'lambda',
]);

const SCOPE_BOUNDARIES = new Set([
  ...FUNCTION_TYPES,
  'class_declaration',
  'abstract_class_declaration',
  'class',
  'class_body',
  'class_definition',
  'statement_block',
  'block',
]);

export function walkTree(node, visit) {
  if (!node) {
    return;
  }

  visit(node);

  for (const child of node.namedChildren) {
    walkTree(child, visit);
  }
}

export function getLine(node) {
  return node ? node.startPosition.row + 1 : null;
}

export function getNodeName(node) {
  return node?.childForFieldName('name')?.text ?? null;
}

export function getStringValue(node) {
  if (!node) {
    return null;
  }

  const text = node.text;

  if (
    text.length >= 2 &&
    ['"', "'", '`'].includes(text[0]) &&
    text.at(-1) === text[0]
  ) {
    return text.slice(1, -1);
  }

  return text;
}

export function isAtModuleLevel(node, root) {
  let current = node.parent;

  while (current && current !== root) {
    if (SCOPE_BOUNDARIES.has(current.type)) {
      return false;
    }

    current = current.parent;
  }

  return current === root;
}

export function getDeclaredNames(node) {
  if (!node) {
    return [];
  }

  const directName = getNodeName(node);

  if (directName) {
    return [directName];
  }

  const names = [];

  function visit(current, isRoot = false) {
    if (
      !isRoot &&
      FUNCTION_TYPES.has(current.type)
    ) {
      return;
    }

    if (current.type === 'variable_declarator') {
      const name = current.childForFieldName('name');

      if (name) {
        names.push(name.text);
      }

      return;
    }

    for (const child of current.namedChildren) {
      visit(child);
    }
  }

  visit(node, true);

  return [...new Set(names)];
}

export function getFunctionName(node) {
  const directName = getNodeName(node);

  if (directName) {
    return directName;
  }

  const parent = node.parent;

  if (parent?.type === 'variable_declarator') {
    return parent.childForFieldName('name')?.text ?? null;
  }

  if (
    parent?.type === 'assignment_expression' ||
    parent?.type === 'assignment'
  ) {
    return parent.childForFieldName('left')?.text ?? null;
  }

  if (parent?.type === 'pair') {
    return parent.childForFieldName('key')?.text ?? null;
  }

  return null;
}

export function estimateComplexity(node, family) {
  const body = node.childForFieldName('body');

  if (!body) {
    return null;
  }

  const branches = family === 'python'
    ? new Set([
        'if_statement',
        'for_statement',
        'while_statement',
        'except_clause',
        'conditional_expression',
      ])
    : new Set([
        'if_statement',
        'for_statement',
        'for_in_statement',
        'while_statement',
        'do_statement',
        'switch_case',
        'catch_clause',
        'ternary_expression',
      ]);

  let complexity = 1;

  function visit(current, isRoot = false) {
    if (
      !isRoot &&
      FUNCTION_TYPES.has(current.type)
    ) {
      return;
    }

    if (branches.has(current.type)) {
      complexity += 1;
    }

    if (family === 'python') {
      if (current.type === 'boolean_operator') {
        complexity += 1;
      }
    } else if (current.type === 'binary_expression') {
      const operator = current.childForFieldName('operator');

      if (['&&', '||', '??'].includes(operator?.text)) {
        complexity += 1;
      }
    }

    for (const child of current.namedChildren) {
      visit(child);
    }
  }

  visit(body, true);

  return complexity;
}

export function createFunctionRecord(node, family) {
  const line = getLine(node);

  return {
    name: getFunctionName(node) ?? `anonymous@${line}`,
    kind: node.type,
    async: /^\s*async\b/.test(node.text),
    generator: node.type.includes('generator'),
    parameterCount: (
      node.childForFieldName('parameters')?.namedChildren.length ??
      (node.childForFieldName('parameter') ? 1 : 0)
    ),
    startLine: line,
    endLine: node.endPosition.row + 1,
    complexity: estimateComplexity(node, family),
  };
}