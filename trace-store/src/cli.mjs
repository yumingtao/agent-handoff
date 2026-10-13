#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TraceStore } from './trace-store.mjs';
import { renderDashboard } from './dashboard.mjs';

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));
if (!command || !args.db) usage();
const store = new TraceStore(resolve(args.db));
try {
  if (command === 'show') {
    if (!args.runId) throw new Error('--run-id is required');
    console.log(JSON.stringify(store.getRun(args.runId), null, 2));
  } else if (command === 'metrics') {
    console.log(JSON.stringify(store.metrics(), null, 2));
  } else if (command === 'dashboard') {
    if (!args.out) throw new Error('--out is required');
    const output = resolve(args.out);
    await writeFile(output, renderDashboard(store.metrics(), store.listRuns(Number(args.limit || 100))));
    console.log(output);
  } else if (command === 'prune') {
    const days = Number(args.days);
    if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer');
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    console.log(JSON.stringify({ deletedRuns: store.pruneBefore(cutoff), cutoff }, null, 2));
  } else usage();
} finally {
  store.close();
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) result[values[index].slice(2).replace(/-([a-z])/gu, (_, c) => c.toUpperCase())] = values[index + 1];
  return result;
}
function usage() { console.error('usage: trace-store <show|metrics|dashboard|prune> --db FILE [--run-id ID] [--out HTML] [--days N]'); process.exit(1); }
