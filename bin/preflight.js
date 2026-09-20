#!/usr/bin/env node
/** Executable entry for dsh-plugin-preflight. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { main } from '../lib/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
let version = '0.0.0';
try {
  version = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? version;
} catch { /* a missing manifest must not stop the check */ }

process.exitCode = await main(process.argv.slice(2), { version });