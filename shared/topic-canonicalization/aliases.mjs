
// Optional topic alias table. Each entry maps raw topic strings that agents
// minted under different wording onto one canonical topic, so a logical thread
// stays grouped in the board and the handoff server.
//
//   { project: 'my-repo', canonical: 'one-stable-topic-name', aliases: ['older-wording'] }
//
// Keep this table empty unless a real forked-topic situation needs repairing;
// the resolver treats an empty table as identity.
export const TOPIC_ALIASES = [];
