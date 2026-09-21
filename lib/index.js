/**
 * dsh-plugin-preflight — host half.
 *
 * Registers one read-only model-facing tool that runs the same checks as the CLI, so an
 * agent scaffolding or reviewing a plugin can catch a rejected submission before it is
 * pushed. The plugin ships no browser half on purpose: it is a developer diagnostic, and
 * a settings panel for it would be UI noise.
 *
 * The tool runtime is imported LAZILY, and that is load-bearing. A top-level
 * `import '@deepseek-ai/dsh-tools'` makes the whole plugin fail to load whenever that
 * package is not resolvable from this file — which is exactly what happens when a user
 * installs by local path (`dsh plugin add /path/to/checkout` creates a junction, and
 * Node resolves ESM through the junction's real path, walking up a directory tree that
 * has no node_modules). The failure is not graceful: the Loader aborts the entire plugin
 * tree, so DeepSeek Harness does not start at all and the user loses the GUI they would
 * have used to undo it. Degrading to a CLI-only plugin is the correct outcome there.
 *
 * @module dsh-plugin-preflight
 */
import { check, renderReport, REPORT_SCHEMA } from './check.js';

export const name = 'dsh-plugin-preflight';
export const inject = ['tools'];

/** Cached tool-runtime import, or null once we know it cannot be resolved. */
let toolRuntime;
let toolRuntimeProbed = false;

async function loadToolRuntime() {
  if (toolRuntimeProbed) return toolRuntime;
  toolRuntimeProbed = true;
  try {
    toolRuntime = await import('@deepseek-ai/dsh-tools');
  } catch {
    toolRuntime = null;
  }
  return toolRuntime;
}

export function apply(ctx) {
  void loadToolRuntime().then((runtime) => {
    // No tools runtime reachable: stay mounted as a CLI-only plugin rather than
    // taking the harness down with us.
    if (runtime === null || typeof runtime.defineTool !== 'function') return;

    ctx.tools.register(runtime.defineTool({
      name: 'plugin_preflight',
      description: 'Check a DeepSeek Harness plugin repository against the community list\'s '
        + 'submission requirements before submitting it: the dsh.bundle manifest, cordis.patch.yml '
        + 'wiring, the client bundle shape, and peer ranges that silently exclude prerelease builds '
        + 'of the harness. Returns a dsh-plugin-preflight/v1 report of errors, warnings and fixes. Read-only.',
      parameters: {
        dir: {
          type: 'string',
          description: 'Absolute path to the plugin repository root. Defaults to the working directory.',
          required: true,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            schema: { type: 'string' },
            ok: { type: 'boolean' },
            findings: { type: 'array' },
            lines: { type: 'array' },
          },
        },
        render: (_args, value) => value.lines.map((text) => ({ type: 'text', text })),
      },
      async execute(args, exec) {
        // A check is filesystem work with no cancellation point of its own; honour the
        // caller's signal before doing it so a cancelled call does not run anyway.
        if (exec?.signal?.aborted === true) throw new Error('plugin_preflight aborted before dispatch');
        const report = await check({ dir: args.dir });
        return {
          schema: REPORT_SCHEMA,
          ok: report.summary.ok,
          findings: report.findings,
          lines: renderReport(report),
        };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Plugin preflight',
        kind: 'other',
        rawInput: args,
      }),
    }));
  }).catch(() => {
    // Registering is best-effort; the CLI never depends on it.
  });
}