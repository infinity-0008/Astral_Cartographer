import assert from 'node:assert/strict';

import {
  parseSource,
} from '../src/services/parser/tree-sitter.engine.js';

// JavaScript: static imports, CommonJS, exports, and functions.
const js = parseSource(
  `
  import express from 'express';
  const path = require('node:path');

  export function createApp() {
    if (express) {
      return path;
    }

    return null;
  }
  `,
  '.js',
);

assert.equal(js.hasSyntaxErrors, false);
assert(js.dependencies.includes('express'));
assert(js.dependencies.includes('node:path'));
assert(js.functions.some((fn) => fn.name === 'createApp'));
assert(js.exports.some((item) => item.name === 'createApp'));

// JSX: the JavaScript grammar must accept JSX syntax.
const jsx = parseSource(
  `
  export function Page() {
    return <main>Hello</main>;
  }
  `,
  '.jsx',
);

assert.equal(jsx.hasSyntaxErrors, false);
assert(jsx.functions.some((fn) => fn.name === 'Page'));

// TypeScript: interfaces and typed functions.
const ts = parseSource(
  `
  export interface User {
    name: string;
  }

  export function greet(user: User): string {
    return user.name;
  }
  `,
  '.ts',
);

assert.equal(ts.hasSyntaxErrors, false);
assert(ts.declarations.some((item) => item.name === 'User'));
assert(ts.functions.some((fn) => fn.name === 'greet'));
assert(ts.exports.some((item) => item.name === 'User'));

// TSX: TypeScript types together with JSX.
const tsx = parseSource(
  `
  type Props = { name: string };

  export function Greeting({ name }: Props) {
    return <h1>Hello, {name}</h1>;
  }
  `,
  '.tsx',
);

assert.equal(tsx.hasSyntaxErrors, false);
assert(tsx.functions.some((fn) => fn.name === 'Greeting'));

// Python: imports, functions, classes, and public declarations.
const python = parseSource(
  `
  from pathlib import Path
  import os as operating_system

  def summarize(path: str) -> str:
      return Path(path).name

  class Repository:
      pass
  `,
  '.py',
);

assert.equal(python.hasSyntaxErrors, false);
assert(python.dependencies.includes('pathlib'));
assert(python.dependencies.includes('os'));
assert(python.functions.some((fn) => fn.name === 'summarize'));
assert(python.declarations.some((item) => item.name === 'Repository'));
assert(python.exports.some((item) => item.name === 'Repository'));

console.log('Tree-sitter extraction tests passed.');
console.log({
  javascript: js.metrics,
  jsx: jsx.metrics,
  typescript: ts.metrics,
  tsx: tsx.metrics,
  python: python.metrics,
});