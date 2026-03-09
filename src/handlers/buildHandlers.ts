import type { BuildService } from "../services/buildService.js";
import type { TreeService } from "../services/treeService.js";
import type { ValidationService } from "../services/validationService.js";
import type { TreeAnalysisResult } from "../types.js";
import type { HandlerContext } from "../utils/contextBuilder.js";
import path from "path";
import fs from "fs/promises";
import zlib from "zlib";
import { wrapHandler } from "../utils/errorHandling.js";
export type { HandlerContext } from "../utils/contextBuilder.js";

// PoB encoding helpers (base64url + zlib)
function pobEncode(xml: string): string {
  const compressed = zlib.deflateSync(Buffer.from(xml, 'utf8'), { level: 9 });
  return compressed.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function pobDecode(code: string): string {
  const base64 = code
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const buf = Buffer.from(base64, 'base64');
  return zlib.inflateSync(buf).toString('utf8');
}

// Class start node IDs (PoE 3.x passive tree class roots)
const CLASS_START_NODES: Record<string, number> = {
  Scion: 58833,
  Marauder: 58833, // placeholder — each class has a distinct start
  Ranger: 50459,
  Witch: 12769,
  Duelist: 56055,
  Templar: 27033,
  Shadow: 54127,
};

// White placeholder item text for skeleton builds
function makePlaceholderItem(slot: string): string {
  const baseMap: Record<string, string> = {
    Helmet: 'Iron Hat',
    'Body Armour': 'Simple Robe',
    Gloves: 'Wool Gloves',
    Boots: 'Boots',
    'Weapon 1': 'Driftwood Wand',
    'Weapon 2': 'Driftwood Shield',
    'Ring 1': 'Iron Ring',
    'Ring 2': 'Iron Ring',
    Amulet: 'Coral Amulet',
    Belt: 'Leather Belt',
  };
  const base = baseMap[slot] || 'Iron Ring';
  return `Rarity: NORMAL\n${base}\n--------\nSlot: ${slot}`;
}

export async function handleListBuilds(context: HandlerContext) {
  return wrapHandler('list builds', async () => {
    const builds = await context.buildService.listBuilds();
    return {
      content: [
        {
          type: "text" as const,
          text: builds.length > 0
            ? `Available builds:\n${builds.map((b, i) => `${i + 1}. ${b}`).join("\n")}`
            : "No builds found in the Path of Building directory.",
        },
      ],
    };
  });
}

export async function handleAnalyzeBuild(context: HandlerContext, buildName: string) {
  return wrapHandler('analyze build', async () => {
  const build = await context.buildService.readBuild(buildName);

  // Try to get live Lua stats — only load from file if the same build is already loaded
  // or if no build is loaded. Never replace a *different* in-memory build (data-loss risk).
  let luaStats: any = null;
  let luaSkipped = false;
  try {
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();

    if (luaClient) {
      let shouldLoad = true;
      try {
        const info = await luaClient.getBuildInfo();
        const loadedName: string = info?.name ?? '';
        // Strip .xml suffix for comparison since PoB may omit it
        const requested = buildName.replace(/\.xml$/i, '');
        const loaded    = loadedName.replace(/\.xml$/i, '');
        if (loaded && loaded !== requested) {
          // A different build is in memory — skip loading to avoid destroying unsaved work
          shouldLoad = false;
          luaSkipped = true;
        }
      } catch { /* no build loaded yet — safe to load */ }

      if (shouldLoad) {
        const buildPath = path.join(context.pobDirectory, buildName);
        const buildXml = await fs.readFile(buildPath, 'utf-8');
        await luaClient.loadBuildXml(buildXml);
        luaStats = await luaClient.getStats();
      } else {
        // Still try to get stats from the currently-loaded build for reference
        try { luaStats = await luaClient.getStats(); } catch { /* best effort */ }
      }
    }
  } catch (error) {
    // Continue with XML-only analysis
  }

  const summaryParts: string[] = [context.buildService.generateBuildSummary(build)];

  if (luaSkipped) {
    summaryParts.push(
      "\n⚠️  Note: A different build is loaded in the Lua bridge. Stats shown are from that build.\n" +
      "    Use lua_load_build to load this build for accurate live stats."
    );
  }

  // If we have Lua stats, add them
  if (luaStats) {
    summaryParts.push([
      '\n=== Live Calculated Stats (from Lua) ===',
      '',
      `Total DPS: ${luaStats.TotalDPS || 'N/A'}`,
      `Combined DPS: ${luaStats.CombinedDPS || 'N/A'}`,
      `Life: ${luaStats.Life || 'N/A'}`,
      `Energy Shield: ${luaStats.EnergyShield || 'N/A'}`,
      `Effective Life Pool: ${luaStats.TotalEHP || 'N/A'}`,
      '',
    ].join('\n'));
  }

  // Add configuration analysis
  try {
    const config = context.buildService.parseConfiguration(build);
    if (config) {
      summaryParts.push("\n" + context.buildService.formatConfiguration(config));
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    summaryParts.push(`\n=== Configuration ===\n\nConfiguration parsing error: ${errorMsg}`);
  }

  // Add flask analysis
  try {
    const flaskAnalysis = context.buildService.parseFlasks(build);
    if (flaskAnalysis) {
      summaryParts.push("\n" + context.buildService.formatFlaskAnalysis(flaskAnalysis));
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    summaryParts.push(`\n=== Flask Setup ===\n\nFlask parsing error: ${errorMsg}`);
  }

  // Add jewel analysis
  try {
    const jewelAnalysis = context.buildService.parseJewels(build);
    if (jewelAnalysis) {
      summaryParts.push("\n" + context.buildService.formatJewelAnalysis(jewelAnalysis));
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    summaryParts.push(`\n=== Jewel Setup ===\n\nJewel parsing error: ${errorMsg}`);
  }

  // Add tree analysis
  try {
    const treeAnalysis = await context.treeService.analyzePassiveTree(build);
    if (treeAnalysis) {
      summaryParts.push(formatTreeAnalysis(treeAnalysis));
    } else {
      summaryParts.push("\n=== Passive Tree ===\n\nNo passive tree data found in this build.");
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes("Invalid passive tree data detected")) {
      // Return the full error message for invalid nodes
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${errorMsg}`,
          },
        ],
      };
    } else {
      // For other errors, show notice but continue with other sections
      summaryParts.push([
        '\n=== Passive Tree ===',
        '',
        `Passive tree analysis unavailable: ${errorMsg}`,
        'Other build sections are still available above.',
      ].join('\n'));
    }
  }

  // Add build validation (at the end, after all data sections)
  try {
    const flaskAnalysis = context.buildService.parseFlasks(build);
    const validation = context.validationService.validateBuild(build, flaskAnalysis, luaStats ?? undefined);
    summaryParts.push("\n" + context.validationService.formatValidation(validation));
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    summaryParts.push(`\n=== Build Validation ===\n\nValidation error: ${errorMsg}`);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: summaryParts.join('\n'),
      },
    ],
  };
  });
}

export async function handleCompareBuilds(context: HandlerContext, build1Name: string, build2Name: string) {
  return wrapHandler('compare builds', async () => {
  const build1 = await context.buildService.readBuild(build1Name);
  const build2 = await context.buildService.readBuild(build2Name);

  const compLines: string[] = [
    '=== Build Comparison ===',
    '',
    `Build 1: ${build1Name}`,
    `Build 2: ${build2Name}`,
    '',
    `Class: ${build1.Build?.className} vs ${build2.Build?.className}`,
    `Ascendancy: ${build1.Build?.ascendClassName} vs ${build2.Build?.ascendClassName}`,
    '',
    '=== Key Stats Comparison ===',
  ];

  const stats1 = build1.Build?.PlayerStat;
  const stats2 = build2.Build?.PlayerStat;

  if (stats1 && stats2) {
    const statsArray1 = Array.isArray(stats1) ? stats1 : [stats1];
    const statsArray2 = Array.isArray(stats2) ? stats2 : [stats2];

    const statMap1 = new Map(statsArray1.map(s => [s.stat, s.value]));
    const statMap2 = new Map(statsArray2.map(s => [s.stat, s.value]));

    for (const [stat, value1] of statMap1) {
      const value2 = statMap2.get(stat);
      if (value2) {
        compLines.push(`${stat}: ${value1} vs ${value2}`);
      }
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: compLines.join('\n'),
      },
    ],
  };
  });
}

export async function handleGetBuildStats(context: HandlerContext, buildName: string) {
  return wrapHandler('get build stats', async () => {
  const build = await context.buildService.readBuild(buildName);

  const statsLines: string[] = [`=== Stats for ${buildName} ===`, ''];

  if (build.Build?.PlayerStat) {
    const stats = Array.isArray(build.Build.PlayerStat)
      ? build.Build.PlayerStat
      : [build.Build.PlayerStat];

    for (const stat of stats) {
      statsLines.push(`${stat.stat}: ${stat.value}`);
    }
  } else {
    statsLines.push('No stats found in build.');
  }

  return {
    content: [
      {
        type: "text" as const,
        text: statsLines.join('\n'),
      },
    ],
  };
  });
}

export async function handleGetBuildNotes(context: HandlerContext, buildName: string) {
  return wrapHandler('get build notes', async () => {
    const build = await context.buildService.readBuild(buildName);
    const notes = build.Notes ?? '';
    return {
      content: [{
        type: 'text' as const,
        text: notes
          ? `=== Notes: ${buildName} ===\n\n${notes}`
          : `No notes found in ${buildName}.`,
      }],
    };
  });
}

export async function handleSetBuildNotes(context: HandlerContext, buildName: string, notes: string) {
  return wrapHandler('set build notes', async () => {
    const buildPath = path.join(context.pobDirectory, buildName);
    let xml = await fs.readFile(buildPath, 'utf-8');

    // XML-escape the notes content so special characters don't corrupt the build file
    const escaped = notes
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    if (xml.includes('<Notes>')) {
      xml = xml.replace(/<Notes>[\s\S]*?<\/Notes>/, `<Notes>${escaped}</Notes>`);
    } else if (xml.includes('<Notes/>')) {
      xml = xml.replace('<Notes/>', `<Notes>${escaped}</Notes>`);
    } else {
      xml = xml.replace('</PathOfBuilding>', `  <Notes>${escaped}</Notes>\n</PathOfBuilding>`);
    }

    await fs.writeFile(buildPath, xml, 'utf-8');
    // Invalidate the build cache so a subsequent get_build_notes reads the updated file
    context.buildService.invalidateBuild(buildName);
    return {
      content: [{
        type: 'text' as const,
        text: `✅ Notes updated in ${buildName} (${notes.length} characters).`,
      }],
    };
  });
}

// ============================================================
// snapshot_diff_audit — compare two build files across 4 dimensions
// ============================================================

export async function handleSnapshotDiffAudit(
  context: HandlerContext,
  snapshotA: string,
  snapshotB: string
) {
  return wrapHandler('snapshot diff audit', async () => {
    const luaClient = context.getLuaClient();

    // Helper to load a build file and capture stats
    async function captureSnapshot(buildName: string) {
      const buildPath = path.join(context.pobDirectory, buildName);
      const xml = await fs.readFile(buildPath, 'utf-8');

      let stats: Record<string, unknown> = {};
      let nodeIds: string[] = [];
      let equippedItems: any[] = [];
      let skillSetup: any = null;

      if (luaClient) {
        try {
          await luaClient.loadBuildXml(xml);
          const rawStats = await luaClient.getStats();
          stats = rawStats as Record<string, unknown>;
          const treeResult = await luaClient.getTree();
          nodeIds = (treeResult.nodes || []).map(String);
          const itemsRaw = await luaClient.getItems();
          equippedItems = Array.isArray(itemsRaw) ? itemsRaw : [];
          const skillResult = await luaClient.getSkills();
          skillSetup = skillResult;
        } catch {
          // fall through — partial data is fine
        }
      }

      return { stats, nodeIds, equippedItems, skillSetup };
    }

    const [snapA, snapB] = await Promise.all([
      captureSnapshot(snapshotA),
      captureSnapshot(snapshotB),
    ]);

    // Stat deltas
    const statKeys = ['CombinedDPS', 'TotalDPS', 'Life', 'TotalEHP', 'Armour',
                      'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist'];
    const statsLines: string[] = ['=== Stat Deltas ===', ''];
    for (const key of statKeys) {
      const a = Number(snapA.stats[key] ?? 0);
      const b = Number(snapB.stats[key] ?? 0);
      if (a === 0 && b === 0) continue;
      const delta = b - a;
      const deltaPct = a !== 0 ? ((delta / Math.abs(a)) * 100).toFixed(1) : 'N/A';
      const sign = delta >= 0 ? '+' : '';
      statsLines.push(`${key}: ${Math.round(a).toLocaleString()} → ${Math.round(b).toLocaleString()} (${sign}${Math.round(delta).toLocaleString()}, ${sign}${deltaPct}%)`);
    }

    // Resist deltas specifically
    const resistLines: string[] = ['', '=== Resist Deltas ===', ''];
    for (const [label, key] of [['Fire', 'FireResist'], ['Cold', 'ColdResist'], ['Lightning', 'LightningResist'], ['Chaos', 'ChaosResist']]) {
      const a = Number(snapA.stats[key] ?? 0);
      const b = Number(snapB.stats[key] ?? 0);
      const delta = b - a;
      resistLines.push(`${label}: ${delta >= 0 ? '+' : ''}${delta.toFixed(0)}`);
    }

    // Node diffs
    const nodesA = new Set(snapA.nodeIds);
    const nodesB = new Set(snapB.nodeIds);
    const nodesAdded = [...nodesB].filter(n => !nodesA.has(n));
    const nodesRemoved = [...nodesA].filter(n => !nodesB.has(n));

    const nodeLines: string[] = ['', '=== Passive Tree Changes ===', ''];
    nodeLines.push(`Nodes added (${nodesAdded.length}): ${nodesAdded.slice(0, 20).join(', ')}${nodesAdded.length > 20 ? ' ...' : ''}`);
    nodeLines.push(`Nodes removed (${nodesRemoved.length}): ${nodesRemoved.slice(0, 20).join(', ')}${nodesRemoved.length > 20 ? ' ...' : ''}`);

    // Item diffs (by slot)
    const itemsA = new Map<string, string>();
    const itemsB = new Map<string, string>();
    for (const item of snapA.equippedItems) {
      if (item.slot) itemsA.set(item.slot, item.name || '(unknown)');
    }
    for (const item of snapB.equippedItems) {
      if (item.slot) itemsB.set(item.slot, item.name || '(unknown)');
    }
    const itemLines: string[] = ['', '=== Item Changes ===', ''];
    const allSlots = new Set([...itemsA.keys(), ...itemsB.keys()]);
    let itemChanges = 0;
    for (const slot of allSlots) {
      const nameA = itemsA.get(slot) ?? '(empty)';
      const nameB = itemsB.get(slot) ?? '(empty)';
      if (nameA !== nameB) {
        itemLines.push(`${slot}: "${nameA}" → "${nameB}"`);
        itemChanges++;
      }
    }
    if (itemChanges === 0) itemLines.push('No item changes detected.');

    const output = [
      `=== Snapshot Diff: ${snapshotA} → ${snapshotB} ===`,
      '',
      ...statsLines,
      ...resistLines,
      ...nodeLines,
      ...itemLines,
    ].join('\n');

    return {
      content: [{ type: 'text' as const, text: output }],
    };
  });
}

// ============================================================
// generate_build_skeleton — create minimal PoB import code
// ============================================================

export async function handleGenerateBuildSkeleton(
  args: {
    class_name: string;
    ascendancy: string;
    main_skill: string;
    level?: number;
  }
) {
  return wrapHandler('generate build skeleton', async () => {
    const { class_name, ascendancy, main_skill, level = 1 } = args;

    if (!class_name) throw new Error('class_name is required');
    if (!ascendancy) throw new Error('ascendancy is required');
    if (!main_skill) throw new Error('main_skill is required');

    const startNodeId = CLASS_START_NODES[class_name] ?? 58833;

    const slots = ['Helmet', 'Body Armour', 'Gloves', 'Boots', 'Weapon 1', 'Weapon 2', 'Ring 1', 'Ring 2', 'Amulet', 'Belt'];
    const itemsXml = slots.map((slot, i) => {
      const id = i + 1;
      const itemText = makePlaceholderItem(slot);
      return `    <Item id="${id}">\n${itemText}\n    </Item>`;
    }).join('\n');

    const slotXml = slots.map((slot, i) => {
      const id = i + 1;
      return `    <Slot name="${slot}" itemId="${id}"/>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PathOfBuilding>
  <Build level="${level}" targetVersion="3_0" className="${class_name}" ascendClassName="${ascendancy}">
    <PlayerStat stat="Life" value="0"/>
  </Build>
  <Skills>
    <SkillSet id="1">
      <Skill mainActiveSkill="1" enabled="true" slot="Body Armour">
        <Gem skillId="${main_skill}" level="1" quality="0" enabled="true"/>
      </Skill>
    </SkillSet>
  </Skills>
  <Tree activeSpec="1">
    <Spec id="1" nodes="${startNodeId}" treeVersion="3_21">
    </Spec>
  </Tree>
  <Items>
${itemsXml}
    <ItemSet id="1">
${slotXml}
    </ItemSet>
  </Items>
  <Notes>Generated skeleton build: ${class_name} (${ascendancy}) — ${main_skill}</Notes>
</PathOfBuilding>`;

    const pobCode = pobEncode(xml);

    return {
      content: [{
        type: 'text' as const,
        text: [
          `=== Build Skeleton: ${class_name} (${ascendancy}) ===`,
          '',
          `Main Skill: ${main_skill}  |  Level: ${level}`,
          '',
          '=== PoB Import Code ===',
          pobCode,
          '',
          '=== Raw XML ===',
          xml,
        ].join('\n'),
      }],
    };
  });
}

// ============================================================
// decode_pob_code — decode PoB import string to XML
// ============================================================

export async function handleDecodePobCode(pobCode: string) {
  return wrapHandler('decode pob code', async () => {
    if (!pobCode || typeof pobCode !== 'string') {
      throw new Error('pob_code is required');
    }

    let xml: string;
    try {
      xml = pobDecode(pobCode.trim());
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to decode PoB code: ${errMsg}. Ensure it is a valid base64url-encoded PoB import string.`);
    }

    // Extract key fields from XML
    const classMatch = xml.match(/className="([^"]+)"/);
    const ascendMatch = xml.match(/ascendClassName="([^"]+)"/);
    const levelMatch = xml.match(/level="(\d+)"/);
    const skillMatch = xml.match(/<Gem[^>]+skillId="([^"]+)"/);

    const className = classMatch?.[1] ?? 'Unknown';
    const ascendancy = ascendMatch?.[1] ?? 'Unknown';
    const level = levelMatch ? parseInt(levelMatch[1]) : 0;
    const mainSkill = skillMatch?.[1] ?? 'Unknown';

    return {
      content: [{
        type: 'text' as const,
        text: [
          '=== Decoded PoB Build ===',
          '',
          `Class: ${className} (${ascendancy})`,
          `Level: ${level}`,
          `Main Skill: ${mainSkill}`,
          '',
          '=== Raw XML ===',
          xml,
        ].join('\n'),
      }],
    };
  });
}

function formatTreeAnalysis(analysis: TreeAnalysisResult): string {
  const lines: string[] = ['', '=== Passive Tree ==='];

  // Version warning
  if (analysis.versionMismatch) {
    lines.push(
      `\nWARNING: This build is from version ${analysis.buildVersion}.`,
      `Current passive tree data is from version ${analysis.treeVersion}.`,
      'The passive tree may have changed between these versions.'
    );
  }

  lines.push(`\nTree Version: ${analysis.treeVersion}`);
  lines.push(`Total Points: ${analysis.totalPoints} / ${analysis.availablePoints} available`);

  if (analysis.totalPoints > analysis.availablePoints) {
    lines.push(
      '\nWARNING: This build has more points allocated than available at this level.',
      'This is not possible in the actual game.'
    );
  }

  // Ascendancy nodes (separate from regular keystones/notables)
  const ascendancyNodes = analysis.allocatedNodes.filter(n => n.ascendancyName);
  if (ascendancyNodes.length > 0) {
    const ascendancyName = ascendancyNodes[0].ascendancyName;
    lines.push(`\n=== Ascendancy: ${ascendancyName} (${ascendancyNodes.length} points) ===`);
    for (const node of ascendancyNodes) {
      let line = `- ${node.name}`;
      if (node.stats && node.stats.length > 0) {
        line += `: ${node.stats.join('; ')}`;
      }
      lines.push(line);
    }
  }

  // Keystones (regular tree only)
  const regularKeystones = analysis.keystones.filter(k => !k.ascendancyName);
  if (regularKeystones.length > 0) {
    lines.push(`\nAllocated Keystones (${regularKeystones.length}):`);
    for (const keystone of regularKeystones) {
      let line = `- ${keystone.name}`;
      if (keystone.stats && keystone.stats.length > 0) {
        line += `: ${keystone.stats.join('; ')}`;
      }
      lines.push(line);
    }
  }

  // Notable passives (regular tree only)
  const regularNotables = analysis.notables.filter(n => !n.ascendancyName);
  if (regularNotables.length > 0) {
    lines.push(`\nKey Notable Passives (${regularNotables.length} total):`);
    // Show first 10 notables
    const displayNotables = regularNotables.slice(0, 10);
    for (const notable of displayNotables) {
      let line = `- ${notable.name || 'Unnamed'}`;
      if (notable.stats && notable.stats.length > 0) {
        const statSummary = notable.stats.join('; ').substring(0, 80);
        line += `: ${statSummary}`;
      }
      lines.push(line);
    }
    if (regularNotables.length > 10) {
      lines.push(`... and ${regularNotables.length - 10} more notables`);
    }
  }

  // Jewel sockets
  if (analysis.jewels.length > 0) {
    lines.push(`\nJewel Sockets: ${analysis.jewels.length} allocated`);
  }

  // Archetype
  lines.push(
    `\nDetected Archetype: ${analysis.archetype}`,
    `Confidence: ${analysis.archetypeConfidence}`,
    '[Pending user confirmation]'
  );

  // Pathing efficiency
  lines.push(
    `\nPathing Efficiency: ${analysis.pathingEfficiency}`,
    `- Total pathing nodes: ${analysis.normalNodes.length}`
  );

  // Phase 2: Optimization Suggestions
  if (analysis.optimizationSuggestions && analysis.optimizationSuggestions.length > 0) {
    lines.push('\n=== Optimization Suggestions ===');

    const highPriority = analysis.optimizationSuggestions.filter(s => s.priority === 'high');
    const mediumPriority = analysis.optimizationSuggestions.filter(s => s.priority === 'medium');
    const lowPriority = analysis.optimizationSuggestions.filter(s => s.priority === 'low');

    if (highPriority.length > 0) {
      lines.push('\nHigh Priority:');
      for (const suggestion of highPriority) {
        lines.push(`- ${suggestion.title}`);
        lines.push(`  ${suggestion.description}`);
        if (suggestion.pointsSaved) {
          lines.push(`  Potential savings: ${suggestion.pointsSaved} points`);
        }
        if (suggestion.potentialGain) {
          lines.push(`  Potential gain: ${suggestion.potentialGain}`);
        }
      }
    }

    if (mediumPriority.length > 0) {
      lines.push('\nMedium Priority:');
      for (const suggestion of mediumPriority) {
        lines.push(`- ${suggestion.title}`);
        lines.push(`  ${suggestion.description}`);
        if (suggestion.pointsSaved) {
          lines.push(`  Potential savings: ${suggestion.pointsSaved} points`);
        }
        if (suggestion.potentialGain) {
          lines.push(`  Potential gain: ${suggestion.potentialGain}`);
        }
      }
    }

    if (lowPriority.length > 0) {
      lines.push('\nAI Context for Advanced Suggestions:');
      for (const suggestion of lowPriority) {
        if (suggestion.type === 'ai-context') {
          lines.push(suggestion.description);
        }
      }
    }
  }

  return lines.join('\n');
}
