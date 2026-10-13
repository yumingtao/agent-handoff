#!/usr/bin/env node
import { resolve } from 'node:path';
import { AgentEventsStore } from './store.mjs';

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

if (!command) usage(1);

const store = new AgentEventsStore(args.db ? resolve(args.db) : undefined);

try {
  if (command === 'publish') {
    for (const key of ['project', 'topic', 'agent', 'eventType']) {
      if (!args[key]) throw new Error(`--${hyphen(key)} is required`);
    }
    const payload = args.payload ? JSON.parse(args.payload) : {};
    console.log(JSON.stringify(store.publish({
      project: args.project,
      workspace: args.workspace || null,
      topic: args.topic,
      logicalTopicId: args.logicalTopicId || null,
      agent: args.agent,
      eventType: args.eventType,
      payload,
    }), null, 2));
  } else if (command === 'list') {
    console.log(JSON.stringify(store.list({
      project: args.project,
      workspace: args.workspace,
      topic: args.topic,
      logicalTopicId: args.logicalTopicId,
      agent: args.agent,
      eventType: args.eventType,
      since: args.since,
      limit: args.limit ? Number(args.limit) : 50,
    }), null, 2));
  } else {
    usage(1);
  }
} finally {
  store.close();
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (!name.startsWith('--')) throw new Error(`unexpected argument: ${name}`);
    result[name.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = values[++index];
  }
  return result;
}

function hyphen(value) {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function usage(code) {
  console.error('usage: node runner/agent-events/src/cli.mjs <publish|list> [--db FILE] ...');
  process.exit(code);
}
