export function createTopicResolver(aliasTable = []) {
  return (project, workspace, rawTopic) => {
    const topic = String(rawTopic || '');
    if (!topic) return topic;
    const lookup = buildAliasLookup(aliasTable, project);
    return lookup.get(topic) || topic;
  };
}

export function resolveCanonicalTopicWithRaw(project, workspace, rawTopic, resolver) {
  const topicRaw = String(rawTopic || '');
  const canonicalTopic = resolver(project, workspace, topicRaw);
  return {
    canonicalTopic,
    topicRaw: canonicalTopic === topicRaw ? null : topicRaw,
  };
}

export function topicKey(project, workspace, topic) {
  return `${project}::${workspace || ''}::${topic}`;
}

export function parseTopicKey(key) {
  const firstSep = key.indexOf('::');
  if (firstSep === -1) return { project: key, workspace: null, topic: '' };
  const project = key.slice(0, firstSep);
  const rest = key.slice(firstSep + 2);
  const secondSep = rest.indexOf('::');
  if (secondSep === -1) return { project, workspace: null, topic: rest };
  const workspace = rest.slice(0, secondSep);
  return { project, workspace: workspace || null, topic: rest.slice(secondSep + 2) };
}

export function topicBelongsToCanonical(project, workspace, rowTopic, requestedTopic, resolver) {
  return resolver(project, workspace, rowTopic) === resolver(project, workspace, requestedTopic);
}

export function canonicalizeSummaryMap(summaryMap, mergeEntries, resolver) {
  const grouped = new Map();
  for (const [key, value] of summaryMap.entries()) {
    const parsed = parseTopicKey(key);
    const canonicalTopic = resolver(parsed.project, parsed.workspace, parsed.topic);
    const canonicalKey = topicKey(parsed.project, parsed.workspace, canonicalTopic);
    grouped.set(canonicalKey, mergeEntries(grouped.get(canonicalKey) || null, value, parsed));
  }
  return grouped;
}

function buildAliasLookup(aliasTable, project) {
  const lookup = new Map();
  for (const entry of aliasTable) {
    if (entry.project && entry.project !== project) continue;
    for (const rawTopic of entry.aliases || []) {
      const previous = lookup.get(rawTopic);
      if (previous && previous !== entry.canonical) {
        throw new Error(`Conflicting topic alias mapping for "${rawTopic}": "${previous}" vs "${entry.canonical}"`);
      }
      lookup.set(rawTopic, entry.canonical);
    }
  }
  return lookup;
}
