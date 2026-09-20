/**
 * dsh-plugin-preflight — host half.
 *
 * Registers one read-only model-facing tool that runs the same checks as the CLI,
 * so an agent scaffolding or reviewing a plugin can catch a rejected submission
 * before it is pushed. The plugin ships no browser half on purpose: it is a
 * developer diagnostic, and a settings panel for it would be UI noise.
 *
 * @module dsh-plugin-preflight
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { check, renderReport, REPORT_SCHEMA } from './check.js';

export const name = 'dsh-plugin-preflight';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.tools.register(defineTool({
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
      const report = await check({ dir: args.dir });
      // A check is filesystem work with no cancellation point of its own; honour the
      // caller's signal before doing it so a cancelled call does not run anyway.
      if (exec?.signal?.aborted === true) throw new Error('plugin_preflight aborted before dispatch');
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
}