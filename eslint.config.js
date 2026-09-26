import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'docs/.vitepress/cache/**', 'docs/.vitepress/dist/**', 'playground/.vite-dist/**'] },
  ...tseslint.configs.recommended,
);
