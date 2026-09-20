/**
 * The preflight checks themselves. Pure Node, no runtime dependencies, no host
 * packages, safe to run from a CLI in any repository.
 *
 * Every finding is one of:
 *   error   — the community list's CI will reject this, or it cannot install
 *   warning — installs, but will misbehave or get sent back in review
 *   info    — worth knowing before submitting
 *
 * @module dsh-plugin-preflight/check
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute, sep } from 'node:path';
import { createRequire } from 'node:module';
import { satisfies, parseVersion, suggestRange, isPrerelease } from './semver.js';

export const REPORT_SCHEMA = 'dsh-plugin-preflight/v1';

/**
 * Packages that publish prereleases exclusively.
 *
 * `@deepseek-ai/dsh-*` sits on a prerelease line (0.1.5-rc.2 and friends) because the
 * harness itself is pre-1.0, so every version a plugin author can target carries a tag.
 * Sibling packages such as `cordis` and `schemastery` ship stable releases and are
 * deliberately NOT matched here.
 */
const PRERELEASE_ONLY = /^@deepseek-ai\/dsh-/;
/** Marketing words the list explicitly rejects in a description. */
const MARKETING = /\b(?:best|amazing|awesome|powerful|ultimate|revolutionary|seamless|blazing|world-class|cutting-edge|state-of-the-art|game-chang|effortless|unmatched|leading)\b/i;
const MARKETING_ZH = /(?:最强|最好|最强|极致|颠覆|革命性|无敌|完美|震撼|顶级|一流)/;

/** `dsh.client.external` only adds requests BEYOND the shell's seeded base. */
const PLATFORM_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives',
]);

function readJson(path) {
  // Strip a UTF-8 BOM. JSON.parse does not skip one, and a BOM-prefixed package.json
  // makes the DSH Loader throw on the plugin's own manifest at mount time.
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function readText(path) {
  try {
    return { value: readFileSync(path, 'utf8') };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Locate a package manifest without requiring the package to be installed.
 * Walks `node_modules` upward from the plugin directory, then the shell's own
 * root as a last resort, which is where the harness keeps its bundled packages.
 */
function resolvePackageJson(packageName, fromDir) {
  const parts = packageName.split('/');
  let dir = resolve(fromDir);
  for (;;) {
    const candidate = join(dir, 'node_modules', ...parts, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The version of an installed host package, or null when it cannot be resolved. */
function hostVersionOf(packageName, fromDir) {
  const manifestPath = resolvePackageJson(packageName, fromDir);
  if (manifestPath === null) return null;
  const parsed = readJson(manifestPath);
  if (parsed.error !== undefined) return null;
  const version = parsed.value?.version;
  return typeof version === 'string' && version !== '' ? version : null;
}

/** The running `dsh` shell version, used to make advice concrete. */
export function resolveHostVersion(pluginDir) {
  for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/cordis', '@deepseek-ai/dsh']) {
    const version = hostVersionOf(name, pluginDir);
    if (version !== null) return { package: name, version };
  }
  return null;
}

/** Strip a leading `./` so path comparisons are about the same file. */
function normalizeRelative(spec) {
  return typeof spec === 'string' ? spec.replace(/^\.\//, '') : spec;
}

/** Collect a single `name:` value out of a target row in cordis.patch.yml. */
function patchNames(text) {
  // Match `name:` only, at the start of a line, tolerating a list marker, a sibling
  // `id:` line above, and a trailing comment. A non-greedy capture without the comment
  // group swallows the rest of the line and silently under-reports names.
  return [...text.matchAll(/^[ \t]*(?:-[ \t]+)?name:[ \t]*['"]?([^'"\r\n#]+?)['"]?[ \t]*(?:#.*)?$/gm)]
    .map((m) => m[1].trim())
    .filter((n) => n !== '');
}

/** Count `id:` rows, used to notice entries that were never given an id. */
function patchIdCount(text) {
  return [...text.matchAll(/^[ \t]*(?:-[ \t]+)?id:[ \t]*['"]?([^'"\r\n#]+?)['"]?[ \t]*(?:#.*)?$/gm)].length;
}

/**
 * Run every check against a plugin repository.
 *
 * @param {object} [options]
 * @param {string} [options.dir] - repository root; defaults to the current directory
 * @returns {{schema:string, dir:string, host:object|null, findings:Array, summary:object}}
 */
export async function check(options = {}) {
  const dir = resolve(options.dir ?? process.cwd());
  const findings = [];
  const add = (level, rule, message, fix) => {
    findings.push(fix === undefined ? { level, rule, message } : { level, rule, message, fix });
  };

  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) {
    add('error', 'manifest/missing', `no package.json at ${manifestPath}`, 'run this from the root of your plugin repository');
    return buildReport(dir, null, findings);
  }

  const parsedManifest = readJson(manifestPath);
  if (parsedManifest.error !== undefined) {
    add('error', 'manifest/unparseable', `package.json is not valid JSON: ${parsedManifest.error}`);
    return buildReport(dir, null, findings);
  }
  const pkg = parsedManifest.value;
  const pkgName = typeof pkg.name === 'string' ? pkg.name : null;

  const host = resolveHostVersion(dir);

  // ── installability: the #1 reason submissions are rejected ────────────────
  const dsh = pkg.dsh !== null && typeof pkg.dsh === 'object' ? pkg.dsh : undefined;
  const bundle = dsh?.bundle;
  const patchSpec = bundle !== null && typeof bundle === 'object' ? bundle.patch : undefined;

  if (bundle === undefined) {
    add(
      pkg.dsh?.client !== undefined ? 'error' : 'warning',
      'bundle/missing',
      pkg.dsh?.client !== undefined
        ? 'declares dsh.client but NOT dsh.bundle — this is the most common rejection reason, and dsh.client alone is not installable'
        : 'no dsh.bundle declaration — the plugin cannot be installed with `dsh plugin add` and will not be listed',
      '"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }',
    );
  } else if (typeof patchSpec !== 'string' || patchSpec === '') {
    add('error', 'bundle/patch-spec', 'dsh.bundle.patch must be a non-empty string path', '"bundle": { "patch": "./cordis.patch.yml" }');
  } else if (!existsSync(join(dir, normalizeRelative(patchSpec)))) {
    add('error', 'bundle/patch-missing', `dsh.bundle.patch points at "${patchSpec}", which does not exist`, `create ${patchSpec}`);
  }

  // The patch layer is validated independently of the bundle declaration: a manifest
  // can forget dsh.bundle while still shipping a patch, and that patch is exactly
  // where a wrong row name hides. Falling back to the conventional filename keeps
  // the check useful on a repository that has not been wired up yet.
  const patchPath = resolvePatchPath(dir, patchSpec);
  if (patchPath !== null) {
    const patch = readText(patchPath.full);
    if (patch.error === undefined) validatePatch(dir, patch.value, patchPath.label, pkgName, add);
  }

  if (pkgName === null) {
    add('error', 'manifest/name', 'package.json has no "name"');
  } else if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkgName)) {
    add('error', 'manifest/name', `"${pkgName}" is not a valid npm package name`);
  }

  // ── declared files must survive npm pack ─────────────────────────────────
  const bin = pkg.bin;
  const files = Array.isArray(pkg.files) ? pkg.files : null;
  if (bin !== null && typeof bin === 'object' && files !== null) {
    const binPaths = Object.values(bin).filter((v) => typeof v === 'string');
    const uncovered = binPaths.filter((p) => !files.some((f) => normalizeRelative(p) === normalizeRelative(f) || p.startsWith(f.endsWith('/') ? f : `${f}/`)));
    if (uncovered.length > 0) {
      add('error', 'files/bin-uncovered', `files[] does not include the bin entry ${uncovered.map((p) => `"${p}"`).join(', ')} — the CLI disappears from the published tarball`, 'add the bin directory to files[]');
    }
  }

  // ── client half ──────────────────────────────────────────────────────────
  const client = dsh?.client;
  if (client !== undefined) {
    if (client === null || typeof client !== 'object') {
      add('error', 'client/shape', 'dsh.client must be an object');
    } else {
      if (typeof client.platform !== 'string') add('error', 'client/platform', 'dsh.client.platform must be a string', '"client": { "platform": "web" }');
      else if (client.platform !== 'web') add('warning', 'client/platform', `dsh.client.platform is "${client.platform}"; only "web" bundles are served by the web shell`);
      if (client.inject !== undefined && !Array.isArray(client.inject)) add('error', 'client/inject', 'dsh.client.inject must be an array of service names');
      if (client.external !== undefined && !Array.isArray(client.external)) add('error', 'client/external', 'dsh.client.external must be an array of module requests');

      const clientExport = pkg.exports?.['./client'];
      const clientRel = typeof clientExport === 'string' ? clientExport
        : (clientExport !== null && typeof clientExport === 'object' ? (clientExport.default ?? clientExport.import) : undefined);
      if (clientRel === undefined) {
        add('error', 'client/export-missing', 'declares dsh.client but exports no "./client" — client-modules throws when it cannot find the bundle', '"exports": { "./client": "./lib/client.js" }');
      } else if (!existsSync(join(dir, normalizeRelative(clientRel)))) {
        add('error', 'client/bundle-missing', `exports "./client" -> "${clientRel}", which does not exist on disk`, 'build the client half before publishing');
      } else {
        validateClientBundle(join(dir, normalizeRelative(clientRel)), pkgName, client, add);
      }

      // A client bundle is loaded by the shell itself, so the package must be
      // reachable as a Loader row for its bundle to be served at all.
      if (patchSpec !== undefined && pkgName !== null) {
        const patch = existsSync(join(dir, normalizeRelative(patchSpec))) ? readText(join(dir, normalizeRelative(patchSpec))) : null;
        if (patch !== null && patch.error === undefined && !patchNames(patch.value).some((n) => n === pkgName || n.startsWith(`${pkgName}/`))) {
          add('warning', 'bundle/client-row', `the patch inserts no row named "${pkgName}", so this package never becomes a Loader entry — and a client bundle is only served for a package the Loader mounts`, `add a row: - insert:\n    - id: your-plugin-id\n      name: '${pkgName}'`);
        }
      }
    }
  }

  // ── dependency placement ────────────────────────────────────────────────
  const deps = pkg.dependencies !== null && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  // @deepseek-ai/schemastery is the exception: a published library that plugins
  // legitimately depend on, not a service the harness injects. Flagging it would be a
  // false error on a correct manifest, and a linter that cries wolf stops being trusted.
  const LIBRARY_PACKAGES = new Set(['@deepseek-ai/schemastery']);
  const misplaced = Object.keys(deps).filter((n) => n.startsWith('@deepseek-ai/') && !LIBRARY_PACKAGES.has(n));
  if (misplaced.length > 0) {
    add('error', 'deps/host-packages', `@deepseek-ai/* packages are declared in dependencies: ${misplaced.join(', ')} — the harness provides these, and bundling them duplicates the framework`, 'move them to peerDependencies');
  }

  // ── peer ranges vs the harness that will actually run this ──────────────
  const peers = pkg.peerDependencies !== null && typeof pkg.peerDependencies === 'object' ? pkg.peerDependencies : {};
  const peerMeta = pkg.peerDependenciesMeta !== null && typeof pkg.peerDependenciesMeta === 'object' ? pkg.peerDependenciesMeta : {};
  for (const [peerName, range] of Object.entries(peers)) {
    if (!peerName.startsWith('@deepseek-ai/')) continue;
    if (typeof range !== 'string' || range.trim() === '') continue;
    if (peerMeta[peerName]?.optional === true) continue;

    const resolved = hostVersionOf(peerName, dir);
    if (resolved === null) {
      // No installed version to compare against. Judge the range on its own terms, but
      // ONLY for packages that publish prereleases exclusively.
      //
      // This restriction is the whole correctness of the check. `@deepseek-ai/dsh-*`
      // packages are prerelease-only (every one of their 23 published versions carries a
      // tag), so a range that cannot admit a prerelease is a real defect there. But
      // `@deepseek-ai/cordis` and `schemastery` publish stable releases too, and for them
      // "^4.0.1" is simply correct — flagging it reported a 92% hazard rate across the
      // catalog that was pure false positives.
      if (PRERELEASE_ONLY.test(peerName) && /^[*xX]$/.test(range.trim())) {
        // The ONLY call this tool makes without a resolved version, because it is not a
        // judgement about which prerelease matters — npm itself rejects it. `*` has no
        // prerelease-tagged comparator on any tuple, so it excludes every prerelease,
        // and every DeepSeek Harness release is one.
        add(
          'warning',
          'peer/wildcard',
          `peer "${peerName}": "*" does not match ANY prerelease version, and every DeepSeek Harness release is a prerelease`,
          'name a range that reaches the version you target, e.g. ">=0.1.5-rc.1 <0.2.0-0"',
        );
      }

      // Everything else stays SILENT here, on purpose.
      //
      // Without an installed host there is no version to test against, and three attempts
      // at inferring one were wrong in three different ways: probing a range's own tuple
      // with "-rc.1" lands below a "^0.1.5-rc.2" lower bound; probing with the registry's
      // newest prerelease (0.1.6-alpha.2) lands above the range that deliberately stops
      // before it; probing stable-only packages flagged "^4.0.1" on cordis as broken.
      // Every one of those reported a correct manifest as defective.
      //
      // Run inside a dsh profile and the check above resolves the real version and makes
      // a concrete, verifiable claim instead. A linter that invents findings to look
      // thorough is worse than one that admits what it cannot see.
      continue;
    }

    if (!satisfies(resolved, range)) {
      const suggestion = suggestRange(range, resolved);
      const parsed = parseVersion(resolved);
      add(
        'error',
        'peer/prerelease-tuple',
        `peer "${peerName}": "${range}" does NOT match the installed ${peerName}@${resolved}`
          + (parsed !== null && isPrerelease(parsed)
            ? `. node-semver admits a prerelease only when some comparator sits on the exact ${parsed.major}.${parsed.minor}.${parsed.patch} tuple AND carries a prerelease tag — a broad-looking range silently excludes every prerelease build.`
            : ''),
        suggestion === null ? undefined : `e.g. "${suggestion}"`,
      );
    }
  }

  // ── description: the claim a maintainer checks against your code ─────────
  const description = typeof pkg.description === 'string' ? pkg.description : '';
  if (description.trim() === '') {
    add('warning', 'description/missing', 'package.json has no description');
  } else {
    if (MARKETING.test(description) || MARKETING_ZH.test(description)) {
      add('warning', 'description/marketing', 'the description contains marketing language; the list wants a plain statement of what the plugin does');
    }
    if (description.length > 320) {
      add('info', 'description/length', `the description is ${description.length} characters; the list shows one line`);
    }
    const toolCount = /\b(\d+)\s+(?:model-facing\s+)?(?:tools|commands|slash commands)\b/i.exec(description);
    if (toolCount !== null) {
      add('info', 'description/count-claim', `the description claims ${toolCount[1]} tools/commands — a maintainer counts these against your source, so verify the number before submitting`);
    }
  }

  // ── metadata the npm mapping depends on ─────────────────────────────────
  const repository = pkg.repository;
  const repoUrl = typeof repository === 'string' ? repository : repository?.url;
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
    add('warning', 'metadata/repository', 'package.json has no repository.url — without it your npm package is never linked to your repository, so the list shows no download count', '"repository": { "type": "git", "url": "git+https://github.com/you/repo.git" }');
  }
  if (pkg.license === undefined) add('info', 'metadata/license', 'no license field; MIT is the norm in this ecosystem');
  if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes('dsh-plugin')) {
    add('info', 'metadata/keywords', 'add the "dsh-plugin" keyword; the list also asks for the dsh-plugin GitHub topic on the repository');
  }

  return buildReport(dir, host, findings);
}

/** Structural checks on cordis.patch.yml, plus the name round-trip. */
function validatePatch(dir, text, patchSpec, pkgName, add) {
  if (text.trim() === '') {
    add('error', 'patch/empty', `${patchSpec} is empty — the Loader applies no row, so nothing is mounted`);
    return;
  }
  // A top-level YAML array of patch entries. `[]` is a valid, empty layer.
  if (!/^\s*(?:#.*\n|\s*\n)*\s*\[/.test(text) && !/^\s*(?:#.*\n|\s*\n)*\s*-\s/.test(text)) {
    add('error', 'patch/not-a-list', `${patchSpec} must be a top-level array of patch entries`, 'start it with "- insert:"');
    return;
  }
  if (!/\binsert\s*:/.test(text)) {
    add('warning', 'patch/no-insert', `${patchSpec} has no "insert:" list — a patch layer that inserts nothing mounts nothing`);
    return;
  }
  const names = patchNames(text);
  const ids = patchIdCount(text);
  if (names.length === 0) {
    add('error', 'patch/no-name', `${patchSpec} inserts no row with a "name:" — the Loader has no module to mount`, `- insert:\n    - id: your-plugin-id\n      name: '${pkgName ?? 'your-package'}'`);
    return;
  }
  if (ids < names.length) {
    add('warning', 'patch/id-missing', `${patchSpec} has ${names.length} name(s) but only ${ids} id(s); every row should carry a stable id so it can be targeted by later patch layers`);
  }
  if (pkgName !== null) {
    const foreign = names.filter((n) => n !== pkgName && !n.startsWith(`${pkgName}/`) && !n.startsWith('.') && !isAbsolute(n));
    if (foreign.length === names.length) {
      add('warning', 'patch/name-mismatch', `${patchSpec} inserts ${foreign.map((n) => `"${n}"`).join(', ')} but this package is named "${pkgName}" — the row will fail to resolve unless that name is a real dependency`, `use name: '${pkgName}'`);
    }
  }
}

/** The bundle contract every client half must satisfy to be materializable. */
function validateClientBundle(bundlePath, pkgName, client, add) {
  const head = (() => {
    try {
      return readFileSync(bundlePath, 'utf8').slice(0, 4096);
    } catch {
      return null;
    }
  })();
  if (head === null) {
    add('error', 'client/unreadable', `${bundlePath} cannot be read`);
    return;
  }
  if (!head.includes('__ModuleLoader__')) {
    add('error', 'client/loader-missing', 'the client bundle does not call window.__ModuleLoader__.load({ id, factory }) — client bundles are lazy-CJS factories, not ES modules', 'build the client half with the client bundle preset');
    return;
  }
  const idMatch = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{\s*id\s*:\s*["']([^"']+)["']/.exec(head);
  if (idMatch === null) {
    add('warning', 'client/id-not-first', 'the bundle registers with the module loader but its "id" could not be read from the first 4 KB — confirm the id matches the package name');
  } else if (pkgName !== null && idMatch[1] !== pkgName) {
    add('warning', 'client/id-mismatch', `the client bundle registers as "${idMatch[1]}" but the package is "${pkgName}"; <id>/client and the bare package name must resolve to the same exports`, `register as "${pkgName}"`);
  }
  if (head.includes('export ') && head.includes('export default') && !head.includes('module.exports')) {
    add('warning', 'client/esm', 'the client bundle looks like an ES module; the loader materializes CJS factories that assign module.exports');
  }
  const externals = Array.isArray(client.external) ? client.external : [];
  const self = externals.filter((x) => typeof x === 'string' && (x === pkgName || x === `${pkgName}/client`));
  if (self.length > 0) {
    add('error', 'client/external-self', `dsh.client.external lists ${self.join(', ')} — a row must not declare its own package as an external, the composition throws`);
  }
  const notSeeded = externals.filter((x) => typeof x === 'string' && !PLATFORM_MODULES.has(x) && !x.startsWith('@deepseek-ai/dsh-client-'));
  if (notSeeded.length > 0) {
    add('warning', 'client/external-unknown', `dsh.client.external lists ${notSeeded.map((x) => `"${x}"`).join(', ')}; each must be answered by another dynamic plugin row or an exact frozen-shell key, or composition fails`);
  }
}

/** Locate the patch layer: the declared path, else the conventional filename. */
function resolvePatchPath(dir, patchSpec) {
  if (typeof patchSpec === 'string' && patchSpec !== '') {
    const full = join(dir, normalizeRelative(patchSpec));
    return existsSync(full) ? { full, label: patchSpec } : null;
  }
  const conventional = join(dir, 'cordis.patch.yml');
  return existsSync(conventional) ? { full: conventional, label: 'cordis.patch.yml' } : null;
}


function buildReport(dir, host, findings) {
  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  const count = (level) => findings.filter((f) => f.level === level).length;
  return {
    schema: REPORT_SCHEMA,
    dir,
    host,
    findings,
    summary: {
      ok: count('error') === 0,
      errors: count('error'),
      warnings: count('warning'),
      infos: count('info'),
      total: findings.length,
    },
  };
}

/** Render a report as lines of plain text, for a terminal. */
export function renderReport(report) {
  const mark = { error: 'x', warning: '!', info: '-' };
  const lines = [];
  lines.push(`preflight ${report.schema}  ${report.dir}`);
  lines.push(report.host === null
    ? 'host: unresolved (run inside a dsh profile to check peer ranges against the running harness)'
    : `host: ${report.host.package}@${report.host.version}`);
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('No findings. Nothing here blocks a submission.');
    return lines;
  }
  for (const f of report.findings) {
    lines.push(`${mark[f.level]} [${f.rule}] ${f.message}`);
    if (f.fix !== undefined) lines.push(`    fix: ${f.fix.replace(/\n/g, '\n         ')}`);
  }
  lines.push('');
  lines.push(`${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.infos} info`);
  lines.push(report.summary.ok
    ? 'No blocking errors. Review the warnings before submitting.'
    : 'Blocked: the community list CI rejects the errors above.');
  return lines;
}