# dsh-plugin-preflight

English | [中文](README.zh.md)

Check a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin **before** you submit it to the
[community list](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) — or before you publish it at all.

```sh
npx dsh-plugin-preflight              # check the current directory
npx dsh-plugin-preflight path/to/repo # check somewhere else
npx dsh-plugin-preflight --strict     # fail on warnings too, for CI
```

Exit code is `0` when nothing blocks a submission and `1` when something does, so it drops straight into a workflow.

## What it catches

The list's own [contributing guide](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) is the
specification. These are the parts of it a machine can verify:

| Rule | Why it matters |
|---|---|
| `bundle/missing` | Declaring only `dsh.client` is **the most common reason a submission is rejected** — `dsh.bundle` is what makes a plugin installable |
| `bundle/patch-missing` | `dsh.bundle.patch` points at a file that does not exist |
| `patch/no-name`, `patch/name-mismatch` | The patch layer inserts no row, or a row named something that is not this package — nothing mounts |
| `patch/id-missing` | Rows without a stable `id` cannot be targeted by a later patch layer |
| `client/export-missing`, `client/bundle-missing` | Declares `dsh.client` but ships no `./client` export — the client module system throws |
| `client/loader-missing`, `client/id-mismatch` | A client bundle must be a lazy-CJS factory registering `window.__ModuleLoader__.load({ id, factory })` under the package's own name |
| `client/external-self` | A row that lists its own package in `dsh.client.external` makes composition throw |
| `deps/host-packages` | `@deepseek-ai/*` services belong in `peerDependencies`, not `dependencies` |
| `peer/prerelease-tuple` | The range does not match the harness you actually have installed — see below |
| `peer/wildcard` | A bare `*` matches no prerelease at all |
| `files/bin-uncovered` | The CLI is not in `files[]`, so it vanishes from the published tarball |
| `manifest/*`, `description/*`, `metadata/*` | BOM-corrupted or unparseable manifests, marketing language, unverifiable counts, missing `repository.url` |

## The prerelease trap

This is the reason the tool exists, and it is not obvious.

DeepSeek Harness ships **prerelease** versions (`0.1.5-rc.2`). node-semver admits a prerelease version only when
*some comparator in the range sits on that version's exact `major.minor.patch` tuple **and** carries its own
prerelease tag*. So a range that looks generous can silently exclude the harness your users actually run:

```
"*"                  does NOT match 0.1.5-rc.2
">=0.1.0-rc.1"       does NOT match 0.1.5-rc.2
"^0.1.0-rc.6"        does NOT match 0.1.5-rc.2
"^0.1.5-rc.1"        DOES match
">=0.1.5-rc.1 <0.2.0-0"  DOES match
```

The failure surfaces later as an `ERESOLVE` your users have to work around by hand.

**Run the check inside a dsh profile** and it resolves the harness version installed there and tells you concretely
whether your range admits it:

```
x [peer/prerelease-tuple] peer "@deepseek-ai/dsh-tools": "^0.2.0" does NOT match
  the installed @deepseek-ai/dsh-tools@0.1.5-rc.2
    fix: e.g. ">=0.1.5-0 <0.2.0-0"
```

### What it deliberately does not claim

Outside a profile there is no version to compare against, and **the tool stays silent rather than guessing**. That
restraint is a feature, not a gap: three earlier attempts at inferring a target version each reported a correct
manifest as broken — probing a range's own tuple with `-rc.1` lands below a `^0.1.5-rc.2` lower bound; probing with
the registry's newest prerelease lands above a range that deliberately stops before it; and testing stable-only
packages flagged `^4.0.1` on `cordis` as broken. A linter that invents findings to look thorough is worse than one
that admits what it cannot see.

The one claim made without an installed harness is `peer/wildcard`: a bare `*` has no prerelease-tagged comparator on
any tuple, so npm rejects it for every prerelease.

## Measured against the real catalog

A survey of 400 npm-published plugins drawn from the live catalog:

```
declaring a @deepseek-ai/dsh-* peer : 194
  bare wildcard "*"                 :  21   (10.8%)   <- confirmed broken
  silent (no claim made)            : 173
```

`dsh-market`, the most-installed plugin in the ecosystem, reports no findings — its four-branch peer ranges are
correct.

## Install as a DSH plugin

```sh
dsh plugin --profile web add dsh-plugin-preflight
```

This adds one read-only, model-facing tool so an agent scaffolding a plugin can check its own work:

```
plugin_preflight(dir)
```

There is **no browser half and no settings page** on purpose — this is a developer diagnostic, and a panel for it
would be UI noise.

## Limitations

- Checks are structural. It cannot tell whether a plugin does what its description claims — a maintainer reads the
  repository for that, and counting the "46 tools" in a description is still a person's job.
- Repository age (the list's one-day bar) and the `dsh-plugin` GitHub topic are not checked. Both need the GitHub
  API, and neither is worth a network dependency in a check you run on every commit.
- No dependency-tree integrity checks. Broken `node_modules` layout is a different failure class with its own tooling.

## License

MIT