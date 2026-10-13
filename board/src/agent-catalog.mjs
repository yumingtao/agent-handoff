import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = join(__dirname, '..', '..', '..', 'skills');

const PLATFORMS = {
  claude:     { label: 'Claude Code',   color: '#D97757', icon: '\u2726', cliCallable: true,  agentType: 'cli' },
  codex:      { label: 'Codex',         color: '#10A37F', icon: '\u2B21', cliCallable: true,  agentType: 'cli' },
  codebuddy:  { label: 'CodeBuddy',     color: '#5B9CF6', icon: '\u25C6', cliCallable: true,  agentType: 'cli' },
  cursor:     { label: 'Cursor',        color: '#A78BFA', icon: '\u25B8', cliCallable: false, agentType: 'desktop' },
  copilot:    { label: 'GitHub Copilot',color: '#8B8B8B', icon: '\u2B22', cliCallable: false, agentType: 'ide' },
  cline:      { label: 'Cline',         color: '#34D399', icon: '\u25C7', cliCallable: false, agentType: 'ide' },
  gemini:     { label: 'Gemini CLI',    color: '#4285F4', icon: '\u2737', cliCallable: true,  agentType: 'cli' },
};

/**
 * Parse a minimal YAML-like frontmatter block from a markdown file.
 */
function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const lines = match[1].split('\n');
  const data = {};
  let currentNest = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    const nested = line.match(/^\s{2,}(\w+):\s*(.*)$/);
    if (nested && currentNest) {
      data[currentNest][nested[1]] = parseValue(nested[2]);
      continue;
    }

    const top = line.match(/^(\w+):\s*(.*)$/);
    if (top) {
      const val = top[2].trim();
      if (val === '') {
        currentNest = top[1];
        data[currentNest] = {};
      } else {
        currentNest = null;
        data[top[1]] = parseValue(val);
      }
    }
  }
  return data;
}

function parseValue(raw) {
  const v = raw.trim();
  if (v === '[]') return [];
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function readEntryFile(skillDir) {
  const candidates = ['SKILL.md', 'AGENTS.md', 'instructions.md'];
  for (const name of candidates) {
    const p = join(skillDir, name);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  const cursorRules = join(skillDir, '.cursor', 'rules');
  if (existsSync(cursorRules)) {
    const files = readdirSync(cursorRules).filter((f) => f.endsWith('.mdc'));
    if (files.length) return readFileSync(join(cursorRules, files[0]), 'utf8');
  }
  try {
    const entries = readdirSync(skillDir);
    const md = entries.find((f) => f.endsWith('.md'));
    if (md) return readFileSync(join(skillDir, md), 'utf8');
  } catch { /* ignore */ }
  return null;
}

function extractShortDescription(text) {
  const lines = text.split('\n');
  let pastTitle = false;
  let collecting = [];
  for (const line of lines) {
    if (line.startsWith('# ')) { pastTitle = true; continue; }
    if (!pastTitle) continue;
    if (line.startsWith('## ')) break;
    if (line.trim()) collecting.push(line.trim());
    else if (collecting.length) break;
  }
  const para = collecting.join(' ');
  const sentence = para.split(/(?<=[.!?])\s/)[0] || para;
  return sentence.length > 120 ? sentence.slice(0, 117) + '...' : sentence;
}

function prettySkillName(dirName) {
  const cleaned = dirName
    .replace(/[-_]/g, ' ');
  return cleaned
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bAi\b/g, 'AI')
    .replace(/\bPr\b/g, 'PR')
    .replace(/\bGh\b/g, 'GH');
}

export function buildAgentCatalog() {
  if (!existsSync(SKILLS_ROOT)) return { platforms: [] };

  const platformDirs = readdirSync(SKILLS_ROOT)
    .filter((d) => {
      const p = join(SKILLS_ROOT, d);
      return statSync(p).isDirectory();
    })
    .filter((d) => PLATFORMS[d]);

  const platforms = [];

  for (const platformId of platformDirs) {
    const platformDir = join(SKILLS_ROOT, platformId);
    const meta = PLATFORMS[platformId];
    const skills = [];

    let skillDirs;
    try {
      skillDirs = readdirSync(platformDir).filter((d) => {
        const p = join(platformDir, d);
        try { return statSync(p).isDirectory(); } catch { return false; }
      });
    } catch { skillDirs = []; }

    for (const skillDir of skillDirs) {
      const fullDir = join(platformDir, skillDir);
      const entryText = readEntryFile(fullDir);
      if (!entryText) continue;

      const fm = parseFrontmatter(entryText);
      const description = fm?.description || extractShortDescription(entryText) || '';
      const shortDesc = description.length > 100
        ? description.slice(0, 97) + '...'
        : description;

      skills.push({
        id: skillDir,
        name: prettySkillName(skillDir),
        skillName: fm?.name || skillDir,
        description: shortDesc,
        fullDescription: description,
        scope: fm?.metadata?.scope || 'general',
        sideEffects: fm?.metadata?.side_effects || 'unknown',
        tier: fm?.metadata?.tier || 'standard',
        path: `skills/${platformId}/${skillDir}`,
      });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));

    if (skills.length) {
      platforms.push({
        id: platformId,
        label: meta.label,
        color: meta.color,
        icon: meta.icon,
        cliCallable: meta.cliCallable,
        agentType: meta.agentType,
        skillCount: skills.length,
        skills,
      });
    }
  }

  platforms.sort((a, b) => a.label.localeCompare(b.label));
  return { platforms };
}
