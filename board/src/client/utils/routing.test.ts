import { describe, it, expect } from 'vitest';
import { buildTopicKey, parseTopicKey, topicDetailPath, logicalTopicDetailPath, agentDetailPath } from '../utils/routing';

describe('routing utils', () => {
  describe('buildTopicKey', () => {
    it('builds key with workspace', () => {
      expect(buildTopicKey('myproject', '/path/to/ws', 'mytopic')).toBe(
        'myproject::/path/to/ws::mytopic',
      );
    });

    it('builds key with null workspace as empty string', () => {
      expect(buildTopicKey('myproject', null, 'mytopic')).toBe('myproject::::mytopic');
    });

    it('builds key with empty workspace', () => {
      expect(buildTopicKey('myproject', '', 'mytopic')).toBe('myproject::::mytopic');
    });
  });

  describe('parseTopicKey', () => {
    it('parses key with workspace', () => {
      const result = parseTopicKey('myproject::/path/to/ws::mytopic');
      expect(result).toEqual({
        project: 'myproject',
        workspace: '/path/to/ws',
        topic: 'mytopic',
      });
    });

    it('parses key with empty workspace', () => {
      const result = parseTopicKey('myproject::::mytopic');
      expect(result).toEqual({
        project: 'myproject',
        workspace: null,
        topic: 'mytopic',
      });
    });

    it('parses key with no workspace separator', () => {
      const result = parseTopicKey('myproject::mytopic');
      expect(result).toEqual({
        project: 'myproject',
        workspace: null,
        topic: 'mytopic',
      });
    });

    it('handles topic with :: in name', () => {
      const result = parseTopicKey('proj::/ws::topic::with::colons');
      expect(result).toEqual({
        project: 'proj',
        workspace: '/ws',
        topic: 'topic::with::colons',
      });
    });

    it('handles key with no separators at all', () => {
      const result = parseTopicKey('just-project');
      expect(result).toEqual({
        project: 'just-project',
        workspace: null,
        topic: '',
      });
    });
  });

  describe('topicDetailPath', () => {
    it('builds path with workspace', () => {
      const path = topicDetailPath('myproject', '/path/to/ws', 'mytopic');
      expect(path).toBe('/topic-key/myproject%3A%3A%2Fpath%2Fto%2Fws%3A%3Amytopic');
    });

    it('builds path with _ workspace', () => {
      const path = topicDetailPath('myproject', '_', 'mytopic');
      expect(path).toBe('/topic-key/myproject%3A%3A%3A%3Amytopic');
    });
  });

  describe('logicalTopicDetailPath', () => {
    it('builds path for logical topic id', () => {
      expect(logicalTopicDetailPath('topic-123')).toBe('/topic/topic-123');
    });
  });

  describe('agentDetailPath', () => {
    it('builds path for agent', () => {
      expect(agentDetailPath('Codex')).toBe('/agent/Codex');
    });

    it('encodes special characters', () => {
      expect(agentDetailPath('agent with spaces')).toBe('/agent/agent%20with%20spaces');
    });
  });
});
