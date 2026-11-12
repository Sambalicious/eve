import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import boundaries from 'eslint-plugin-boundaries'
import { defineConfig, globalIgnores } from 'eslint/config'

// Feature-Sliced Design layers, top to bottom. "components" replaces FSD's
// "widgets" layer by project convention (docs/adr/0003). A layer may import
// only from layers below it, and slices only through their index.ts.
const layers = ['app', 'pages', 'components', 'features', 'entities', 'shared']
const sliced = ['pages', 'components', 'features', 'entities']

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'import/resolver': { typescript: { project: './tsconfig.app.json' } },
      'boundaries/include': ['src/**/*'],
      'boundaries/elements': [
        { type: 'app', pattern: 'src/app' },
        ...layers.slice(1, 5).map((type) => ({
          type,
          pattern: `src/${type}/*`,
          capture: ['slice'],
        })),
        { type: 'shared', pattern: 'src/shared' },
      ],
    },
    rules: {
      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          // also check imports between files of the same slice
          checkInternals: true,
          policies: [
            ...layers.map((type, i) => ({
              from: { element: { type } },
              allow: {
                to: [
                  // lower layers, through a slice's index.ts only
                  ...layers.slice(i + 1).map((lower) =>
                    sliced.includes(lower)
                      ? { element: { type: lower, fileInternalPath: 'index.ts' } }
                      : { element: { type: lower } },
                  ),
                  // the same slice (or the same unsliced layer)
                  sliced.includes(type)
                    ? { element: { type, captured: { slice: '{{ from.element.captured.slice }}' } } }
                    : { element: { type } },
                ],
              },
            })),
          ],
        },
      ],
    },
  },
  {
    // Rendering components take props and call callbacks. Data access stays in
    // api/ and model/ files, pages, and the app layer (frontend-engineer.md, rule 1).
    files: ['src/**/*.tsx'],
    ignores: ['src/app/**', 'src/**/*-page.tsx', 'src/**/*.test.tsx', 'src/shared/testing/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@tanstack/react-query', message: 'Use a hook from the slice model, or move this to the page.' },
            { name: '@/shared/api', message: 'Call the API from an api/ or model/ file, not a component.' },
          ],
        },
      ],
    },
  },
  {
    // shadcn/ui files export variants and hooks next to their components by design
    files: ['src/shared/ui/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
