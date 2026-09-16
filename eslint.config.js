/**
 * Lint rules for the whole monorepo.
 *
 * Deliberately not a formatter. The codebase is already consistently formatted
 * and `.editorconfig` covers whitespace, so adding Prettier would reformat
 * ~27k lines and bury every real change under it. These rules are here to catch
 * mistakes and to stop the duplication this repository has accumulated from
 * growing back — nothing here is about style for its own sake.
 *
 * Type-aware linting is on (`projectService`), which is what makes
 * `no-floating-promises` possible: this app fires a lot of work off
 * deliberately, and the difference between `void save()` and a forgotten
 * `await save()` is invisible without types.
 */

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'apps/web/dev-dist/**',
      'apps/web/public/**',
      'apps/web/src/vendor/**',
      'packages/shared/dist/**',
      'apps/ios/.expo/**',
      'apps/ios/ios/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The codebase already marks fire-and-forget work with `void`; this keeps
      // an accidental unawaited promise from slipping in among them.
      '@typescript-eslint/no-floating-promises': 'error',

      // `catch (error: unknown)` is the house style and every handler narrows
      // before use, so the base rule has nothing to add.
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',

      // Prefixing with an underscore is the established way to say "required by
      // the signature, deliberately unused" (e.g. `_request` in route handlers).
      // `ignoreRestSiblings` covers the companion idiom of destructuring a key
      // out only to drop it from a `...rest` spread (e.g. `const { base64,
      // ...rest } = result`) — the "unused" binding is the point there.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],

      // Almost every hit is one of two deliberate patterns: a redundant `as`
      // left over from a narrower type that TS later inferred on its own (21
      // of them, half in apps/server which this track does not touch), or
      // routine drift as the codebase evolves. None change runtime behaviour,
      // so this is downgraded rather than fixed by hand across three
      // workspaces — a later cleanup pass can chase these down.
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',

      // `require-await` fires mainly on two intentional shapes: Fastify route
      // handlers that are `async` only because the framework's handler type
      // expects it, and this app's view functions, which are `async () =>
      // Promise<HTMLElement>` to match the router's contract even when a
      // given view has no top-level `await` (see `pairScanView`). Neither is
      // a bug.
      '@typescript-eslint/require-await': 'off',

      // `String(x)` on a value typed `unknown`/mixed is this codebase's
      // deliberate, permissive-rendering idiom: the DOM helper (`core/dom.ts`)
      // stringifies whatever `text`/`dataset` value it is handed, and error
      // normalisation (`core/debug-log.ts`, `sync/client.ts`) stringifies
      // whatever a caught value or `error.cause` turned out to be. Getting
      // `[object Object]` in a debug log is an acceptable outcome for a value
      // that had no better representation; it is not the bug this rule hunts.
      '@typescript-eslint/no-base-to-string': 'off',

      // The two sources of every hit are `JSON.parse(...)` (which is `any` by
      // definition — there is no safe alternative without a schema
      // validator) and the untyped `@techstark/opencv-js` surface used in
      // `cv/pipeline.ts` (its enum-like constants such as `cv.INTER_AREA` are
      // not typed as literal numbers upstream, so every value built from them
      // reads as `any`). Neither is a real type-safety hole in *this* code.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',

      // Every hit here is the same shape: an `async` function handed directly
      // to a DOM event slot (`on: { click: async () => … }` /
      // `addEventListener('click', async () => …)`) instead of being wrapped
      // in `void`. That is a deliberate, repeated house style, not a
      // forgotten `void` — a click handler's rejection is not "floating", it
      // reaches the app's global `unhandledrejection` listener
      // (`core/debug-log.ts`), which logs it. `checksVoidReturn` is narrowed
      // to skip exactly those two positions (object properties and call
      // arguments) so the rule keeps checking every other misuse.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, properties: false } },
      ],

      // Swedish receipts use non-breaking and thin spaces, and non-ASCII
      // minus signs, as thousands separators and dashes; `orgnumber.ts` and
      // `parse.ts` match them on purpose inside regex character classes.
      // `skipRegExps` leaves the rule free to still catch an accidental
      // irregular space pasted into ordinary code.
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
    },
  },

  // Plain JavaScript: build scripts and the browser verification harness. There
  // is no type information for these, so the type-aware rules cannot run.
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    files: ['apps/web/e2e/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  {
    files: ['apps/ios/metro.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    files: ['apps/ios/src/ui/sf-symbol.tsx'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    files: ['apps/ios/**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        __DEV__: 'readonly',
      },
    },
  },

  // `packages/shared/test/**` and `apps/server/test/**` run straight through
  // `node --experimental-strip-types` and are not in either workspace's
  // tsconfig `include`, so `projectService` cannot build a program for them
  // (a parsing error, not a lint finding). Widening those tsconfigs is out of
  // scope here — apps/server is untouched by this track, and doing it only
  // for packages/shared would be inconsistent — so these fall back to
  // non-type-aware linting instead. (`apps/web/test/**` is different: its
  // tsconfig gained `test/**/*.ts` in its `include`, so it gets full
  // type-aware linting like the rest of `apps/web`.)
  {
    files: ['packages/*/test/**/*.ts', 'apps/server/test/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Views describe *what* a screen shows; the vocabulary of how it looks lives
  // in the stylesheet. Inline `style:` strings are how this codebase grew many
  // copies of the same tinted, centred action row — `components/ui.ts` has the
  // helpers now, so reach for those instead of restating the CSS.
  //
  // 'error', not 'warn': the views have been migrated to those helpers and the
  // inline strings are gone, so a new one is a regression, not a backlog item.
  {
    files: ['apps/web/src/views/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='style'][value.type='Literal']",
          message:
            'Use a CSS class and a helper from components/ui.ts rather than an inline style string.',
        },
      ],
    },
  },
);
