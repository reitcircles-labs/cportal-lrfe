# Coding guide

All code in this repository follows the
[Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html), so that any
developer can read and change it easily. The web app (`angular-app/`) and the end-to-end tests
(`e2e/`) follow the guide as written. The backend (`backend/`) is JavaScript and follows the parts
of the guide that apply to JavaScript.

A linter (ESLint) and a formatter (Prettier) check most of the rules below, so you don't need to
remember them. Rules marked *(review)* can't be checked by a tool; the code review looks for them.
Both tools are set up once, at the root of the repository, for all three folders, so the checks run
from the root and not from inside `angular-app/`, `backend/` or `e2e/`. Besides the rules below,
the recommended rule sets of ESLint, typescript-eslint and angular-eslint are on: they catch
mistakes such as unused variables.

## Running the checks

From the root of the repository:

```bash
npm ci                              # once, and again when package-lock.json changes
npm run lint                        # all lint findings
npx eslint backend/services/audit   # one folder only
npm run lint:fix                    # fixes what can be fixed safely, such as prefer-const
npm run format:check                # files that are not formatted
npx prettier --write <path>         # formats a file or folder
npm run lint:report                 # findings and unformatted files per area, as a table
```

The checks also run in CI on every pull request and every push to main, and they are
**blocking**: a lint error or an unformatted file fails the build. Run `npm run lint` and
`npm run format:check` before you commit. Lint warnings, such as a missing JSDoc comment, are
shown but do not fail the build.

## The rules, in short

**Names**
- Descriptive names, without unclear abbreviations: `recordVersion`, not `rv` *(review)*.
- `lowerCamelCase` for variables, functions and methods; `UpperCamelCase` for classes, interfaces,
  types and enums; `CONSTANT_CASE` for module-level constants that never change and for enum
  values. No `_` at the start or end of a name, except for a parameter that is deliberately unused,
  or `_` alone for a loop variable that is never read (`for await (const _ of stream) {}` drains a
  stream).
- Data keeps its own names. Database columns and API payloads may use `snake_case`, and we don't
  rename them.

**Statements and blocks**
- One statement per line, and one variable per declaration.
- Braces on every block. An `if` that fits on one line may leave them out. If the formatter wraps
  such an `if` onto two lines, `npm run lint:fix` adds the braces.
- No long chains of ternaries and no dense one-liners. Write an `if`, or a small named function
  *(review)*.

**Variables and comparisons**
- `const` by default, `let` when the value changes, never `var`. A destructuring stays `let` when
  one of its names changes later.
- `===` and `!==`. The one exception is `== null`, which covers both `null` and `undefined`.
- TypeScript: no `any` without a reason (a warning). When `any` is needed, add a comment saying
  why *(review)*.

**Modules**
- Named exports only, never `export default`. Tool configuration files such as
  `eslint.config.mjs` and `playwright.config.ts` are the exception, because the tools require it.
- Imports at the top, grouped: Node built-ins, then packages, then our own files *(review)*.

**TypeScript types**
- `interface` for object types, not `type X = {...}`.
- `T[]` for simple types; `Array<T>` for complex ones, for example `Array<string | number>`.
- No `public` modifier, since members are public by default. Use `private` rather than
  `#private` fields and methods, and a plain `enum` rather than `const enum`.

**Comments**
- JSDoc (`/** ... */`) on every exported function and class, including
  `export const f = () => ...`: what it does, in a sentence. This is a warning.
- Comments explain *why*, not *what* the next line does *(review)*.

**Size** *(review)*
- Small functions and files, each with one clear purpose. When a file grows past a few hundred
  lines, look for a part that can move to its own file.

**Formatting**
- Prettier does it: 80 columns, single quotes, trailing commas, as in Google's own `gts` preset.
  The settings are in `.prettierrc.json`. Angular templates, inline or in `.component.html` files,
  are not reformatted: whitespace in a template can change what is shown.

## What the checks leave alone

- `@angular-eslint/prefer-on-push-component-change-detection` is off. Switching a component to
  `OnPush` changes when its screen updates. That is a behaviour change, not a style change, so it
  is decided component by component.
- `preserve-caught-error` is off. Attaching the original error as `cause` when rethrowing changes
  what gets logged and returned, so it is decided case by case.
- Markdown, YAML, generated and installed files, and a few folders such as `deploy/` are not
  formatted. The full list is in `.prettierignore`.

## Changing old code

All code follows this guide. The existing code was brought in line area by area in epic API-679;
those changes were style only: no change to behaviour, routes, payloads, events, database columns,
UI text or the labels the e2e tests look for. Do the same when you tidy old code: keep style changes
separate from changes in behaviour.
