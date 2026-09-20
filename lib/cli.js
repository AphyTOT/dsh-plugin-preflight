/**
 * CLI argument handling. No dependencies, by design: a diagnostic tool that must be
 * installed before it can tell you your install is broken is not much of a diagnostic.
 * @module dsh-plugin-preflight/cli
 */
import { check, renderReport } from './check.js';

export const USAGE = `dsh-plugin-preflight — check a DeepSeek Harness plugin before you submit it

Usage
  dsh-plugin-preflight [dir] [options]

Options
  --dir <path>     repository to check (default: current directory)
  --json           print the raw report as JSON
  --strict         exit non-zero on warnings too, not just errors
  --quiet          print nothing when there are no errors
  --help, -h       show this text
  --version, -v    print the version

Exit codes
  0  no blocking errors
  1  blocking errors (or warnings, with --strict)
  2  bad usage

What it checks, and why
  dsh.bundle         the manifest that makes a plugin installable at all; declaring
                     only dsh.client is the most common reason a submission is rejected
  cordis.patch.yml   the patch layer must actually insert a row, or nothing mounts
  client bundle      the lazy-CJS shape the shell materializes, and its registered id
  peer ranges        node-semver silently excludes prereleases unless a comparator sits
                     on the harness's exact version tuple with its own prerelease tag
`;

const GROUPS = { error: 'error', warning: 'warning', info: 'info' };

/**
 * Parse argv (no leading `node script` entries).
 * @returns {{help:boolean, version:boolean, json:boolean, strict:boolean, quiet:boolean, dir:string|null, error:string|null}}
 */
export function parseArgs(argv) {
  const out = { help: false, version: false, json: false, strict: false, quiet: false, dir: null, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--version' || arg === '-v') out.version = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--dir') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) { out.error = '--dir needs a path'; return out; }
      out.dir = next; i += 1;
    } else if (arg.startsWith('-')) {
      out.error = `unknown option "${arg}"`;
      return out;
    } else if (out.dir === null) {
      out.dir = arg;
    } else {
      out.error = `unexpected extra argument "${arg}"`;
      return out;
    }
  }
  return out;
}

const COLOR = {
  error: '\u001b[31m',
  warning: '\u001b[33m',
  info: '\u001b[90m',
  dim: '\u001b[2m',
  reset: '\u001b[0m',
};

/** Colourise a rendered report, one level per line, when the stream is a TTY. */
function colorize(lines) {
  return lines.map((line) => {
    const m = /^([x!-]) \[/.exec(line);
    if (m === null) return line.startsWith('    fix:') ? `${COLOR.dim}${line}${COLOR.reset}` : line;
    const level = m[1] === 'x' ? 'error' : m[1] === '!' ? 'warning' : 'info';
    return `${COLOR[level]}${line}${COLOR.reset}`;
  });
}

/**
 * Run the CLI.
 * @param {string[]} argv - arguments after the executable
 * @param {{stdout?:Function, stderr?:Function, isTty?:boolean, version?:string}} [io]
 * @returns {number} the process exit code
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  const isTty = io.isTty ?? Boolean(process.stdout.isTTY);
  const version = io.version ?? '0.0.0';

  const args = parseArgs(argv);
  if (args.error !== null) {
    stderr(`dsh-plugin-preflight: ${args.error}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) { stdout(USAGE); return 0; }
  if (args.version) { stdout(`${version}\n`); return 0; }

  let report;
  try {
    report = await check(args.dir === null ? {} : { dir: args.dir });
  } catch (error) {
    stderr(`dsh-plugin-preflight: check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (args.json) {
    stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else if (!(args.quiet && report.summary.ok)) {
    const lines = renderReport(report);
    stdout(`${(isTty ? colorize(lines) : lines).join('\n')}\n`);
  }

  const blocked = report.summary.errors > 0 || (args.strict && report.summary.warnings > 0);
  return blocked ? 1 : 0;
}

export { GROUPS };