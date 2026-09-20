/**
 * Prerelease-aware semver range checking (no dependencies).
 *
 * WHY THIS EXISTS
 * ---------------
 * DeepSeek Harness ships prerelease versions (0.1.5-rc.2). node-semver only lets a
 * prerelease version satisfy a range when some comparator in that range sits on the
 * EXACT same major.minor.patch tuple AND itself carries a prerelease tag.
 *
 * The consequence is not obvious and it bites real plugins:
 *
 *   "*"                 does NOT match 0.1.5-rc.2
 *   ">=0.1.0-rc.1"      does NOT match 0.1.5-rc.2
 *   "^0.1.0-rc.6"       does NOT match 0.1.5-rc.2
 *   "^0.1.5-rc.1"       DOES match
 *
 * So an author who writes a broad-looking range silently excludes the very harness
 * their users run, and the failure surfaces later as an ERESOLVE the user has to
 * work around by hand.
 *
 * @module dsh-plugin-preflight/semver
 */

/** @typedef {{major:number, minor:number, patch:number, prerelease:string[]}} Version */

/** Parse `1.2.3`, `1.2.3-rc.1`, `v1.2.3+build`. Returns null when unparseable. */
export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split('.'),
  };
}

/** True when this version carries a prerelease tag. */
export function isPrerelease(version) {
  return version.prerelease.length > 0;
}

/** The `major.minor.patch` tuple, used to decide prerelease admissibility. */
export function tupleOf(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function comparePrereleaseIdentifiers(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) === Number(b) ? 0 : Number(a) < Number(b) ? -1 : 1;
  if (aNum) return -1;
  if (bNum) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Standard semver precedence. A version WITH a prerelease ranks below the same
 * version without one. Build metadata is ignored, as spec requires.
 * @returns negative, zero, or positive
 */
export function compareVersions(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < shared; i += 1) {
    const cmp = comparePrereleaseIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (cmp !== 0) return cmp;
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

/** One comparator: an operator plus a concrete version. */
function makeComparator(op, version) {
  return { op, version, tuple: tupleOf(version), tagged: isPrerelease(version) };
}

function trimComparator(text) {
  let s = text.trim().replace(/^v/, '');
  if (s === '' || s === '*' || s === 'x' || s === 'X') return null; // no constraint
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(s);
  if (m === null) return undefined; // unparseable
  const op = m[1] === undefined ? '=' : m[1];
  const version = parseVersion(m[2]);
  if (version === null) return undefined;
  return makeComparator(op, version);
}

/**
 * Expand one whitespace-separated comparator set into primitive comparators.
 * Caret and tilde desugar exactly as node-semver does, including the `0.x` rules.
 * @returns array of comparators, or null when the set is unparseable
 */
export function parseComparatorSet(setText) {
  const parts = setText.trim().split(/\s+/).filter((part) => part !== '');
  if (parts.length === 0) return null;

  // A hyphen range: "1.2.3 - 2.3.4"
  if (parts.length === 3 && parts[1] === '-') {
    const lower = parseVersion(parts[0]);
    const upper = parseVersion(parts[2]);
    if (lower === null || upper === null) return null;
    return [makeComparator('>=', lower), makeComparator('<=', upper)];
  }

  const out = [];
  for (const part of parts) {
    const text = part.trim().replace(/^v/, '');

    const caret = /^\^(.*)$/.exec(text);
    if (caret !== null) {
      const lower = parseVersion(caret[1]);
      if (lower === null) return null;
      let upper;
      if (lower.major !== 0) upper = { major: lower.major + 1, minor: 0, patch: 0, prerelease: [] };
      else if (lower.minor !== 0) upper = { major: 0, minor: lower.minor + 1, patch: 0, prerelease: [] };
      else upper = { major: 0, minor: 0, patch: lower.patch + 1, prerelease: [] };
      out.push(makeComparator('>=', lower));
      out.push(makeComparator('<', upper));
      continue;
    }

    const tilde = /^~(.*)$/.exec(text);
    if (tilde !== null) {
      const lower = parseVersion(tilde[1]);
      if (lower === null) return null;
      const upper = { major: lower.major, minor: lower.minor + 1, patch: 0, prerelease: [] };
      out.push(makeComparator('>=', lower));
      out.push(makeComparator('<', upper));
      continue;
    }

    const plain = trimComparator(text);
    if (plain === undefined) return null;
    if (plain === null) continue; // wildcard contributes nothing
    out.push(plain);
  }
  return out.length === 0 ? [] : out;
}

function satisfiesComparator(version, comparator) {
  const cmp = compareVersions(version, comparator.version);
  switch (comparator.op) {
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    default: return cmp === 0;
  }
}

/**
 * Whether `version` satisfies `range`.
 *
 * Mirrors node-semver's prerelease rule: an OR branch admits a prerelease version
 * only when that branch contains at least one comparator that shares the version's
 * exact tuple AND carries a prerelease tag.
 */
export function satisfies(version, range) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version;
  if (parsed === null || parsed === undefined) return false;
  if (typeof range !== 'string' || range.trim() === '') return false;

  for (const branchText of range.split('||')) {
    const comparators = parseComparatorSet(branchText);
    if (comparators === null || comparators.length === 0) continue;
    if (!comparators.every((c) => satisfiesComparator(parsed, c))) continue;

    if (isPrerelease(parsed)) {
      const taggedOnTuple = comparators.some((c) => c.tagged && c.tuple === tupleOf(parsed));
      if (!taggedOnTuple) continue; // prerelease excluded by the tuple rule
    }
    return true;
  }
  return false;
}

/** A first comparator that WOULD admit `version`: same tuple, carrying a prerelease tag. */
export function candidateComparator(version) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version;
  if (parsed === null || parsed === undefined) return null;
  const tuple = tupleOf(parsed);
  return isPrerelease(parsed) ? `>=${tuple}-0` : `>=${tuple}`;
}

/**
 * Build a range that admits `version`, repairing each OR branch of `range`.
 *
 * Appending a comparator is only sound when the branch already admits the version —
 * then the addition just makes the prerelease explicit. When the branch rejects it, the
 * branch is the problem and must be REPLACED: "^0.2.0 >=0.1.5-0" still excludes
 * 0.1.5-rc.2, because "^0.2.0" is doing the excluding. The replacement keeps the
 * project's own zero-version convention.
 *
 * @returns the repaired range, or null when the input is unusable
 */
export function suggestRange(range, version) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version;
  if (parsed === null || parsed === undefined || typeof range !== 'string') return null;
  const tuple = tupleOf(parsed);
  const branches = range.split('||').map((branch) => branch.trim()).filter((branch) => branch !== '');
  if (branches.length === 0) return null;

  return branches.map((branch) => {
    if (satisfies(parsed, branch)) return `${branch} >=${tuple}-0`;
    // Zero-major versions treat the minor as the breaking position.
    const upper = parsed.major === 0 ? `0.${parsed.minor + 1}.0-0` : `${parsed.major + 1}.0.0-0`;
    return `>=${tuple}-0 <${upper}`;
  }).filter((branch, index, all) => all.indexOf(branch) === index).join(' || ');
}