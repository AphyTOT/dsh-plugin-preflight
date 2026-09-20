# How to submit

The community list is generated from `data/plugins/*.yml`, one file per plugin.
The READMEs are generated — **never edit them by hand**.

## One-time setup (already done in this repo)

1. Repository is named `dsh-plugin-preflight` under `AphyTOT`.
2. `package.json` declares `dsh.bundle` and carries the matching
   `repository` / `homepage` / `bugs` URLs.
3. `cordis.patch.yml` inserts the plugin into a profile's layer stack.
4. Optionally publish to npm: the published package's `repository` field must
   point back at this repo or the two are never linked and the list shows no
   download count.

## The steps that remain

1. Push this repository to GitHub and add the **`dsh-plugin`** topic in the
   repository settings. The list requires the topic, and CI checks that the
   repository is at least one day old.

2. Fork `awesome-dsh-plugin/awesome-dsh-plugin` and add exactly one file:

   ```
   data/plugins/AphyTOT__dsh-plugin-preflight.yml
   ```

   The contents are `AphyTOT__dsh-plugin-preflight.yml` in this folder. Open a
   PR. One file is the whole submission.

3. If CI fails it names what to change; push the fix to the same branch.

## Before submitting

Run the check against this repository — it verifies the same manifest rules the
list's CI does:

```sh
npx dsh-plugin-preflight .
```

## After it is listed

- The website rebuilds automatically; nothing else to touch.
- Screenshots are declared by adding `screenshots.json` **in this repository**
  (1–8 paths relative to that file). Updating them later needs no PR — the next
  nightly build picks them up.
- Updating your entry means editing only your own yml file, never the READMEs.
  A PR that rewrites another entry's description is called out by the gate.