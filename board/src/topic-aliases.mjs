export {
  canonicalizeSummaryMap,
  createTopicResolver,
  parseTopicKey,
  resolveCanonicalTopicWithRaw,
  topicBelongsToCanonical,
  topicKey,
} from '../../shared/topic-canonicalization/index.mjs';

export { TOPIC_ALIASES } from '../../shared/topic-canonicalization/aliases.mjs';

import { createTopicResolver } from '../../shared/topic-canonicalization/index.mjs';
import { TOPIC_ALIASES } from '../../shared/topic-canonicalization/aliases.mjs';

export const resolveCanonicalTopic = createTopicResolver(TOPIC_ALIASES);
