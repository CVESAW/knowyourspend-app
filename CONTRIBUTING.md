# Contributing

Thanks for helping. The most useful things right now:

- **Your bank's file format.** If your bank's CSV or PDF statement isn't read properly, open an issue with
  the bank's name and the column headings or layout. Don't attach a real statement: change every amount,
  date, name and number first, or describe it. Readers live in `packages/statement/src`, with tests and
  made-up fixtures in `packages/statement/test`.
- **An owner that's wrong.** Open an issue (or a pull request against `packages/ownership/data`) with the
  shop, the correct ultimate owner and a source we can check, such as the company's own page, its annual
  report or a register entry. Run `pnpm --filter @kys/ownership validate` after editing the data.
- **The reader, the matcher and the app.** Bug fixes and tests are welcome. Please keep the core promise:
  nothing a person adds leaves their device unless they've chosen to send it, and any new request is shown
  to them first and listed in the README.

## Before you open a pull request

```bash
pnpm install
pnpm -r test
pnpm -r typecheck
pnpm --filter site test
```

The end-to-end test (`pnpm --filter mobile build:web && pnpm --filter mobile e2e`) also fails if the app
contacts any address that isn't allowed.

By contributing, you agree your contribution is released under the MIT licence (see LICENSE).
