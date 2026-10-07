import antfu from '@antfu/eslint-config';

export default antfu(
  {
    type: 'lib',
    typescript: true,
    vue: true,
    // Tests use node:test, not Vitest. pnpm-workspace.yaml only approves builds.
    test: false,
    pnpm: false,
    stylistic: {
      indent: 2,
      quotes: 'single',
      semi: true,
    },
    formatters: {
      css: true,
      html: true,
      markdown: true,
      svg: true,
    },
    ignores: [
      'package-lock.json',
      'pnpm-lock.yaml',
      'migrations/**',
    ],
  },
  {
    rules: {
      // Node's ESM runtime provides these globals. The suggested fix is a CommonJS require().
      'node/prefer-global/process': 'off',
      'node/prefer-global/buffer': 'off',
    },
  },
  {
    files: ['src/main.ts', 'examples/**/*.ts', 'playground/**/*.ts', 'playground/**/*.vue'],
    rules: {
      'no-console': 'off',
      'antfu/no-top-level-await': 'off',
    },
  },
  {
    files: ['test/**/*.ts', 'playground/**/*.ts', 'playground/**/*.vue'],
    rules: {
      'ts/explicit-function-return-type': 'off',
    },
  },
);
