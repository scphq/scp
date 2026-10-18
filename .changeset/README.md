# Changesets

This folder holds the release queue. Every PR that changes a published package adds a changeset:

```sh
bun changeset
```

Pick the affected packages and the bump (`patch`, `minor` or `major`), then commit the generated `.changeset/*.md`.
On merge to `main`, the Release workflow opens a `chore: release` PR that applies the bumps and CHANGELOG entries;
merging that PR publishes to npm. See [docs/RELEASING.md](../docs/RELEASING.md).

Skip the changeset for test, docs and CI-only PRs.
