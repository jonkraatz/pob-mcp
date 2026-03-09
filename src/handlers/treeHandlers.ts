import type { BuildService } from "../services/buildService.js";
import type { TreeService } from "../services/treeService.js";
import type { TreeAnalysisResult, TreeComparison, PassiveTreeNode, AllocationChange, PassiveTreeData } from "../types.js";
import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import { handleGetBuildIssues } from "./buildGoalsHandlers.js";

export interface TreeHandlerContext {
  buildService: BuildService;
  treeService: TreeService;
  getLuaClient?: () => PoBLuaApiClient | null;
}

export interface PassiveUpgradesContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

export async function handleCompareTrees(
  context: TreeHandlerContext,
  build1Name: string,
  build2Name: string
) {
  try {
    const build1 = await context.buildService.readBuild(build1Name);
    const build2 = await context.buildService.readBuild(build2Name);

    const analysis1 = await context.treeService.analyzePassiveTree(build1);
    const analysis2 = await context.treeService.analyzePassiveTree(build2);

    if (!analysis1 || !analysis2) {
      throw new Error('One or both builds lack passive tree data');
    }

    // Calculate differences
    const nodes1Ids = new Set(analysis1.allocatedNodes.map(n => String(n.skill)));
    const nodes2Ids = new Set(analysis2.allocatedNodes.map(n => String(n.skill)));

    const uniqueToBuild1 = analysis1.allocatedNodes.filter(n => !nodes2Ids.has(String(n.skill)));
    const uniqueToBuild2 = analysis2.allocatedNodes.filter(n => !nodes1Ids.has(String(n.skill)));
    const sharedNodes = analysis1.allocatedNodes.filter(n => nodes2Ids.has(String(n.skill)));

    const pointDifference = analysis1.totalPoints - analysis2.totalPoints;

    let archetypeDifference = '';
    if (analysis1.archetype !== analysis2.archetype) {
      archetypeDifference = `Build 1: ${analysis1.archetype} vs Build 2: ${analysis2.archetype}`;
    } else {
      archetypeDifference = `Both builds: ${analysis1.archetype}`;
    }

    const comparison: TreeComparison = {
      build1: { name: build1Name, analysis: analysis1 },
      build2: { name: build2Name, analysis: analysis2 },
      differences: {
        uniqueToBuild1,
        uniqueToBuild2,
        sharedNodes,
        pointDifference,
        archetypeDifference
      }
    };

    const output = formatTreeComparison(comparison);

    return {
      content: [
        {
          type: "text" as const,
          text: output,
        },
      ],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to compare trees: ${errorMsg}`);
  }
}


export async function handleGetNearbyNodes(
  context: TreeHandlerContext,
  buildName: string | undefined,
  maxDistance?: number,
  filter?: string,
  includeEdges?: boolean
) {
  try {
    let allocatedNodeIds: string[] = [];
    let treeVersion = 'Unknown';

    // Try file-based path first
    if (buildName) {
      try {
        const build = await context.buildService.readBuild(buildName);
        allocatedNodeIds = context.buildService.parseAllocatedNodes(build);
        treeVersion = context.buildService.extractBuildVersion(build);
      } catch {
        // Fall through to Lua fallback
      }
    }

    // Lua bridge fallback when no file or file read failed
    if (allocatedNodeIds.length === 0 && context.getLuaClient) {
      const luaClient = context.getLuaClient();
      if (luaClient) {
        const treeResult = await luaClient.getTree();
        allocatedNodeIds = (treeResult.nodes || []).map(String);
        treeVersion = treeResult.treeVersion || 'Unknown';
      }
    }

    if (allocatedNodeIds.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No allocated nodes found. Provide a build_name or load a build with lua_load_build first.",
        }],
      };
    }

    const allocatedNodes = new Set<string>(allocatedNodeIds);
    const treeData = await context.treeService.getTreeData(treeVersion);

    const distance = maxDistance || 3;

    // Find nearby nodes using TreeService
    const nearbyNodes = context.treeService.findNearbyNodes(
      allocatedNodes,
      treeData,
      distance,
      filter
    );

    if (nearbyNodes.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No notable or keystone nodes found within ${distance} nodes of your current tree.\n\nTry increasing max_distance or removing the filter.`,
          },
        ],
      };
    }

    const textLines: string[] = [
      `=== Nearby Nodes (within ${distance} nodes) ===`,
      '',
      `Build: ${buildName}`,
      `Found ${nearbyNodes.length} nodes`,
      '',
    ];

    // Group by distance
    const byDistance = new Map<number, typeof nearbyNodes>();
    for (const node of nearbyNodes) {
      const existing = byDistance.get(node.distance) || [];
      existing.push(node);
      byDistance.set(node.distance, existing);
    }

    for (const [dist, nodes] of Array.from(byDistance.entries()).sort((a, b) => a[0] - b[0])) {
      textLines.push(`**Distance ${dist}** (${nodes.length} nodes):`);
      for (const { node, nodeId } of nodes.slice(0, 10)) {
        let line = `- ${node.name || 'Unnamed'} [${nodeId}]`;
        if (node.isKeystone) line += ' (KEYSTONE)';
        textLines.push(line);
        if (node.stats && node.stats.length > 0) {
          textLines.push(`  ${node.stats.slice(0, 2).join('; ')}`);
        }
        if (includeEdges) {
          if (node.in && node.in.length > 0) {
            textLines.push(`  predecessors: [${node.in.join(', ')}]`);
          }
          if (node.out && node.out.length > 0) {
            textLines.push(`  successors: [${node.out.join(', ')}]`);
          }
        }
      }
      if (nodes.length > 10) {
        textLines.push(`  ... and ${nodes.length - 10} more`);
      }
      textLines.push('');
    }

    return {
      content: [
        {
          type: "text" as const,
          text: textLines.join('\n'),
        },
      ],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${errorMsg}`,
        },
      ],
    };
  }
}

export async function handleFindPath(
  context: TreeHandlerContext,
  buildName: string | undefined,
  targetNodeId: string,
  showAlternatives?: boolean
) {
  try {
    let allocatedNodeIds: string[] = [];
    let treeVersion = 'Unknown';

    // Try file-based path first
    if (buildName) {
      try {
        const build = await context.buildService.readBuild(buildName);
        const spec = context.buildService.getActiveSpec(build);
        if (!spec) {
          throw new Error("Build has no passive tree data");
        }
        allocatedNodeIds = context.buildService.parseAllocatedNodes(build);
        treeVersion = context.buildService.extractBuildVersion(build);
      } catch (fileErr) {
        // Fall through to Lua fallback
        if (buildName) throw fileErr; // Re-throw if explicitly requested
      }
    }

    // Lua bridge fallback when no file or file read failed
    if (allocatedNodeIds.length === 0 && context.getLuaClient) {
      const luaClient = context.getLuaClient();
      if (luaClient) {
        const treeResult = await luaClient.getTree();
        allocatedNodeIds = (treeResult.nodes || []).map(String);
        treeVersion = treeResult.treeVersion || 'Unknown';
      }
    }

    if (allocatedNodeIds.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No allocated nodes found. Provide a build_name or load a build with lua_load_build first.",
        }],
      };
    }

    const allocatedNodes = new Set<string>(allocatedNodeIds);
    const treeData = await context.treeService.getTreeData(treeVersion);

    // Check if target node exists
    const targetNode = treeData.nodes.get(targetNodeId);
    if (!targetNode) {
      throw new Error(`Node ${targetNodeId} not found in tree data`);
    }

    // Check if target is already allocated
    if (allocatedNodes.has(targetNodeId)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Node ${targetNodeId} (${targetNode.name || "Unknown"}) is already allocated in this build.`,
          },
        ],
      };
    }

    // Find shortest path(s) using TreeService
    const paths = context.treeService.findShortestPaths(
      allocatedNodes,
      targetNodeId,
      treeData,
      showAlternatives ? 3 : 1
    );

    if (paths.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No path found to node ${targetNodeId} (${targetNode.name || "Unknown"}).\n\nThis node may be unreachable from your current tree (e.g., different class starting area or ascendancy nodes).`,
          },
        ],
      };
    }

    // Format output
    const textLines: string[] = [
      `=== Path to ${targetNode.name || "Node " + targetNodeId} ===`,
      '',
      `Build: ${buildName}`,
      `Target: ${targetNode.name || "Unknown"} [${targetNodeId}]`,
    ];
    if (targetNode.isKeystone) textLines.push('Type: KEYSTONE');
    else if (targetNode.isNotable) textLines.push('Type: Notable');
    textLines.push('');

    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const pathLabel = paths.length > 1 ? `Path ${i + 1} (Alternative ${i === 0 ? "- Shortest" : i})` : "Shortest Path";

      textLines.push(`**${pathLabel}**`);
      textLines.push(`Total Cost: ${path.cost} passive points`);
      textLines.push(`Nodes to Allocate: ${path.nodes.length}`, '');

      textLines.push('Allocation Order:');
      for (let j = 0; j < path.nodes.length; j++) {
        const nodeId = path.nodes[j];
        const node = treeData.nodes.get(nodeId);
        if (!node) continue;

        const isTarget = nodeId === targetNodeId;
        const prefix = isTarget ? "→ TARGET: " : `  ${j + 1}. `;

        textLines.push(`${prefix}${node.name || "Travel Node"} [${nodeId}]`);

        if (node.stats && node.stats.length > 0) {
          for (const stat of node.stats) {
            textLines.push(`      ${stat}`);
          }
        } else if (!isTarget) {
          textLines.push('      (Travel node - no stats)');
        }

        if (j < path.nodes.length - 1) textLines.push('');
      }

      if (i < paths.length - 1) textLines.push('', '='.repeat(50), '');
    }

    textLines.push('', '**Next Steps:**');
    textLines.push('Use lua_set_tree to allocate these nodes and recalculate stats.');

    return {
      content: [
        {
          type: "text" as const,
          text: textLines.join('\n'),
        },
      ],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${errorMsg}`,
        },
      ],
    };
  }
}


export async function handleGetPassiveUpgrades(
  context: PassiveUpgradesContext,
  focus: 'dps' | 'defence' | 'both' = 'both',
  maxResults: number = 10
) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_start and lua_load_build first.');

  // Step 1: get current base stats and issues to determine search keywords
  const { issues, stats: baseStats } = await handleGetBuildIssues(context);

  const baseDPS = (baseStats.CombinedDPS as number) || (baseStats.TotalDPS as number) || (baseStats.MinionTotalDPS as number) || 1;
  const baseEHP = (baseStats.TotalEHP as number) || (baseStats.Life as number) || 1;

  // Step 2: map focus + issues to search keywords
  const keywords: string[] = [];

  if (focus === 'dps' || focus === 'both') {
    keywords.push('damage', 'critical');
  }

  if (focus === 'defence' || focus === 'both') {
    keywords.push('life', 'energy shield');
    // If there are resistance issues, add resistance keywords
    const hasResistIssue = issues.some(i => i.category === 'resistance' && (i.severity === 'error' || i.severity === 'warning'));
    if (hasResistIssue) {
      keywords.push('resistance');
    }
  }

  // Step 3: search for notable candidates
  const seen = new Set<string>();
  const candidates: any[] = [];

  for (const keyword of keywords.slice(0, 4)) {
    try {
      const results = await luaClient.searchNodes({
        keyword,
        nodeType: 'notable',
        maxResults: 15,
        includeAllocated: false,
      });
      if (results && results.nodes) {
        for (const node of results.nodes) {
          const id = String(node.id);
          if (!seen.has(id)) {
            seen.add(id);
            candidates.push(node);
          }
        }
      }
    } catch { /* skip failed searches */ }
  }

  if (candidates.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: `=== Passive Upgrades (focus: ${focus}) ===\n\nNo unallocated notable candidates found. Make sure a build is loaded.\n`,
      }],
    };
  }

  // Step 4: simulate each candidate with calcWith
  interface ScoredNode {
    node: any;
    dpsDelta: number;
    ehpDelta: number;
    score: number;
  }

  const scored: ScoredNode[] = [];

  for (const node of candidates) {
    try {
      const out = await luaClient.calcWith({ addNodes: [node.id] });
      if (!out) continue;

      // calcWith returns raw Lua output; minion stats are nested under out.Minion
      // (unlike getStats() which remaps them to MinionTotalDPS etc.)
      const outDPS = (out.CombinedDPS as number) || (out.TotalDPS as number) ||
                     (out.Minion?.CombinedDPS as number) || (out.Minion?.TotalDPS as number) || baseDPS;
      const outEHP = (out.TotalEHP as number) || (out.Life as number) || baseEHP;

      const dpsDelta = outDPS - baseDPS;
      const ehpDelta = outEHP - baseEHP;

      // Relative score weighted by focus
      let score: number;
      if (focus === 'dps') {
        score = dpsDelta / baseDPS;
      } else if (focus === 'defence') {
        score = ehpDelta / baseEHP;
      } else {
        score = (dpsDelta / baseDPS) + (ehpDelta / baseEHP);
      }

      scored.push({ node, dpsDelta, ehpDelta, score });
    } catch { /* skip nodes that fail calcWith */ }
  }

  // Step 5: sort and return top N
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxResults);

  const textLines: string[] = [
    `=== Passive Upgrades (focus: ${focus}) ===`,
    '',
    `Base DPS: ${Math.round(baseDPS).toLocaleString()}  |  Base EHP: ${Math.round(baseEHP).toLocaleString()}`,
    `Evaluated ${candidates.length} candidate notables, showing top ${top.length}:`,
    '',
  ];

  for (let i = 0; i < top.length; i++) {
    const { node, dpsDelta, ehpDelta, score } = top[i];
    textLines.push(`${i + 1}. **${node.name}** [${node.id}]`);
    let scoreLine = `   Score: ${score.toFixed(4)}`;
    if (dpsDelta !== 0) scoreLine += `  |  DPS Δ: ${dpsDelta > 0 ? '+' : ''}${Math.round(dpsDelta).toLocaleString()}`;
    if (ehpDelta !== 0) scoreLine += `  |  EHP Δ: ${ehpDelta > 0 ? '+' : ''}${Math.round(ehpDelta).toLocaleString()}`;
    textLines.push(scoreLine);
    if (node.stats && node.stats.length > 0) {
      for (const stat of (node.stats as string[]).slice(0, 2)) {
        textLines.push(`   - ${stat}`);
      }
    }
    textLines.push('');
  }

  if (top.length === 0) {
    textLines.push('No results after simulation. Try a different focus or ensure a build is loaded.');
  } else {
    textLines.push('', '💡 Use lua_set_tree to allocate the top node and recalculate stats.');
  }

  return {
    content: [{ type: 'text' as const, text: textLines.join('\n') }],
  };
}

interface ScoredEffect {
  stat: string;
  dpsDelta: number;
  ehpDelta: number;
}

export async function handleSuggestMasteries(context: PassiveUpgradesContext) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  const data = await luaClient.getMasteryOptions();
  const masteries: any[] = data?.masteries ?? [];

  if (masteries.length === 0) {
    return {
      content: [{ type: 'text' as const, text: '=== Mastery Suggestions ===\n\nNo allocated mastery nodes found in the current build.\n' }],
    };
  }

  // Get base stats for scoring
  const baseStats = await luaClient.getStats(['TotalDPS', 'CombinedDPS', 'MinionTotalDPS', 'TotalEHP', 'Life']);
  const baseDPS = (baseStats.CombinedDPS as number) || (baseStats.TotalDPS as number) || (baseStats.MinionTotalDPS as number) || 1;
  const baseEHP = (baseStats.TotalEHP as number) || (baseStats.Life as number) || 1;

  // Current mastery effect map: { nodeId: effectId }
  const currentMasteryEffects: Record<number, number> = {};
  for (const m of masteries) {
    if (m.allocatedEffect != null) {
      currentMasteryEffects[m.nodeId] = m.allocatedEffect;
    }
  }

  const outputLines: string[] = ['=== Mastery Node Suggestions ===', ''];

  for (const mastery of masteries) {
    outputLines.push(`**${mastery.nodeName}** (node ${mastery.nodeId})`);
    if (mastery.allocatedEffect != null) {
      const current = mastery.availableEffects.find((e: any) => e.effectId === mastery.allocatedEffect);
      outputLines.push(`  Current: ${current?.stat ?? mastery.allocatedEffect}`);
    } else {
      outputLines.push('  Current: (none selected)');
    }

    // Simulate each effect choice
    const scored: ScoredEffect[] = [];
    for (const effect of mastery.availableEffects) {
      try {
        const newMasteryEffects = { ...currentMasteryEffects, [mastery.nodeId]: effect.effectId };
        const out = await luaClient.calcWith({ masteryEffects: newMasteryEffects });
        if (!out) continue;
        // calcWith returns raw Lua output; minion stats nested under out.Minion
        const outDPS = (out.CombinedDPS as number) || (out.TotalDPS as number) ||
                       (out.Minion?.CombinedDPS as number) || (out.Minion?.TotalDPS as number) || baseDPS;
        const outEHP = (out.TotalEHP as number) || (out.Life as number) || baseEHP;
        scored.push({ stat: effect.stat, dpsDelta: outDPS - baseDPS, ehpDelta: outEHP - baseEHP });
      } catch { /* skip effects that fail simulation */ }
    }

    // Sort by relative gain (same formula as handleGetPassiveUpgrades to avoid raw-value scale mismatch)
    scored.sort((a, b) =>
      ((b.dpsDelta / baseDPS) + (b.ehpDelta / baseEHP)) -
      ((a.dpsDelta / baseDPS) + (a.ehpDelta / baseEHP))
    );
    if (scored.length === 0) {
      outputLines.push('  (simulation unavailable for this mastery)');
    }
    for (const s of scored.slice(0, 3)) {
      const dpsStr = s.dpsDelta !== 0 ? ` | DPS Delta${s.dpsDelta > 0 ? '+' : ''}${Math.round(s.dpsDelta)}` : '';
      const ehpStr = s.ehpDelta !== 0 ? ` | EHP Delta${s.ehpDelta > 0 ? '+' : ''}${Math.round(s.ehpDelta)}` : '';
      outputLines.push(`  - ${s.stat}${dpsStr}${ehpStr}`);
    }
    outputLines.push('');
  }

  return { content: [{ type: 'text' as const, text: outputLines.join('\n') }] };
}

// ============================================================
// get_node_info — look up a single node by numeric ID
// ============================================================

export async function handleGetNodeInfo(
  context: TreeHandlerContext,
  nodeId: number
) {
  try {
    const nodeIdStr = String(nodeId);
    // Default to current tree version; fall back to 3_26 if treeService cache miss
    const treeData = await context.treeService.getTreeData();
    const node = treeData.nodes.get(nodeIdStr);

    if (!node) {
      return {
        content: [{
          type: "text" as const,
          text: `Node ${nodeId} not found in passive tree data (version: ${treeData.version}).`,
        }],
      };
    }

    const nodeType = node.isKeystone
      ? "KEYSTONE"
      : node.isNotable
      ? "NOTABLE"
      : node.isJewelSocket
      ? "JEWEL SOCKET"
      : node.isMastery
      ? "MASTERY"
      : node.isAscendancyStart
      ? "ASCENDANCY START"
      : "MINOR";

    const lines: string[] = [
      `=== Node Info: ${node.name || "Unnamed"} [${nodeId}] ===`,
      "",
      `Type:        ${nodeType}`,
    ];

    if (node.ascendancyName) {
      lines.push(`Ascendancy:  ${node.ascendancyName}`);
    }

    if (node.stats && node.stats.length > 0) {
      lines.push("", "Stats:");
      for (const stat of node.stats) {
        lines.push(`  - ${stat}`);
      }
    } else {
      lines.push("", "Stats:  (none — travel node)");
    }

    const connections = [...(node.out || []), ...(node.in || [])];
    const uniqueConnections = [...new Set(connections)];
    if (uniqueConnections.length > 0) {
      lines.push("", `Adjacent Node IDs (${uniqueConnections.length}):`);
      lines.push(`  ${uniqueConnections.join(", ")}`);
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
    };
  }
}

// ============================================================
// get_ascendancy_nodes — list all nodes for an ascendancy class
// ============================================================

export async function handleGetAscendancyNodes(
  context: TreeHandlerContext,
  className: string,
  nodeType: "notable" | "keystone" | "any" = "any"
) {
  try {
    const treeData = await context.treeService.getTreeData();
    const classNameLower = className.toLowerCase();

    const matches: Array<{ nodeId: string; node: typeof Array.prototype[0] }> = [];

    for (const [nodeId, node] of treeData.nodes) {
      if (!node.ascendancyName) continue;
      if (node.ascendancyName.toLowerCase() !== classNameLower) continue;
      if (node.isAscendancyStart) continue; // Skip start nodes — no stats

      if (nodeType === "notable" && !node.isNotable) continue;
      if (nodeType === "keystone" && !node.isKeystone) continue;

      matches.push({ nodeId, node });
    }

    if (matches.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: `No ascendancy nodes found for "${className}"${nodeType !== "any" ? ` (filter: ${nodeType})` : ""}.\n\nCheck the ascendancy class name spelling (e.g., "Inquisitor", "Elementalist", "Juggernaut").`,
        }],
      };
    }

    // Sort: keystones first, then notables, then minor
    matches.sort((a, b) => {
      const rank = (n: any) => (n.isKeystone ? 0 : n.isNotable ? 1 : 2);
      return rank(a.node) - rank(b.node);
    });

    const lines: string[] = [
      `=== Ascendancy Nodes: ${className} ===`,
      "",
      `Found ${matches.length} node${matches.length === 1 ? "" : "s"}${nodeType !== "any" ? ` (filter: ${nodeType})` : ""}:`,
      "",
    ];

    for (const { nodeId, node } of matches) {
      const typeTag = node.isKeystone
        ? " [KEYSTONE]"
        : node.isNotable
        ? " [NOTABLE]"
        : " [MINOR]";

      lines.push(`**${node.name || "Unnamed"}**${typeTag} — ID: ${nodeId}`);

      if (node.stats && node.stats.length > 0) {
        for (const stat of node.stats) {
          lines.push(`  - ${stat}`);
        }
      }
      lines.push("");
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
    };
  }
}

// ============================================================
// get_node_power — BFS scan + calcWith ranking by power/point
// ============================================================

export async function handleGetNodePower(
  context: PassiveUpgradesContext,
  focus: "dps" | "defence" | "both" = "both",
  radius: number = 4,
  nodeIds?: number[],
  limit: number = 20
) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) {
    throw new Error("Lua bridge not active. Use lua_start and lua_load_build first.");
  }

  // Step 1: get baseline stats
  const baseStats = await luaClient.getStats([
    "CombinedDPS", "TotalDPS", "MinionTotalDPS", "TotalEHP", "Life",
  ]);
  const baseDPS =
    (baseStats.CombinedDPS as number) ||
    (baseStats.TotalDPS as number) ||
    (baseStats.MinionTotalDPS as number) ||
    1;
  const baseEHP = (baseStats.TotalEHP as number) || (baseStats.Life as number) || 1;

  // Step 2: gather candidates
  interface Candidate {
    id: number;
    name: string;
    type: string;
    stats: string[];
    allocated: boolean;
  }

  const candidates: Candidate[] = [];
  const seen = new Set<number>();

  if (nodeIds && nodeIds.length > 0) {
    // User supplied specific IDs — test exactly those
    for (const id of nodeIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push({ id, name: String(id), type: "unknown", stats: [], allocated: false });
    }
  } else {
    // BFS scan via searchNodes across relevant stat categories
    const scanKeywords =
      focus === "dps"
        ? ["damage", "critical", "attack speed", "cast speed"]
        : focus === "defence"
        ? ["life", "energy shield", "resistance", "armour", "evasion"]
        : ["damage", "life", "critical", "energy shield", "armour"];

    for (const keyword of scanKeywords) {
      try {
        const results = await luaClient.searchNodes({
          keyword,
          nodeType: "any",
          maxResults: 30,
          includeAllocated: false,
        });
        if (results?.nodes) {
          for (const node of results.nodes) {
            const id = Number(node.id);
            if (seen.has(id)) continue;
            seen.add(id);
            candidates.push({
              id,
              name: node.name || String(id),
              type: node.type || "normal",
              stats: node.stats || [],
              allocated: !!node.allocated,
            });
          }
        }
      } catch {
        // skip failed keyword searches
      }
    }
  }

  if (candidates.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: `=== Node Power Ranking (focus: ${focus}) ===\n\nNo candidate nodes found. Make sure a build is loaded with lua_load_build.\n`,
      }],
    };
  }

  // Step 3: simulate each candidate with calcWith
  interface ScoredCandidate {
    candidate: Candidate;
    dpsDelta: number;
    ehpDelta: number;
    score: number;
    pathCost: number;
  }

  const scored: ScoredCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.allocated) continue; // skip already-allocated
    try {
      const out = await luaClient.calcWith({ addNodes: [candidate.id] });
      if (!out) continue;

      const outDPS =
        (out.CombinedDPS as number) ||
        (out.TotalDPS as number) ||
        (out.Minion?.CombinedDPS as number) ||
        (out.Minion?.TotalDPS as number) ||
        baseDPS;
      const outEHP = (out.TotalEHP as number) || (out.Life as number) || baseEHP;

      const dpsDelta = outDPS - baseDPS;
      const ehpDelta = outEHP - baseEHP;

      // Power-per-point score (radius is always 1 for the node itself;
      // path cost is assumed 1 since calcWith tests the node directly)
      const pathCost = 1;
      let rawScore: number;
      if (focus === "dps") {
        rawScore = dpsDelta / baseDPS;
      } else if (focus === "defence") {
        rawScore = ehpDelta / baseEHP;
      } else {
        rawScore = dpsDelta / baseDPS + ehpDelta / baseEHP;
      }
      const score = rawScore / pathCost;

      scored.push({ candidate, dpsDelta, ehpDelta, score, pathCost });
    } catch {
      // skip nodes that fail calcWith
    }
  }

  // Step 4: sort and cap
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  const lines: string[] = [
    `=== Node Power Ranking (focus: ${focus}, radius: ${radius}) ===`,
    "",
    `Base DPS: ${Math.round(baseDPS).toLocaleString()}  |  Base EHP: ${Math.round(baseEHP).toLocaleString()}`,
    `Evaluated ${scored.length} candidate nodes, showing top ${top.length}:`,
    "",
  ];

  for (let i = 0; i < top.length; i++) {
    const { candidate, dpsDelta, ehpDelta, score } = top[i];

    const typeTag =
      candidate.type === "keystone"
        ? " [KEYSTONE]"
        : candidate.type === "notable"
        ? " [NOTABLE]"
        : candidate.type === "jewel"
        ? " [JEWEL SOCKET]"
        : "";

    lines.push(`${i + 1}. **${candidate.name}**${typeTag} [ID: ${candidate.id}]`);

    let scoreLine = `   Score: ${score.toFixed(4)}`;
    if (dpsDelta !== 0) {
      scoreLine += `  |  DPS Δ: ${dpsDelta > 0 ? "+" : ""}${Math.round(dpsDelta).toLocaleString()}`;
    }
    if (ehpDelta !== 0) {
      scoreLine += `  |  EHP Δ: ${ehpDelta > 0 ? "+" : ""}${Math.round(ehpDelta).toLocaleString()}`;
    }
    lines.push(scoreLine);

    if (candidate.stats && candidate.stats.length > 0) {
      for (const stat of candidate.stats.slice(0, 2)) {
        lines.push(`   - ${stat}`);
      }
    }
    lines.push("");
  }

  if (top.length === 0) {
    lines.push("No results after simulation. Try a different focus or ensure a build is loaded.");
  } else {
    lines.push(
      "Use find_path_to_node to get the route to a specific node,",
      "then use get_node_info to inspect any ID in the path."
    );
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

// ============================================================
// analyze_node_efficiency — test removal impact of each allocated node
// ============================================================

export async function handleAnalyzeNodeEfficiency(
  context: PassiveUpgradesContext,
  includeMinorNodes: boolean = false,
  objective: 'dps' | 'ehp' | 'balanced' | 'auto' = 'auto',
  flagThresholdPct: number = -3.0
) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_start and lua_load_build first.');

  // Get baseline stats
  const baseStats = await luaClient.getStats(['CombinedDPS', 'TotalDPS', 'MinionTotalDPS', 'TotalEHP', 'Life']);
  const baseDPS = (baseStats.CombinedDPS as number) || (baseStats.TotalDPS as number) || (baseStats.MinionTotalDPS as number) || 1;
  const baseEHP = (baseStats.TotalEHP as number) || (baseStats.Life as number) || 1;

  // Determine weights based on objective
  let dpsWeight: number;
  let ehpWeight: number;
  let objectiveUsed: string;

  if (objective === 'auto') {
    if (baseDPS > baseEHP * 10) {
      dpsWeight = 0.7; ehpWeight = 0.3; objectiveUsed = 'dps-focused (auto)';
    } else {
      dpsWeight = 0.5; ehpWeight = 0.5; objectiveUsed = 'balanced (auto)';
    }
  } else if (objective === 'dps') {
    dpsWeight = 1.0; ehpWeight = 0.0; objectiveUsed = 'dps';
  } else if (objective === 'ehp') {
    dpsWeight = 0.0; ehpWeight = 1.0; objectiveUsed = 'ehp';
  } else {
    dpsWeight = 0.5; ehpWeight = 0.5; objectiveUsed = 'balanced';
  }

  // Get current tree
  const treeResult = await luaClient.getTree();
  const allocatedNodeIds: number[] = (treeResult.nodes || []).map(Number);

  if (allocatedNodeIds.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No allocated nodes found. Load a build first.' }],
    };
  }

  // We need tree data to filter notables — use searchNodes to find info about allocated nodes
  // Build a map from node id to type info via searchNodes
  const allocatedSet = new Set(allocatedNodeIds.map(String));

  // Score each node by removing it
  interface NodeScore {
    nodeId: number;
    name: string;
    dpsDeltaPct: number;
    ehpDeltaPct: number;
    score: number;
    isNotable: boolean;
  }

  const results: NodeScore[] = [];
  let totalTested = 0;

  for (const nodeId of allocatedNodeIds) {
    try {
      const out = await luaClient.calcWith({ removeNodes: [nodeId] });
      if (!out) continue;

      const outDPS = (out.CombinedDPS as number) || (out.TotalDPS as number) ||
                     (out.Minion?.CombinedDPS as number) || (out.Minion?.TotalDPS as number) || baseDPS;
      const outEHP = (out.TotalEHP as number) || (out.Life as number) || baseEHP;

      // Delta = how much we LOSE by removing (negative = losing stats)
      const dpsDeltaPct = ((outDPS - baseDPS) / baseDPS) * 100;
      const ehpDeltaPct = ((outEHP - baseEHP) / baseEHP) * 100;
      const score = dpsDeltaPct * dpsWeight + ehpDeltaPct * ehpWeight;

      // We can't easily determine isNotable without tree data, so we test all and filter by score
      // If includeMinorNodes=false, we rely on the fact that minor nodes have very small impact
      // We'll include all and note this in results
      results.push({
        nodeId,
        name: String(nodeId),
        dpsDeltaPct,
        ehpDeltaPct,
        score,
        isNotable: Math.abs(dpsDeltaPct) > 0.5 || Math.abs(ehpDeltaPct) > 0.5, // heuristic
      });
      totalTested++;
    } catch {
      // skip nodes that error
    }
  }

  // Filter out minor nodes if not requested
  const filtered = includeMinorNodes ? results : results.filter(r => r.isNotable);

  // Sort: most efficient (highest score = we lose the most by removing) first
  const sorted = [...filtered].sort((a, b) => a.score - b.score); // most negative first (worst to remove)
  sorted.reverse(); // flip: highest score first (best to keep)

  const efficient = sorted.filter(r => r.score <= flagThresholdPct * -1);
  const respecCandidates = sorted.filter(r => r.score > flagThresholdPct * -1 && r.score >= flagThresholdPct);
  const inefficient = sorted.filter(r => r.score < flagThresholdPct);

  const lines: string[] = [
    '=== Node Efficiency Analysis ===',
    '',
    `Objective: ${objectiveUsed}  |  Threshold: ${flagThresholdPct}%`,
    `Base DPS: ${Math.round(baseDPS).toLocaleString()}  |  Base EHP: ${Math.round(baseEHP).toLocaleString()}`,
    `Total nodes tested: ${totalTested}  |  After filter: ${filtered.length}`,
    '',
  ];

  if (efficient.length > 0) {
    lines.push(`=== Top Efficient Nodes (keep these) ===`);
    for (const n of efficient.slice(0, 10)) {
      lines.push(`- Node ${n.nodeId}  score: ${n.score.toFixed(2)}%  (DPS Δ: ${n.dpsDeltaPct.toFixed(1)}%, EHP Δ: ${n.ehpDeltaPct.toFixed(1)}%)`);
    }
    lines.push('');
  }

  if (inefficient.length > 0) {
    lines.push(`=== Low-Efficiency Nodes ===`);
    for (const n of inefficient.slice(0, 10)) {
      lines.push(`- Node ${n.nodeId}  score: ${n.score.toFixed(2)}%  (DPS Δ: ${n.dpsDeltaPct.toFixed(1)}%, EHP Δ: ${n.ehpDeltaPct.toFixed(1)}%)`);
    }
    lines.push('');
  }

  if (respecCandidates.length > 0) {
    lines.push(`=== Respec Candidates (removal costs < ${Math.abs(flagThresholdPct)}%) ===`);
    for (const n of respecCandidates) {
      lines.push(`- Node ${n.nodeId}  score: ${n.score.toFixed(2)}%  (DPS Δ: ${n.dpsDeltaPct.toFixed(1)}%, EHP Δ: ${n.ehpDeltaPct.toFixed(1)}%)`);
    }
    lines.push('');
  }

  lines.push('Use get_node_info to look up a node ID for its name and stats.');

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
  };
}

// ============================================================
// simulate_ascendancy_path — cumulative ascendancy lab simulation
// ============================================================

export async function handleSimulateAscendancyPath(
  context: PassiveUpgradesContext,
  paths: Array<{ label: string; nodes: number[] }>
) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_start and lua_load_build first.');

  if (!paths || paths.length === 0) {
    throw new Error('paths array is required and must have at least one entry.');
  }

  // Get baseline (no ascendancy nodes added)
  const baseStats = await luaClient.getStats(['CombinedDPS', 'TotalDPS', 'MinionTotalDPS', 'TotalEHP', 'Life']);
  const baseDPS = (baseStats.CombinedDPS as number) || (baseStats.TotalDPS as number) || (baseStats.MinionTotalDPS as number) || 0;
  const baseEHP = (baseStats.TotalEHP as number) || (baseStats.Life as number) || 0;
  const baseLife = (baseStats.Life as number) || 0;

  interface StepResult {
    label: string;
    cumulativeNodes: number[];
    dps: number;
    life: number;
    ehp: number;
    deltaFromBaselineDps: number;
    deltaFromBaselineLife: number;
    deltaFromBaselineEhp: number;
    deltaFromPrevDps: number;
    deltaFromPrevLife: number;
    deltaFromPrevEhp: number;
  }

  const results: StepResult[] = [];
  let cumulativeNodes: number[] = [];
  let prevDps = baseDPS;
  let prevLife = baseLife;
  let prevEhp = baseEHP;

  for (const step of paths) {
    cumulativeNodes = [...cumulativeNodes, ...step.nodes];

    try {
      const out = await luaClient.calcWith({ addNodes: cumulativeNodes });

      const stepDPS = (out.CombinedDPS as number) || (out.TotalDPS as number) ||
                      (out.Minion?.CombinedDPS as number) || (out.Minion?.TotalDPS as number) || baseDPS;
      const stepLife = (out.Life as number) || baseLife;
      const stepEHP = (out.TotalEHP as number) || baseEHP;

      results.push({
        label: step.label,
        cumulativeNodes: [...cumulativeNodes],
        dps: stepDPS,
        life: stepLife,
        ehp: stepEHP,
        deltaFromBaselineDps: stepDPS - baseDPS,
        deltaFromBaselineLife: stepLife - baseLife,
        deltaFromBaselineEhp: stepEHP - baseEHP,
        deltaFromPrevDps: stepDPS - prevDps,
        deltaFromPrevLife: stepLife - prevLife,
        deltaFromPrevEhp: stepEHP - prevEhp,
      });

      prevDps = stepDPS;
      prevLife = stepLife;
      prevEhp = stepEHP;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({
        label: step.label,
        cumulativeNodes: [...cumulativeNodes],
        dps: prevDps,
        life: prevLife,
        ehp: prevEhp,
        deltaFromBaselineDps: 0,
        deltaFromBaselineLife: 0,
        deltaFromBaselineEhp: 0,
        deltaFromPrevDps: 0,
        deltaFromPrevLife: 0,
        deltaFromPrevEhp: 0,
      });
    }
  }

  const lines: string[] = [
    '=== Ascendancy Path Simulation ===',
    '',
    `Baseline: DPS ${Math.round(baseDPS).toLocaleString()}  |  Life ${Math.round(baseLife).toLocaleString()}  |  EHP ${Math.round(baseEHP).toLocaleString()}`,
    '',
  ];

  for (const r of results) {
    const dpsPct = baseDPS > 0 ? ((r.deltaFromBaselineDps / baseDPS) * 100).toFixed(1) : '0.0';
    const ehpPct = baseEHP > 0 ? ((r.deltaFromBaselineEhp / baseEHP) * 100).toFixed(1) : '0.0';
    lines.push(`**${r.label}** (nodes: ${r.cumulativeNodes.join(', ')})`);
    lines.push(`  DPS: ${Math.round(r.dps).toLocaleString()} (${r.deltaFromBaselineDps >= 0 ? '+' : ''}${Math.round(r.deltaFromBaselineDps).toLocaleString()} vs baseline, ${dpsPct}%)`);
    lines.push(`  Life: ${Math.round(r.life).toLocaleString()} (${r.deltaFromBaselineLife >= 0 ? '+' : ''}${Math.round(r.deltaFromBaselineLife).toLocaleString()} vs baseline)`);
    lines.push(`  EHP: ${Math.round(r.ehp).toLocaleString()} (${r.deltaFromBaselineEhp >= 0 ? '+' : ''}${Math.round(r.deltaFromBaselineEhp).toLocaleString()} vs baseline, ${ehpPct}%)`);
    if (results.indexOf(r) > 0) {
      lines.push(`  Step gain: DPS ${r.deltaFromPrevDps >= 0 ? '+' : ''}${Math.round(r.deltaFromPrevDps).toLocaleString()}  Life ${r.deltaFromPrevLife >= 0 ? '+' : ''}${Math.round(r.deltaFromPrevLife).toLocaleString()}  EHP ${r.deltaFromPrevEhp >= 0 ? '+' : ''}${Math.round(r.deltaFromPrevEhp).toLocaleString()}`);
    }
    lines.push('');
  }

  lines.push('Tree was not modified — this is a non-destructive simulation.');

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
  };
}

// Helper function
function formatTreeComparison(comparison: TreeComparison): string {
  const lines: string[] = [
    '=== Passive Tree Comparison ===',
    '',
    `Build 1: ${comparison.build1.name}`,
    `Build 2: ${comparison.build2.name}`,
    '',
    '=== Point Allocation ===',
    `Build 1: ${comparison.build1.analysis.totalPoints} points`,
    `Build 2: ${comparison.build2.analysis.totalPoints} points`,
    `Difference: ${Math.abs(comparison.differences.pointDifference)} points ` +
      (comparison.differences.pointDifference > 0 ? '(Build 1 has more)' : '(Build 2 has more)'),
    '',
    '=== Archetype Comparison ===',
    comparison.differences.archetypeDifference,
    '',
    '=== Keystones Comparison ===',
    `Build 1 Keystones: ${comparison.build1.analysis.keystones.map(k => k.name).join(', ') || 'None'}`,
    `Build 2 Keystones: ${comparison.build2.analysis.keystones.map(k => k.name).join(', ') || 'None'}`,
  ];

  // Unique keystones
  const uniqueKeystones1 = comparison.differences.uniqueToBuild1.filter(n => n.isKeystone);
  const uniqueKeystones2 = comparison.differences.uniqueToBuild2.filter(n => n.isKeystone);

  if (uniqueKeystones1.length > 0) {
    lines.push('\nUnique to Build 1:');
    for (const ks of uniqueKeystones1) {
      lines.push(`- ${ks.name}`);
    }
  }

  if (uniqueKeystones2.length > 0) {
    lines.push('\nUnique to Build 2:');
    for (const ks of uniqueKeystones2) {
      lines.push(`- ${ks.name}`);
    }
  }

  // Notables comparison
  lines.push(
    '',
    '=== Notable Passives Comparison ===',
    `Build 1: ${comparison.build1.analysis.notables.length} notables`,
    `Build 2: ${comparison.build2.analysis.notables.length} notables`
  );

  const uniqueNotables1 = comparison.differences.uniqueToBuild1.filter(n => n.isNotable);
  const uniqueNotables2 = comparison.differences.uniqueToBuild2.filter(n => n.isNotable);

  if (uniqueNotables1.length > 0) {
    lines.push('\nTop 5 Unique Notables to Build 1:');
    for (const notable of uniqueNotables1.slice(0, 5)) {
      lines.push(`- ${notable.name || 'Unnamed'}`);
    }
  }

  if (uniqueNotables2.length > 0) {
    lines.push('\nTop 5 Unique Notables to Build 2:');
    for (const notable of uniqueNotables2.slice(0, 5)) {
      lines.push(`- ${notable.name || 'Unnamed'}`);
    }
  }

  // Pathing efficiency
  lines.push(
    '',
    '=== Pathing Efficiency ===',
    `Build 1: ${comparison.build1.analysis.pathingEfficiency}`,
    `Build 2: ${comparison.build2.analysis.pathingEfficiency}`,
    '',
    '=== Shared Nodes ===',
    `${comparison.differences.sharedNodes.length} nodes are allocated in both builds`
  );

  return lines.join('\n');
}
