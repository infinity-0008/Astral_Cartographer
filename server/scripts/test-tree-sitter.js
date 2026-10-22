
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';

const testCases = [
  {
    name: 'JavaScript',
    grammar: JavaScript,
    source: `
      import express from 'express';

      export function createApp() {
        return express();
      }
    `,
  },
  {
    name: 'JSX',
    grammar: JavaScript,
    source: `
      const element = (
        <main className="app">
          Hello, Astral Cartographer
        </main>
      );
    `,
  },
  {
    name: 'TypeScript',
    grammar: TypeScript.typescript,
    source: `
      export function add(a: number, b: number): number {
        return a + b;
      }
    `,
  },
  {
    name: 'TSX',
    grammar: TypeScript.tsx,
    source: `
      type Props = { name: string };

      export function Greeting({ name }: Props) {
        return <h1>Hello, {name}</h1>;
      }
    `,
  },
  {
    name: 'Python',
    grammar: Python,
    source: `
      from pathlib import Path

      def summarize(path: str) -> str:
          return Path(path).name
    `,
  },
];

let failures = 0;

for (const testCase of testCases) {
  const parser = new Parser();

  try {
    parser.setLanguage(testCase.grammar);

    const tree = parser.parse(testCase.source);
    const hasErrors = tree.rootNode.hasError;

    console.log(
      `\n[${hasErrors ? 'FAIL' : 'PASS'}] ${testCase.name}`,
    );

    console.log(
      tree.rootNode.toString().slice(0, 350),
    );

    if (hasErrors) {
      failures += 1;
    }
  } catch (error) {
    failures += 1;

    console.error(
      `\n[FAIL] ${testCase.name}:`,
      error.message,
    );
  }
}

console.log(
  `\nResult: ${testCases.length - failures}/${testCases.length} passed`,
);

if (failures > 0) {
  process.exitCode = 1;
}
