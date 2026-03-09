import type { BuildService } from "../services/buildService.js";
import type { SkillGemService } from "../services/skillGemService.js";
import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import { wrapHandler } from "../utils/errorHandling.js";
import { readFileSync, statSync, existsSync, writeFileSync } from "node:fs";

export interface SkillGemHandlerContext {
  buildService: BuildService;
  skillGemService: SkillGemService;
  pobDirectory?: string;
  getLuaClient?: () => PoBLuaApiClient | null;
  ensureLuaClient?: () => Promise<void>;
}

/**
 * Handle analyze_skill_links tool call
 */
export async function handleAnalyzeSkillLinks(
  context: SkillGemHandlerContext,
  args?: { build_name?: string; skill_index?: number }
) {
  return wrapHandler('analyze skill links', async () => {
  const { buildService, skillGemService } = context;

  if (!args?.build_name) {
    throw new Error("build_name is required");
  }

  const buildData = await buildService.readBuild(args.build_name);
  const skillIndex = args.skill_index || 0;

  const analysis = skillGemService.analyzeSkillLinks(buildData, skillIndex);

  // Format output
  const outputLines: string[] = [
    `=== Skill Analysis: ${analysis.activeSkill.name} ===`,
    '',
    `Active Skill: ${analysis.activeSkill.name} (Level ${analysis.activeSkill.level}/${analysis.activeSkill.quality})`,
    `Tags: ${analysis.activeSkill.tags.join(", ")}`,
    `Archetype: ${analysis.archetype}`,
    '',
    `=== Support Gems (${analysis.linkCount}-Link) ===`,
  ];

  for (let i = 0; i < analysis.supports.length; i++) {
    const support = analysis.supports[i];
    const symbol = support.rating === "excellent" ? "✓" : support.rating === "poor" ? "✗" : "⚠";

    outputLines.push(`${i + 1}. ${symbol} ${support.name} (${support.level}/${support.quality}) - ${
      support.rating.charAt(0).toUpperCase() + support.rating.slice(1)
    }`);

    if (support.issues && support.issues.length > 0) {
      for (const issue of support.issues) {
        outputLines.push(`   ⚠ ${issue}`);
      }
    }

    if (support.recommendations && support.recommendations.length > 0) {
      for (const rec of support.recommendations) {
        outputLines.push(`   → ${rec}`);
      }
    }
  }

  if (analysis.issues.length > 0) {
    outputLines.push('', '=== Issues Detected ===');
    for (const issue of analysis.issues) {
      outputLines.push(`⚠ ${issue}`);
    }
  }

  outputLines.push(`\n=== Archetype Match: ${Math.round(analysis.archetypeMatch)}% ===`);
  if (analysis.archetypeMatch >= 80) {
    outputLines.push(`Strong alignment with "${analysis.archetype}" archetype`);
  } else if (analysis.archetypeMatch >= 60) {
    outputLines.push(`Moderate alignment with "${analysis.archetype}" archetype`);
  } else {
    outputLines.push(`Weak alignment with "${analysis.archetype}" archetype - consider reviewing gem choices`);
  }

  outputLines.push('', '💡 Use suggest_support_gems to see recommended improvements');
  const output = outputLines.join('\n');

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
  });
}

/**
 * Handle suggest_support_gems tool call
 */
export async function handleSuggestSupportGems(
  context: SkillGemHandlerContext,
  args?: {
    build_name?: string;
    skill_index?: number;
    count?: number;
    include_awakened?: boolean;
    budget?: "league_start" | "mid_league" | "endgame";
  }
) {
  return wrapHandler('suggest support gems', async () => {
  const { buildService, skillGemService } = context;

  if (!args?.build_name) {
    throw new Error("build_name is required");
  }

  const buildData = await buildService.readBuild(args.build_name);
  const skillIndex = args.skill_index || 0;

  const suggestions = skillGemService.suggestSupportGems(buildData, skillIndex, {
    count: args.count,
    includeAwakened: args.include_awakened,
    budget: args.budget,
  });

  // Get current analysis for context
  const analysis = skillGemService.analyzeSkillLinks(buildData, skillIndex);

  // Format output
  const outputLines: string[] = [
    `=== Support Gem Recommendations for ${analysis.activeSkill.name} ===`,
    '',
  ];

  if (suggestions.length === 0) {
    outputLines.push('No recommendations found. Your current setup appears optimal!');
    return {
      content: [
        {
          type: "text" as const,
          text: outputLines.join('\n'),
        },
      ],
    };
  }

  outputLines.push(`Top ${suggestions.length} Recommendations:`, '');

  for (let i = 0; i < suggestions.length; i++) {
    const suggestion = suggestions[i];

    outputLines.push(`${i + 1}. ${suggestion.gem}`);
    if (suggestion.replaces) {
      outputLines.push(`   Replaces: ${suggestion.replaces}`);
    }
    outputLines.push(`   Est. DPS Increase: +${suggestion.dpsIncrease.toFixed(1)}%`);
    outputLines.push(`   Why: ${suggestion.reasoning}`);
    outputLines.push(`   Cost: ${suggestion.cost}`);

    if (suggestion.requires && suggestion.requires.length > 0) {
      outputLines.push(`   Requires: ${suggestion.requires.join(", ")}`);
    }

    if (suggestion.conflicts && suggestion.conflicts.length > 0) {
      outputLines.push(`   ⚠ Conflicts: ${suggestion.conflicts.join(", ")}`);
    }

    outputLines.push('');
  }

  // Add budget-specific recommendations
  const budget = args.budget || "endgame";
  const bestBudget = suggestions.find((s) => s.cost.includes("Chaos"));
  const bestEndgame = suggestions.find((s) => s.dpsIncrease === Math.max(...suggestions.map((s) => s.dpsIncrease)));

  if (bestBudget && budget === "endgame") {
    outputLines.push(`💡 Best Bang-for-Buck: ${bestBudget.gem} (+${bestBudget.dpsIncrease.toFixed(1)}% for ${bestBudget.cost})`);
  }
  if (bestEndgame) {
    outputLines.push(`💡 ${budget === "endgame" ? "Endgame" : "Best"} Priority: ${bestEndgame.gem} (+${bestEndgame.dpsIncrease.toFixed(1)}%)`);
  }
  const output = outputLines.join('\n');

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
  });
}

/**
 * Handle compare_gem_setups tool call
 */
export async function handleCompareGemSetups(
  context: SkillGemHandlerContext,
  args: {
    build_name: string;
    skill_index?: number;
    setups: Array<{ name: string; gems: string[] }>;
  }
) {
  const { buildService, pobDirectory, getLuaClient, ensureLuaClient } = context;

  if (!args.build_name) {
    throw new Error("build_name is required");
  }

  if (!args.setups || args.setups.length < 2) {
    throw new Error("At least 2 setups are required for comparison");
  }

  const buildData = await buildService.readBuild(args.build_name);

  // Get active skill name for context
  const skills = extractSkills(buildData);
  const skillIndex = args.skill_index || 0;
  const activeSkillName = skills[skillIndex]?.gems[0]?.nameSpec || "Unknown Skill";

  const outputLines: string[] = [
    `=== Gem Setup Comparison for ${activeSkillName} ===`,
    '',
    'NOTE: Live DPS simulation per-setup is not yet supported (gem-swap requires PoB API extension).',
    'Showing structural analysis of each setup.',
    '',
  ];

  // Known "more" multiplier support gems
  const MORE_MULTIPLIERS = new Set([
    'Controlled Destruction', 'Elemental Focus', 'Concentrated Effect',
    'Multistrike', 'Faster Attacks', 'Faster Casting', 'Spell Echo',
    'Brutality', 'Void Manipulation', 'Swift Affliction', 'Efficacy',
    'Empower', 'Intensify', 'Infused Channelling', 'Close Combat',
    'Awakened Controlled Destruction', 'Awakened Elemental Focus',
    'Awakened Void Manipulation', 'Awakened Brutality',
    'Awakened Swift Affliction', 'Awakened Efficacy',
  ]);
  const PENETRATION_GEMS = new Set([
    'Fire Penetration', 'Cold Penetration', 'Lightning Penetration',
    'Combustion', 'Energy Leech', 'Ice Bite',
    'Awakened Fire Penetration', 'Awakened Cold Penetration', 'Awakened Lightning Penetration',
  ]);

  for (let i = 0; i < args.setups.length; i++) {
    const setup = args.setups[i];
    const letter = String.fromCharCode(65 + i);
    const moreCount = setup.gems.filter(g => MORE_MULTIPLIERS.has(g)).length;
    const hasPen = setup.gems.some(g => PENETRATION_GEMS.has(g));

    outputLines.push(`Setup ${letter}: "${setup.name}"`);
    outputLines.push(`  Gems (${setup.gems.length}-link): ${setup.gems.join(", ")}`);
    let moreLine = `  "More" multipliers: ${moreCount}`;
    if (setup.gems.length >= 5 && moreCount < 2) moreLine += ` ⚠ (low for a ${setup.gems.length}-link)`;
    outputLines.push(moreLine);
    let penLine = `  Penetration: ${hasPen ? 'Yes' : 'None'}`;
    if (!hasPen) penLine += ` ⚠`;
    outputLines.push(penLine, '');
  }

  outputLines.push('=== Note ===');
  outputLines.push('For accurate DPS comparison, use add_gem + lua_get_stats to manually test each setup.');
  const output = outputLines.join('\n');

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
}

/**
 * Handle validate_gem_quality tool call
 */
export async function handleValidateGemQuality(
  context: SkillGemHandlerContext,
  args?: { build_name?: string; include_corrupted?: boolean }
) {
  const { buildService, skillGemService } = context;

  if (!args?.build_name) {
    throw new Error("build_name is required");
  }

  const buildData = await buildService.readBuild(args.build_name);

  const validation = skillGemService.validateGemQuality(buildData, {
    includeCorrupted: args.include_corrupted,
  });

  // Format output
  const outputLines: string[] = ['=== Gem Quality Validation ===', ''];

  if (validation.needsQuality.length > 0) {
    outputLines.push(`⚠ ${validation.needsQuality.length} gem(s) need quality improvement:`);
    for (let i = 0; i < validation.needsQuality.length; i++) {
      const gem = validation.needsQuality[i];
      outputLines.push(`${i + 1}. ${gem.gem}: ${gem.current} → ${gem.recommended} (Impact: ${gem.impact})`);
    }
    outputLines.push('');
  } else {
    outputLines.push('✓ All gems have quality 20', '');
  }

  if (validation.awakenedUpgrades.length > 0) {
    outputLines.push('⭐ Awakened Gem Upgrades Available:');
    for (let i = 0; i < validation.awakenedUpgrades.length; i++) {
      const upgrade = validation.awakenedUpgrades[i];
      outputLines.push(`${i + 1}. ${upgrade.gem} → ${upgrade.awakened}`);
      outputLines.push(`   Est. DPS Gain: ${upgrade.dpsGain}`);
    }
    outputLines.push('');
  }

  if (validation.corruptionTargets && validation.corruptionTargets.length > 0) {
    outputLines.push('💎 Corruption Opportunities:');
    for (let i = 0; i < validation.corruptionTargets.length; i++) {
      const target = validation.corruptionTargets[i];
      outputLines.push(`${i + 1}. ${target.gem} (current) → ${target.target} (corrupted)`);
      outputLines.push(`   Risk: ${target.risk}`);
    }
    outputLines.push('');
  }

  if (validation.needsQuality.length > 0) {
    const highPriority = validation.needsQuality.find((g) => g.impact === "High");
    if (highPriority) {
      outputLines.push(`💡 Priority: Quality your ${highPriority.gem} first (highest impact)`);
    }
  } else if (validation.awakenedUpgrades.length > 0) {
    outputLines.push('💡 Consider awakened gem upgrades for significant DPS improvements');
  } else {
    outputLines.push('🎉 Your gems are fully optimized!');
  }
  const output = outputLines.join('\n');

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
}

/**
 * Handle find_optimal_links tool call
 */
export async function handleFindOptimalLinks(
  context: SkillGemHandlerContext,
  args: {
    build_name: string;
    skill_index?: number;
    link_count: number;
    budget?: "league_start" | "mid_league" | "endgame";
    optimize_for?: "dps" | "clear_speed" | "bossing" | "defense";
  }
) {
  const { buildService, skillGemService } = context;

  if (!args.build_name) {
    throw new Error("build_name is required");
  }

  if (!args.link_count || args.link_count < 4 || args.link_count > 6) {
    throw new Error("link_count must be between 4 and 6");
  }

  const buildData = await buildService.readBuild(args.build_name);
  const skillIndex = args.skill_index || 0;

  const analysis = skillGemService.analyzeSkillLinks(buildData, skillIndex);
  const suggestions = skillGemService.suggestSupportGems(buildData, skillIndex, {
    count: args.link_count - 1, // Subtract 1 for active skill
    includeAwakened: args.budget !== "league_start",
    budget: args.budget,
  });

  const budget = args.budget || "endgame";
  const optimizeFor = args.optimize_for || "dps";

  // Format output
  const outputLines: string[] = [
    `=== Optimal ${args.link_count}-Link for ${analysis.activeSkill.name} ===`,
    '',
    `Optimization Target: ${optimizeFor.toUpperCase()}`,
    `Budget: ${budget.replace("_", " ").replace(/\b\w/g, (l) => l.toUpperCase())}`,
    '',
    '🏆 Optimal Setup:',
    `1. ${analysis.activeSkill.name} (${analysis.activeSkill.level}/${analysis.activeSkill.quality})`,
  ];

  for (let i = 0; i < Math.min(suggestions.length, args.link_count - 1); i++) {
    outputLines.push(`${i + 2}. ${suggestions[i].gem}`);
  }

  outputLines.push('', '=== Upgrade Path ===', '');

  let cumulativeDPS = 0;
  for (let i = 0; i < Math.min(suggestions.length, args.link_count - 1); i++) {
    const suggestion = suggestions[i];
    cumulativeDPS += suggestion.dpsIncrease;

    let stepLine = `Step ${i + 1}: Add ${suggestion.gem}`;
    if (suggestion.replaces) {
      stepLine += ` (replace ${suggestion.replaces})`;
    }
    outputLines.push(stepLine);
    outputLines.push(`Cost: ${suggestion.cost}`);
    outputLines.push(`Est. DPS Increase: +${suggestion.dpsIncrease.toFixed(1)}%`);
    outputLines.push('');
  }

  outputLines.push('=== Summary ===');
  outputLines.push(`Total Est. DPS Increase: +${cumulativeDPS.toFixed(1)}%`);

  if (budget === "league_start") {
    outputLines.push('', '💡 League start setup focuses on easily obtainable gems');
  } else if (budget === "mid_league") {
    outputLines.push('', '💡 Mid-league setup balances cost and performance');
  } else {
    const bestSuggestion = suggestions[0];
    if (bestSuggestion) {
      outputLines.push('', `💡 Best first upgrade: ${bestSuggestion.gem} (+${bestSuggestion.dpsIncrease.toFixed(1)}%)`);
    }
  }
  const output = outputLines.join('\n');

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
}

/**
 * Handle gem_upgrade_path tool call
 */
export async function handleGemUpgradePath(
  context: SkillGemHandlerContext,
  args: { build_name?: string; budget?: string }
) {
  if (!context.ensureLuaClient || !context.getLuaClient) {
    throw new Error('Lua bridge not configured. Use lua_load_build first.');
  }
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  const skills = await luaClient.getSkills();
  const groups: any[] = skills?.groups ?? [];

  const budgetTier = ((args.budget || 'endgame') as 'league_start' | 'mid_league' | 'endgame');
  const budgetMap: Record<string, number> = { league_start: 0, mid_league: 50, endgame: 999 };
  const budgetChaos = budgetMap[budgetTier] ?? 999;

  interface GemUpgrade {
    gemName: string;
    groupLabel: string;
    currentLevel: number;
    currentQuality: number;
    action: string;
    priority: number;
    costEstimate: string;
    reason: string;
  }

  const upgrades: GemUpgrade[] = [];

  for (const group of groups) {
    const isMain = group.index === skills.mainSocketGroup;
    for (const gem of (group.gems ?? [])) {
      const name: string = gem.name || gem;
      const level: number = gem.level ?? 1;
      const quality: number = gem.quality ?? 0;
      const isSupport = name.includes('Support') || name.includes('Mirage') || gem.isSupport;
      const multiplier = isMain ? 3 : 1;

      // Level upgrade
      if (level < 20) {
        upgrades.push({
          gemName: name,
          groupLabel: group.label || `Group ${group.index}`,
          currentLevel: level,
          currentQuality: quality,
          action: `Level to 20 (currently ${level})`,
          priority: (20 - level) * multiplier * (isSupport ? 0.8 : 1.2),
          costEstimate: 'Free (just level it)',
          reason: 'Every gem level increases gem power — level gems in inactive weapon swap slots',
        });
      }

      // Quality upgrade
      if (quality < 20) {
        const costChaos = Math.round((20 - quality) * 0.2);
        if (costChaos <= budgetChaos) {
          upgrades.push({
            gemName: name,
            groupLabel: group.label || `Group ${group.index}`,
            currentLevel: level,
            currentQuality: quality,
            action: `Bring to 20% quality (currently ${quality}%)`,
            priority: (20 - quality) * multiplier * (isSupport ? 0.6 : 0.9),
            costEstimate: `~${costChaos}c in Gemcutter's Prisms`,
            reason: 'Quality bonuses stack with gem level — use Hillock crafting bench for +28% quality',
          });
        }
      }

      // 21/20 via corruption
      if (level === 20 && quality === 20 && isMain) {
        upgrades.push({
          gemName: name,
          groupLabel: group.label || `Group ${group.index}`,
          currentLevel: level,
          currentQuality: quality,
          action: 'Corrupt for 21/20 (Vaal Orb on 20/20)',
          priority: 15 * multiplier,
          costEstimate: '25% chance of 21/20, 25% chance brick — buy pre-corrupted 21/20 for safety',
          reason: 'Level 21 is a significant DPS increase for active gems; corruption is high-risk/reward',
        });
      }

      // Awakened version for supports
      if (isSupport && isMain && level >= 18 && budgetTier === 'endgame') {
        upgrades.push({
          gemName: name,
          groupLabel: group.label || `Group ${group.index}`,
          currentLevel: level,
          currentQuality: quality,
          action: `Buy Awakened ${name.replace(' Support', '')} Support`,
          priority: 20,
          costEstimate: 'Varies greatly — check poe.ninja prices',
          reason: 'Awakened supports have higher quality bonuses and occasionally better base effects',
        });
      }
    }
  }

  upgrades.sort((a, b) => b.priority - a.priority);

  const outputLines: string[] = ['=== Gem Upgrade Path ===', `Budget tier: ${budgetTier}`, ''];

  if (upgrades.length === 0) {
    outputLines.push('All gems appear to be fully upgraded!');
    return { content: [{ type: 'text' as const, text: outputLines.join('\n') }] };
  }

  let rank = 1;
  for (const u of upgrades.slice(0, 15)) {
    outputLines.push(`**${rank}. ${u.gemName}** (${u.groupLabel})`);
    outputLines.push(`   Action: ${u.action}`);
    outputLines.push(`   Cost: ${u.costEstimate}`);
    outputLines.push(`   Why: ${u.reason}`);
    outputLines.push('');
    rank++;
  }

  outputLines.push('_Use `validate_gem_quality` for a full gem quality audit._');

  return { content: [{ type: 'text' as const, text: outputLines.join('\n') }] };
}

// ============================================================
// Gems.lua parser — shared cache for gem database tools
// ============================================================

const GEMS_LUA_PATH = '/Users/jonkraatz/poe/PathOfBuilding/src/Data/Gems.lua';
const GEMS_CACHE_PATH = '/tmp/pob-gems-cache.json';

interface GemEntry {
  gameId: string;
  name: string;
  variantId: string;
  grantedEffectId: string;
  tags: string[];
  isSupport: boolean;
  isVaal: boolean;
}

function parseGemsLuaForHandler(): Record<string, GemEntry> {
  const text = readFileSync(GEMS_LUA_PATH, 'utf8');
  const gemBlockRegex = /\["(Metadata\/Items\/Gems\/[^"]+)"\] = \{([\s\S]*?)\n\t\},/g;
  const db: Record<string, GemEntry> = {};

  for (const match of text.matchAll(gemBlockRegex)) {
    const gameId = match[1];
    const body = match[2];

    const name = body.match(/\bname = "([^"]+)"/)?.[1] ?? '';
    const variantId = body.match(/\bvariantId = "([^"]+)"/)?.[1] ?? '';
    const grantedEffectId = body.match(/\bgrantedEffectId = "([^"]+)"/)?.[1] ?? '';

    const tagsBlock = body.match(/\btags = \{([\s\S]*?)\n\t\t\},/)?.[1] ?? '';
    const tags = [...tagsBlock.matchAll(/\b(\w+) = true/g)].map(m => m[1]);

    const isSupport = tags.includes('support') || gameId.includes('SupportGem');
    const isVaal = name.startsWith('Vaal ') || (gameId.includes('Vaal') && !gameId.includes('VaalOil'));

    db[gameId] = { gameId, name, variantId, grantedEffectId, tags, isSupport, isVaal };
  }

  return db;
}

let gemsDbCache: Record<string, GemEntry> | null = null;

function loadGemsDb(): Record<string, GemEntry> {
  if (gemsDbCache) return gemsDbCache;

  try {
    const srcModTime = statSync(GEMS_LUA_PATH).mtimeMs;
    if (existsSync(GEMS_CACHE_PATH)) {
      const cacheModTime = statSync(GEMS_CACHE_PATH).mtimeMs;
      if (cacheModTime > srcModTime) {
        gemsDbCache = JSON.parse(readFileSync(GEMS_CACHE_PATH, 'utf8'));
        return gemsDbCache!;
      }
    }
    const db = parseGemsLuaForHandler();
    writeFileSync(GEMS_CACHE_PATH, JSON.stringify(db));
    gemsDbCache = db;
    return db;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load Gems.lua: ${errMsg}`);
  }
}

/**
 * Handle search_gems tool call
 */
export async function handleSearchGems(
  args: {
    query?: string;
    tag?: string;
    gem_type?: 'active' | 'support' | 'vaal' | 'any';
    limit?: number;
  }
) {
  return wrapHandler('search gems', async () => {
    const db = loadGemsDb();
    const { query, tag, gem_type = 'any', limit = 20 } = args;

    const queryLower = query?.toLowerCase();
    const tagLower = tag?.toLowerCase();

    const matches = Object.values(db).filter(gem => {
      if (queryLower && !gem.name.toLowerCase().includes(queryLower)) return false;
      if (tagLower && !gem.tags.some(t => t.toLowerCase().includes(tagLower))) return false;
      if (gem_type === 'support' && !gem.isSupport) return false;
      if (gem_type === 'active' && (gem.isSupport || gem.isVaal)) return false;
      if (gem_type === 'vaal' && !gem.isVaal) return false;
      return true;
    });

    const limited = matches.slice(0, limit);

    const lines: string[] = [
      `=== Gem Search Results ===`,
      `Query: ${query || '(any)'}  Tag: ${tag || '(any)'}  Type: ${gem_type}`,
      `Found ${matches.length} gems (showing ${limited.length}):`,
      '',
    ];

    for (const gem of limited) {
      const typeTag = gem.isVaal ? ' [VAAL]' : gem.isSupport ? ' [SUPPORT]' : ' [ACTIVE]';
      lines.push(`**${gem.name}**${typeTag}`);
      lines.push(`  gemId:     "${gem.gameId}"`);
      lines.push(`  skillId:   "${gem.variantId}"`);
      lines.push(`  variantId: "${gem.variantId}"`);
      lines.push(`  tags: ${gem.tags.join(', ')}`);
      lines.push('');
    }

    if (limited.length === 0) {
      lines.push('No gems matched your search criteria.');
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  });
}

/**
 * Handle rank_support_gems_for_skill tool call
 */
export async function handleRankSupportGemsForSkill(
  context: SkillGemHandlerContext,
  args: {
    skill_name: string;
    num_links: 4 | 5 | 6;
    fixed_gems?: string[];
    limit?: number;
  }
) {
  return wrapHandler('rank support gems for skill', async () => {
    if (!context.ensureLuaClient || !context.getLuaClient) {
      throw new Error('Lua bridge not configured. Use lua_load_build first.');
    }
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

    const { skill_name, num_links, fixed_gems = [], limit = 10 } = args;

    // Get baseline stats (current skill setup)
    const baseStats = await luaClient.getStats(['CombinedDPS', 'TotalDPS', 'MinionTotalDPS']);
    const baseDPS = (baseStats.CombinedDPS as number) || (baseStats.TotalDPS as number) || (baseStats.MinionTotalDPS as number) || 1;

    // Get all support gems from the db
    const db = loadGemsDb();
    const supportGems = Object.values(db).filter(g => g.isSupport && !g.isVaal);

    const notes: string[] = [];
    const ranked: Array<{ gem_name: string; dps: number; delta: number; delta_pct: number }> = [];
    const fixedGemSet = new Set(fixed_gems.map(n => n.toLowerCase()));

    for (const gem of supportGems) {
      if (fixedGemSet.has(gem.name.toLowerCase())) continue;

      try {
        // Create a temporary socket group with active + fixed + test support
        const groupResult = await luaClient.createSocketGroup({ label: '__rank_test__', enabled: true });
        const groupIndex: number = groupResult.index;

        // Add active skill
        await luaClient.addGem({ groupIndex, gemName: skill_name, level: 20, quality: 20, enabled: true });
        // Add fixed gems
        for (const fg of fixed_gems) {
          await luaClient.addGem({ groupIndex, gemName: fg, level: 20, quality: 20, enabled: true });
        }
        // Add the test support gem
        await luaClient.addGem({ groupIndex, gemName: gem.name, level: 20, quality: 20, enabled: true });

        const testStats = await luaClient.getStats(['CombinedDPS', 'TotalDPS', 'MinionTotalDPS']);
        const testDPS = (testStats.CombinedDPS as number) || (testStats.TotalDPS as number) || (testStats.MinionTotalDPS as number) || baseDPS;
        const delta = testDPS - baseDPS;
        const deltaPct = (delta / baseDPS) * 100;

        ranked.push({ gem_name: gem.name, dps: testDPS, delta, delta_pct: deltaPct });

        // Remove the temporary group (use removeSkill if available, otherwise leave)
        try {
          await luaClient.removeSkill({ groupIndex });
        } catch { /* best-effort cleanup */ }
      } catch {
        notes.push(`${gem.name}: errored during test`);
      }
    }

    ranked.sort((a, b) => b.dps - a.dps);
    const top = ranked.slice(0, limit);

    const lines: string[] = [
      `=== Support Gem Ranking for ${skill_name} (${num_links}-link) ===`,
      '',
      `Baseline DPS: ${Math.round(baseDPS).toLocaleString()}`,
      `Fixed gems: ${fixed_gems.length > 0 ? fixed_gems.join(', ') : '(none)'}`,
      `Tested ${ranked.length} support gems (showing top ${top.length}):`,
      '',
    ];

    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const sign = r.delta >= 0 ? '+' : '';
      lines.push(`${i + 1}. **${r.gem_name}**`);
      lines.push(`   DPS: ${Math.round(r.dps).toLocaleString()}  |  Delta: ${sign}${Math.round(r.delta).toLocaleString()} (${sign}${r.delta_pct.toFixed(1)}%)`);
    }

    if (notes.length > 0) {
      lines.push('', `Warnings (${notes.length}):`, ...notes.slice(0, 5).map(n => `  - ${n}`));
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  });
}

/**
 * Helper: Extract skills from build
 */
function extractSkills(build: any): Array<{ gems: any[]; slot: string }> {
  const skills: Array<{ gems: any[]; slot: string }> = [];

  if (build.Skills?.SkillSet) {
    const skillSets = Array.isArray(build.Skills.SkillSet)
      ? build.Skills.SkillSet
      : [build.Skills.SkillSet];

    for (const skillSet of skillSets) {
      if (skillSet.Skill) {
        const skillArray = Array.isArray(skillSet.Skill) ? skillSet.Skill : [skillSet.Skill];

        for (const skill of skillArray) {
          if (skill.Gem) {
            const gems = Array.isArray(skill.Gem) ? skill.Gem : [skill.Gem];
            skills.push({
              gems,
              slot: skill.slot || "Unknown",
            });
          }
        }
      }
    }
  }

  return skills;
}
