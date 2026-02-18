# Contributing to opencode-bridge

Thanks for contributing!

## Development workflow

1. Fork and clone the repository.
2. Create a feature branch from `main`.
3. Install dependencies: `npm ci`.
4. Run checks before pushing:
   - `npm run check`
   - `npm test`
5. Open a pull request with:
   - what changed,
   - why it changed,
   - how it was tested.

## Commit guidance

- Use clear, imperative commit messages.
- Prefer small focused commits.
- Keep unrelated changes out of the same PR.

## Pull request checklist

- [ ] Code compiles and runs locally.
- [ ] Tests added or updated where relevant.
- [ ] `npm run check` and `npm test` pass.
- [ ] Documentation updated for behavior/config changes.

## Code style

- Use strict mode in modules where applicable.
- Prefer small pure helper functions for parser/transform logic.
- Avoid introducing breaking API changes without explicit documentation.
