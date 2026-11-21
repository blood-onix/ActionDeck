# Contributing to ActionDeck

Bug reports and ideas are welcome in [GitHub Issues](https://github.com/blood-onix/ActionDeck/issues). For security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

Requirements: Node.js 22 and desktop VS Code 1.96 or newer.

```sh
npm ci
npm run typecheck
npm run compile
npm test
npm run test:integration
```

Press **F5** in VS Code to launch an Extension Development Host, then run **ActionDeck: Open Dashboard**.

## Building a package

```sh
npm run package
```

This creates `actiondeck-<version>.vsix`, which you can install with **Extensions: Install from VSIX...**.

## Releasing (maintainers)

Releases are published by the `Release` workflow when a version tag is pushed:

```sh
npm version patch   # or minor / major
git push --follow-tags
```

Update [CHANGELOG.md](CHANGELOG.md) before tagging.
