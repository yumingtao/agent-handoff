declare module '../../shared/topic-canonicalization/index.mjs' {
  export type TopicAliasEntry = {
    project?: string;
    canonical: string;
    aliases: string[];
  };

  export function createTopicResolver(aliasTable?: TopicAliasEntry[]): (project: string, workspace: string | null | undefined, rawTopic: string) => string;
  export function resolveCanonicalTopicWithRaw(
    project: string,
    workspace: string | null | undefined,
    rawTopic: string,
    resolver: (project: string, workspace: string | null | undefined, rawTopic: string) => string,
  ): { canonicalTopic: string; topicRaw: string | null };
  export function topicBelongsToCanonical(
    project: string,
    workspace: string | null | undefined,
    rowTopic: string,
    requestedTopic: string,
    resolver: (project: string, workspace: string | null | undefined, rawTopic: string) => string,
  ): boolean;
}

declare module '../../shared/topic-canonicalization/aliases.mjs' {
  import type { TopicAliasEntry } from '../../shared/topic-canonicalization/index.mjs';
  export const TOPIC_ALIASES: TopicAliasEntry[];
}
