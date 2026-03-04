# Feature Additions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement 10 new MCP tools that extend pob-mcp-server with mastery optimization, build notes, leveling plans, boss readiness, jewel advice, gem progression, build summaries, config presets, cluster jewel build analysis, and auto-context on load.

**Architecture:** Each feature follows the established pattern: (1) add schema to `toolSchemas.ts`, (2) add handler function in `src/handlers/`, (3) add router case in `toolRouter.ts`, (4) add to `toolGate.ts` if high-impact. Features requiring new Lua data also add a `BuildOps.lua` function + `Handlers.lua` route + `PoBLuaApiClient` method.

**Tech Stack:** TypeScript, MCP SDK, LuaJIT via PoB headless, fast-xml-parser for XML builds.

---

## How the codebase is wired

Every new tool requires touches to **4 files minimum**:

| File | What to add |
|------|-------------|
| `src/server/toolSchemas.ts` | Schema object in the appropriate `getXxxToolSchemas()` function |
| `src/server/toolRouter.ts` | `case "tool_name":` block |
| `src/handlers/<category>Handlers.ts` | Handler function |
| `src/server/toolGate.ts` | Entry in `HIGH_IMPACT_TOOLS` (if high-impact) |

For tools that need new Lua data, also touch:
| File | What to add |
|------|-------------|
| `~/Projects/PathOfBuilding/src/API/BuildOps.lua` | `function M.new_thing(params)` |
| `~/Projects/PathOfBuilding/src/API/Handlers.lua` | `elseif action == "new_thing" then` route |
| `src/pobLuaBridge.ts` | `async newThing(params): Promise<any>` method |

Run `npm run build` after every task to catch TypeScript errors early.

---

## Task 1: Mastery Node Optimizer (`suggest_masteries`)

Iterates over all mastery nodes the build has allocated, enumerates their available effect choices, simulates each with `calcWith`, and ranks them by stat impact.

**Files:**
- Modify: `~/Projects/PathOfBuilding/src/API/BuildOps.lua`
- Modify: `~/Projects/PathOfBuilding/src/API/Handlers.lua`
- Modify: `src/pobLuaBridge.ts`
- Modify: `src/handlers/treeHandlers.ts`
- Modify: `src/server/toolSchemas.ts` → `getLuaToolSchemas()`
- Modify: `src/server/toolRouter.ts`
- Modify: `src/server/toolGate.ts`

### Step 1: Add `get_mastery_options` to BuildOps.lua

Add after the `search_nodes` function (around line 741):

```lua
-- Returns all allocated mastery nodes and the available effect options for each.
-- Output: { masteries: [ { nodeId, nodeName, allocatedEffect, availableEffects: [{effectId, stat}] } ] }
function M.get_mastery_options()
  if not build or not build.spec then
    return nil, "build/spec not initialized"
  end
  local spec = build.spec
  local result = {}
  for nodeId, _ in pairs(spec.allocNodes or {}) do
    local node = spec.nodes[nodeId]
    if node and node.isMastery and node.masteryEffects then
      local allocated = spec.masterySelections and spec.masterySelections[nodeId]
      local available = {}
      for effectId, effectData in pairs(node.masteryEffects) do
        local stat = effectData.sd and table.concat(effectData.sd, ", ") or tostring(effectId)
        table.insert(available, { effectId = effectId, stat = stat })
      end
      table.insert(result, {
        nodeId = nodeId,
        nodeName = node.name or "Mastery",
        allocatedEffect = allocated,
        availableEffects = available,
      })
    end
  end
  return { masteries = result }
end
```

### Step 2: Add route to Handlers.lua

Find the `elseif action == "search_nodes"` block and add after it:

```lua
elseif action == "get_mastery_options" then
  local result, err = BuildOps.get_mastery_options()
  if not result then
    response = { ok = false, error = err or "get_mastery_options failed" }
  else
    response = { ok = true, result = result }
  end
```

### Step 3: Add bridge method to `src/pobLuaBridge.ts`

Add after the `searchNodes` method:

```typescript
async getMasteryOptions(): Promise<any> {
  const res = await this.send({ action: "get_mastery_options" });
  if (!res.ok) throw new Error(res.error || "get_mastery_options failed");
  return res.result;
}
```

### Step 4: Add handler to `src/handlers/treeHandlers.ts`

Add at the bottom of the file:

```typescript
export async function handleSuggestMasteries(context: PassiveUpgradesContext) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  const data = await (luaClient as any).getMasteryOptions();
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

  let output = '=== Mastery Node Suggestions ===\n\n';

  for (const mastery of masteries) {
    output += `**${mastery.nodeName}** (node ${mastery.nodeId})\n`;
    if (mastery.allocatedEffect != null) {
      const current = mastery.availableEffects.find((e: any) => e.effectId === mastery.allocatedEffect);
      output += `  Current: ${current?.stat ?? mastery.allocatedEffect}\n`;
    } else {
      output += `  Current: (none selected)\n`;
    }

    // Simulate each effect
    const scored: { stat: string; dpsDelta: number; ehpDelta: number }[] = [];
    for (const effect of mastery.availableEffects) {
      try {
        const newMasteryEffects = { ...currentMasteryEffects, [mastery.nodeId]: effect.effectId };
        const out = await (luaClient as any).calcWith({ masteryEffects: newMasteryEffects });
        if (!out) continue;
        const outDPS = (out.CombinedDPS as number) || (out.TotalDPS as number) || (out.MinionTotalDPS as number) || baseDPS;
        const outEHP = (out.TotalEHP as number) || (out.Life as number) || baseEHP;
        scored.push({ stat: effect.stat, dpsDelta: outDPS - baseDPS, ehpDelta: outEHP - baseEHP });
      } catch { /* skip */ }
    }

    scored.sort((a, b) => (b.dpsDelta + b.ehpDelta * 0.5) - (a.dpsDelta + a.ehpDelta * 0.5));
    for (const s of scored.slice(0, 3)) {
      const dpsStr = s.dpsDelta !== 0 ? ` | DPS Δ${s.dpsDelta > 0 ? '+' : ''}${Math.round(s.dpsDelta)}` : '';
      const ehpStr = s.ehpDelta !== 0 ? ` | EHP Δ${s.ehpDelta > 0 ? '+' : ''}${Math.round(s.ehpDelta)}` : '';
      output += `  - ${s.stat}${dpsStr}${ehpStr}\n`;
    }
    output += '\n';
  }

  return { content: [{ type: 'text' as const, text: output }] };
}
```

### Step 5: Add `calcWith` masteryEffects support to BuildOps.lua

In `M.calc_with`, the params currently only handle `addNodes`/`removeNodes`. We need to also support a `masteryEffects` override. Find the `calc_with` function (line ~185) and update it to temporarily apply mastery effects when provided:

```lua
-- Inside calc_with, before the calcWith call, add:
local origMastery = nil
if params.masteryEffects and type(params.masteryEffects) == 'table' then
  origMastery = {}
  for k, v in pairs(build.spec.masterySelections or {}) do
    origMastery[k] = v
  end
  -- Apply temporary mastery effects
  for nodeId, effectId in pairs(params.masteryEffects) do
    build.spec.masterySelections[tonumber(nodeId)] = effectId
  end
end

-- After the calcWith call (output captured), restore:
if origMastery then
  build.spec.masterySelections = origMastery
end
```

### Step 6: Add schema to `src/server/toolSchemas.ts`

In `getLuaToolSchemas()`, add before the closing `];`:

```typescript
{
  name: "suggest_masteries",
  description: "Analyze all allocated mastery nodes and suggest the best effect choices by simulating each option's DPS/EHP impact.",
  inputSchema: {
    type: "object",
    properties: {},
  },
},
```

### Step 7: Add router case to `src/server/toolRouter.ts`

Add import at top: `handleSuggestMasteries` from `treeHandlers.js`.

Add case in the `routeToolCall` switch:
```typescript
case "suggest_masteries":
  return await handleSuggestMasteries({
    getLuaClient: deps.getLuaClient,
    ensureLuaClient: deps.ensureLuaClient,
  });
```

### Step 8: Add to toolGate

In `src/server/toolGate.ts`, add `'suggest_masteries'` to `HIGH_IMPACT_TOOLS`.

### Step 9: Build and verify

```bash
cd /Users/ianderse/Projects/pob-mcp-server && npm run build
```
Expected: no TypeScript errors.

### Step 10: Commit

```bash
git add src/handlers/treeHandlers.ts src/server/toolSchemas.ts src/server/toolRouter.ts src/server/toolGate.ts src/pobLuaBridge.ts ~/Projects/PathOfBuilding/src/API/BuildOps.lua ~/Projects/PathOfBuilding/src/API/Handlers.lua
git commit -m "feat: add suggest_masteries tool with calcWith simulation"
```

---

## Task 2: Build Notes Read/Write (`get_build_notes` / `set_build_notes`)

Read and write the `<Notes>` element in a PoB build XML file. Requires a saved build file (or `lua_save_build` first).

**Files:**
- Modify: `src/handlers/buildHandlers.ts`
- Modify: `src/server/toolSchemas.ts` → `getToolSchemas()`
- Modify: `src/server/toolRouter.ts`

### Step 1: Add handlers to `src/handlers/buildHandlers.ts`

```typescript
export async function handleGetBuildNotes(context: HandlerContext, buildName: string) {
  const build = await context.buildService.readBuild(buildName);
  const notes = build.Notes ?? build.Build?.Notes ?? '';
  return {
    content: [{
      type: 'text' as const,
      text: notes
        ? `=== Notes: ${buildName} ===\n\n${notes}`
        : `No notes found in ${buildName}.`,
    }],
  };
}

export async function handleSetBuildNotes(context: HandlerContext, buildName: string, notes: string) {
  const fs = await import('fs/promises');
  const buildPath = path.join(context.pobDirectory, buildName);
  let xml = await fs.readFile(buildPath, 'utf-8');

  if (xml.includes('<Notes>')) {
    // Replace existing notes
    xml = xml.replace(/<Notes>[\s\S]*?<\/Notes>/, `<Notes>${notes}</Notes>`);
  } else if (xml.includes('<Notes/>')) {
    xml = xml.replace('<Notes/>', `<Notes>${notes}</Notes>`);
  } else {
    // Insert before </PathOfBuilding>
    xml = xml.replace('</PathOfBuilding>', `  <Notes>${notes}</Notes>\n</PathOfBuilding>`);
  }

  await fs.writeFile(buildPath, xml, 'utf-8');
  return {
    content: [{
      type: 'text' as const,
      text: `✅ Notes updated in ${buildName} (${notes.length} characters).`,
    }],
  };
}
```

### Step 2: Add schemas to `src/server/toolSchemas.ts`

In `getToolSchemas()`, add:

```typescript
{
  name: "get_build_notes",
  description: "Read the notes/documentation from a PoB build file",
  inputSchema: {
    type: "object",
    properties: {
      build_name: { type: "string", description: "Name of the build file (e.g., 'MyBuild.xml')" },
    },
    required: ["build_name"],
  },
},
{
  name: "set_build_notes",
  description: "Write notes/documentation into a PoB build file (overwrites existing notes)",
  inputSchema: {
    type: "object",
    properties: {
      build_name: { type: "string", description: "Name of the build file" },
      notes: { type: "string", description: "Notes content to write (plain text or markdown)" },
    },
    required: ["build_name", "notes"],
  },
},
```

### Step 3: Add router cases

```typescript
case "get_build_notes":
  if (!args?.build_name) throw new Error("Missing build_name");
  return await handleGetBuildNotes(deps.contextBuilder.buildHandlerContext(), args.build_name);

case "set_build_notes":
  if (!args?.build_name) throw new Error("Missing build_name");
  if (args?.notes == null) throw new Error("Missing notes");
  return await handleSetBuildNotes(deps.contextBuilder.buildHandlerContext(), args.build_name, args.notes as string);
```

### Step 4: Build and commit

```bash
npm run build
git add src/handlers/buildHandlers.ts src/server/toolSchemas.ts src/server/toolRouter.ts
git commit -m "feat: add get_build_notes and set_build_notes tools"
```

---

## Task 3: Leveling Progression Planner (`plan_leveling`)

Generates a structured act-by-act leveling guide using the build's class, main skill, and ascendancy. Pure TypeScript — no Lua interaction required (uses Lua only to read the loaded build's info if available).

**Files:**
- Create: `src/handlers/levelingHandlers.ts`
- Modify: `src/server/toolSchemas.ts` → `getLuaToolSchemas()`
- Modify: `src/server/toolRouter.ts`

### Step 1: Create `src/handlers/levelingHandlers.ts`

```typescript
import type { PoBLuaApiClient } from "../pobLuaBridge.js";

export interface LevelingContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

// Act-by-act milestone levels (PoE 1 campaign)
const ACT_MILESTONES = [
  { act: 1, level: 12, label: 'End of Act 1 (Merveil)' },
  { act: 2, level: 22, label: 'End of Act 2 (Vaal Oversoul)' },
  { act: 3, level: 32, label: 'End of Act 3 (Dominus)' },
  { act: 4, level: 40, label: 'End of Act 4 (Malachai)' },
  { act: 5, level: 46, label: 'End of Act 5 (Kitava)' },
  { act: 6, level: 52, label: 'End of Act 6 (Tsoagoth)' },
  { act: 7, level: 58, label: 'End of Act 7 (Arakaali)' },
  { act: 8, level: 64, label: 'End of Act 8 (Lunaris & Solaris)' },
  { act: 9, level: 68, label: 'End of Act 9 (The Depraved Trinity)' },
  { act: 10, level: 70, label: 'End of Act 10 / Maps (Kitava)' },
];

// Starting skills by class that work before the main gem is available
const CLASS_STARTER_SKILLS: Record<string, { early: string; links: string[] }> = {
  Marauder: { early: 'Infernal Blow or Heavy Strike', links: ['Maim Support', 'Onslaught Support'] },
  Ranger: { early: 'Splitting Steel or Burning Arrow', links: ['Pierce Support', 'Lesser Multiple Projectiles'] },
  Witch: { early: 'Freezing Pulse or Arc', links: ['Arcane Surge Support', 'Added Lightning Damage'] },
  Duelist: { early: 'Cleave or Splitting Steel', links: ['Maim Support', 'Onslaught Support'] },
  Templar: { early: 'Holy Flame Totem or Arc', links: ['Arcane Surge Support', 'Controlled Destruction'] },
  Shadow: { early: 'Viper Strike or Freezing Pulse', links: ['Added Chaos Damage', 'Onslaught Support'] },
  Scion: { early: 'Cleave or Arc', links: ['Onslaught Support', 'Added Lightning Damage'] },
};

// Ascendancy unlock levels
const ASCENDANCY_UNLOCK = { normal: 36, cruel: 55, merciless: 68 };

export async function handlePlanLeveling(context: LevelingContext, args: {
  build_name?: string;
  class_name?: string;
  main_skill?: string;
  ascendancy?: string;
}) {
  let className = args.class_name;
  let mainSkill = args.main_skill;
  let ascendancy = args.ascendancy;

  // Try to get info from loaded Lua build
  const luaClient = context.getLuaClient();
  if (luaClient) {
    try {
      const info = await luaClient.getBuildInfo();
      className = className || info.class;
      ascendancy = ascendancy || info.ascendancy;
      // Get main skill from skills setup
      const skills = await luaClient.getSkills();
      if (!mainSkill && skills?.groups?.length > 0) {
        const mainGroup = skills.groups.find((g: any) => g.index === skills.mainSocketGroup) || skills.groups[0];
        mainSkill = mainGroup?.gems?.[0]?.name || mainGroup?.skills?.[0] || 'your main skill';
      }
    } catch { /* use provided args */ }
  }

  className = className || 'Witch';
  mainSkill = mainSkill || 'your main skill';
  ascendancy = ascendancy || 'Unknown';

  const starter = CLASS_STARTER_SKILLS[className] || CLASS_STARTER_SKILLS['Witch'];

  let output = `# Leveling Guide: ${className} (${ascendancy})\n`;
  output += `**Main Skill:** ${mainSkill}\n\n`;

  output += `## Before Your Main Skill is Available\n`;
  output += `Use: **${starter.early}**\n`;
  output += `Support with: ${starter.links.join(', ')}\n\n`;

  output += `## Act Milestones\n\n`;

  for (const m of ACT_MILESTONES) {
    output += `### Act ${m.act} (Level ~${m.level}) — ${m.label}\n`;

    if (m.level <= 28) {
      output += `- Still leveling with starter skill; switch to ${mainSkill} when available (usually level 12–18)\n`;
    } else {
      output += `- Should be running ${mainSkill} in ${m.level >= 38 ? 'a 4-link' : '3-link'}\n`;
    }

    if (m.level >= ASCENDANCY_UNLOCK.normal && m.level < ASCENDANCY_UNLOCK.cruel) {
      output += `- ✅ **Do Labyrinth (Normal)** — unlock first 2 ascendancy points\n`;
    }
    if (m.level >= ASCENDANCY_UNLOCK.cruel && m.level < ASCENDANCY_UNLOCK.merciless) {
      output += `- ✅ **Do Labyrinth (Cruel)** — unlock next 2 ascendancy points\n`;
    }
    if (m.level >= ASCENDANCY_UNLOCK.merciless) {
      output += `- ✅ **Do Labyrinth (Merciless)** when ready — final 2 ascendancy points\n`;
    }

    output += `- Resist priority: cap Fire/Cold/Lightning at each difficulty transition\n`;
    output += '\n';
  }

  output += `## Gem Link Progression\n\n`;
  output += `| Milestone | Links | Setup |\n`;
  output += `|-----------|-------|-------|\n`;
  output += `| Level 1–12 | 2L | ${mainSkill} + Onslaught |\n`;
  output += `| Level 12–28 | 3L | ${mainSkill} + 2 key supports |\n`;
  output += `| Level 28–50 | 4L | ${mainSkill} + 3 supports |\n`;
  output += `| Level 50–70 | 5L | ${mainSkill} + 4 supports |\n`;
  output += `| Endgame | 6L | ${mainSkill} + 5 supports |\n\n`;

  output += `## Key Tips\n`;
  output += `- Grab **movement speed boots** in Act 2 — this is the most impactful early upgrade\n`;
  output += `- Use vendor recipe for leveling weapons: magic weapon + rustic sash + blacksmith's whetstone = weapon with % physical damage\n`;
  output += `- Prioritize resistances over damage on gear — you'll feel the difference at each difficulty\n`;
  output += `- Don't forget to allocate ascendancy passives after each Lab — they're huge power spikes\n`;
  output += `- Level your 6-link gems in a weapon swap to get XP while using weaker links\n\n`;

  output += `## Passive Tree Priority Order\n`;
  output += `1. Path to your class's key damage cluster\n`;
  output += `2. Life nodes along the way (Constitution, Heart and Soul, etc.)\n`;
  output += `3. Any easy resistance nodes near your path\n`;
  output += `4. Ascendancy path once you know your lab routing\n`;
  output += `5. Jewel sockets when you have good leveling jewels\n\n`;

  output += `_Use \`get_passive_upgrades\` with a loaded build for specific node recommendations._\n`;

  return { content: [{ type: 'text' as const, text: output }] };
}
```

### Step 2: Add schema to `src/server/toolSchemas.ts`

In `getLuaToolSchemas()`:

```typescript
{
  name: "plan_leveling",
  description: "Generate an act-by-act leveling progression guide for a build, including skill gem progression, lab timing, and passive tree priority order",
  inputSchema: {
    type: "object",
    properties: {
      build_name: { type: "string", description: "Build file to read class/skill from (optional if build loaded in Lua bridge)" },
      class_name: { type: "string", description: "Override class name (e.g. 'Witch', 'Ranger')" },
      main_skill: { type: "string", description: "Override main skill name" },
      ascendancy: { type: "string", description: "Override ascendancy name" },
    },
  },
},
```

### Step 3: Add router case and import

At the top of `toolRouter.ts`, add import:
```typescript
import { handlePlanLeveling } from "../handlers/levelingHandlers.js";
```

Add case:
```typescript
case "plan_leveling":
  return await handlePlanLeveling(
    { getLuaClient: deps.getLuaClient, ensureLuaClient: deps.ensureLuaClient },
    args || {}
  );
```

### Step 4: Build and commit

```bash
npm run build
git add src/handlers/levelingHandlers.ts src/server/toolSchemas.ts src/server/toolRouter.ts
git commit -m "feat: add plan_leveling tool with act-by-act progression guide"
```

---

## Task 4: Boss Readiness Check (`check_boss_readiness`)

Evaluates whether the loaded build meets the accepted community thresholds for a specific endgame boss. Uses Lua bridge stats.

**Files:**
- Create: `src/handlers/bossReadinessHandlers.ts`
- Modify: `src/server/toolSchemas.ts` → `getLuaToolSchemas()` (or `getBuildGoalsToolSchemas()`)
- Modify: `src/server/toolRouter.ts`
- Modify: `src/server/toolGate.ts`

### Step 1: Create `src/handlers/bossReadinessHandlers.ts`

```typescript
import type { PoBLuaApiClient } from "../pobLuaBridge.js";

export interface BossReadinessContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

interface BossThreshold {
  name: string;
  minLife: number;
  minDPS: number;
  minEHP: number;
  notes: string[];
  mechanics: string[];
}

// Community-accepted thresholds. DPS is approximate for "comfortable" clear.
const BOSS_THRESHOLDS: Record<string, BossThreshold> = {
  'shaper': {
    name: 'The Shaper',
    minLife: 5000, minDPS: 1_000_000, minEHP: 30_000,
    notes: ['75% elemental resists required', 'High cold damage — suppress/dodge helps'],
    mechanics: ['Stand in rotating beam kills instantly', 'Move out of Shaper Slam circle', 'Ice prison requires ES or flask'],
  },
  'elder': {
    name: 'The Elder',
    minLife: 5000, minDPS: 800_000, minEHP: 25_000,
    notes: ['75% elemental + 0%+ chaos recommended', 'DoT phases require recovery'],
    mechanics: ['Spiral of storms — keep moving', 'Tentacle Miscreations must be killed'],
  },
  'sirus': {
    name: 'Sirus, Awakener of Worlds',
    minLife: 5500, minDPS: 2_000_000, minEHP: 35_000,
    notes: ['Phase 4 meteors are one-shots without careful positioning', 'Chaos resistance strongly recommended'],
    mechanics: ['Die beams — walk between the lines', 'Maze phase — follow correct portals'],
  },
  'maven': {
    name: 'The Maven',
    minLife: 6000, minDPS: 3_000_000, minEHP: 40_000,
    notes: ['Memory game insta-kills on failure', 'Very high damage output in final phases'],
    mechanics: ['Memory game — memorise and repeat the pattern', 'Avoid brain phases', 'Maven orbs — stay mobile'],
  },
  'uber_elder': {
    name: 'Uber Elder',
    minLife: 6000, minDPS: 1_500_000, minEHP: 40_000,
    notes: ['Dual-boss encounter — constant movement required', 'Cold snap ground persists across the arena'],
    mechanics: ['Avoid Elder circle and Shaper beams simultaneously', 'High DPS window when Shaper kneels'],
  },
  'eater': {
    name: 'Eater of Worlds (Uber)',
    minLife: 6000, minDPS: 4_000_000, minEHP: 50_000,
    notes: ['Physical damage is primary — armour/PDR very valuable', 'Tentacles apply stacks'],
    mechanics: ['Remove tentacle stacks via movement', 'Avoid projectile waves'],
  },
  'exarch': {
    name: 'Searing Exarch (Uber)',
    minLife: 6000, minDPS: 4_000_000, minEHP: 50_000,
    notes: ['Fire/cold damage — suppression + res required', 'Phases get significantly harder'],
    mechanics: ['Avoid meteor impact zones', 'Kill adds quickly during add phase'],
  },
  'pinnacle': {
    name: 'Generic Pinnacle Boss',
    minLife: 6000, minDPS: 3_000_000, minEHP: 40_000,
    notes: ['General endgame readiness check'],
    mechanics: ['Capped resistances', 'Flask immunities essential'],
  },
};

const BOSS_ALIASES: Record<string, string> = {
  'uber shaper': 'shaper', 'uber maven': 'maven', 'awakener': 'sirus',
  'exarch': 'exarch', 'eater': 'eater', 'searing exarch': 'exarch',
  'eater of worlds': 'eater', 'endgame': 'pinnacle',
};

export async function handleCheckBossReadiness(context: BossReadinessContext, boss: string) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  const key = BOSS_ALIASES[boss.toLowerCase()] ?? boss.toLowerCase().replace(/\s+/g, '_');
  const threshold = BOSS_THRESHOLDS[key] ?? BOSS_THRESHOLDS['pinnacle'];

  const stats = await luaClient.getStats([
    'Life', 'TotalEHP', 'EnergyShield',
    'TotalDPS', 'CombinedDPS', 'MinionTotalDPS',
    'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
    'SpellSuppressionChance', 'EffectiveSpellSuppressionChance',
    'Armour', 'PhysicalDamageReduction', 'EvasionChance',
  ]);

  const life = Number(stats.Life ?? 0);
  const ehp = Number(stats.TotalEHP ?? life);
  const dps = Number(stats.CombinedDPS ?? stats.TotalDPS ?? stats.MinionTotalDPS ?? 0);
  const fireRes = Number(stats.FireResist ?? -60);
  const coldRes = Number(stats.ColdResist ?? -60);
  const lightRes = Number(stats.LightningResist ?? -60);
  const chaosRes = Number(stats.ChaosResist ?? -60);

  const checks: { label: string; value: string; pass: boolean; critical: boolean }[] = [];

  checks.push({
    label: 'Life', value: `${life.toLocaleString()}`,
    pass: life >= threshold.minLife, critical: life < threshold.minLife * 0.7,
  });
  checks.push({
    label: 'Effective HP', value: `${ehp.toLocaleString()}`,
    pass: ehp >= threshold.minEHP, critical: ehp < threshold.minEHP * 0.6,
  });
  checks.push({
    label: 'DPS', value: `${dps.toLocaleString()}`,
    pass: dps >= threshold.minDPS, critical: dps < threshold.minDPS * 0.3,
  });
  for (const [name, val] of [['Fire', fireRes], ['Cold', coldRes], ['Lightning', lightRes]] as [string, number][]) {
    checks.push({ label: `${name} Resist`, value: `${val}%`, pass: val >= 75, critical: val < 50 });
  }
  checks.push({
    label: 'Chaos Resist', value: `${chaosRes}%`,
    pass: chaosRes >= 0, critical: chaosRes < -30,
  });

  const passed = checks.filter(c => c.pass).length;
  const total = checks.length;
  const criticalFails = checks.filter(c => !c.pass && c.critical);
  const minorFails = checks.filter(c => !c.pass && !c.critical);
  const ready = passed === total;

  let output = `=== Boss Readiness: ${threshold.name} ===\n\n`;
  output += ready
    ? `✅ **READY** — all ${total} checks pass\n\n`
    : `❌ **NOT READY** — ${total - passed}/${total} checks failed\n\n`;

  output += '**Stat Checks:**\n';
  for (const c of checks) {
    const icon = c.pass ? '✅' : c.critical ? '🔴' : '🟡';
    const req = c.label === 'Life' ? ` (need ${threshold.minLife.toLocaleString()}+)`
      : c.label === 'Effective HP' ? ` (need ${threshold.minEHP.toLocaleString()}+)`
      : c.label === 'DPS' ? ` (need ~${threshold.minDPS.toLocaleString()}+)`
      : c.label.includes('Resist') && !c.label.includes('Chaos') ? ' (need 75%)'
      : c.label === 'Chaos Resist' ? ' (need 0%+)'
      : '';
    output += `  ${icon} ${c.label}: ${c.value}${req}\n`;
  }

  if (criticalFails.length > 0) {
    output += `\n**Critical Gaps (fix before attempting):**\n`;
    for (const f of criticalFails) output += `  🔴 ${f.label} is dangerously low\n`;
  }
  if (minorFails.length > 0) {
    output += `\n**Recommended Improvements:**\n`;
    for (const f of minorFails) output += `  🟡 ${f.label} below threshold\n`;
  }

  output += `\n**Boss-Specific Notes:**\n`;
  for (const note of threshold.notes) output += `  - ${note}\n`;
  output += `\n**Key Mechanics:**\n`;
  for (const m of threshold.mechanics) output += `  - ${m}\n`;

  return { content: [{ type: 'text' as const, text: output }] };
}
```

### Step 2: Add schema to `src/server/toolSchemas.ts` in `getBuildGoalsToolSchemas()`

```typescript
{
  name: "check_boss_readiness",
  description: "Check if the loaded build meets the recommended thresholds for a specific endgame boss (Shaper, Elder, Sirus, Maven, Uber Elder, Eater of Worlds, Searing Exarch)",
  inputSchema: {
    type: "object",
    properties: {
      boss: {
        type: "string",
        description: "Boss name: 'shaper', 'elder', 'sirus', 'maven', 'uber_elder', 'eater', 'exarch', or 'pinnacle' for generic endgame",
      },
    },
    required: ["boss"],
  },
},
```

### Step 3: Add import and router case

In `toolRouter.ts`:
```typescript
import { handleCheckBossReadiness } from "../handlers/bossReadinessHandlers.js";
```

```typescript
case "check_boss_readiness":
  if (!args?.boss) throw new Error("Missing boss name");
  return await handleCheckBossReadiness(
    { getLuaClient: deps.getLuaClient, ensureLuaClient: deps.ensureLuaClient },
    args.boss as string
  );
```

Add `'check_boss_readiness'` to `HIGH_IMPACT_TOOLS` in `toolGate.ts`.

### Step 4: Build and commit

```bash
npm run build
git add src/handlers/bossReadinessHandlers.ts src/server/toolSchemas.ts src/server/toolRouter.ts src/server/toolGate.ts
git commit -m "feat: add check_boss_readiness tool with per-boss stat thresholds"
```

---

## Task 5: Watcher's Eye / Rare Jewel Advisor (`suggest_watchers_eye`)

Reads the build's active auras from config, then suggests the most valuable Watcher's Eye mod combinations given those auras. Pure TypeScript knowledge base, no Lua calc required.

**Files:**
- Create: `src/handlers/jewelAdvisorHandlers.ts`
- Modify: `src/server/toolSchemas.ts` → `getLuaToolSchemas()` or `getBuildGoalsToolSchemas()`
- Modify: `src/server/toolRouter.ts`

### Step 1: Create `src/handlers/jewelAdvisorHandlers.ts`

```typescript
import type { PoBLuaApiClient } from "../pobLuaBridge.js";

export interface JewelAdvisorContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

// Watcher's Eye mods keyed by aura name → array of useful mods with tier (S/A/B)
const WATCHERS_EYE_MODS: Record<string, Array<{ mod: string; tier: 'S' | 'A' | 'B'; note: string }>> = {
  'Hatred': [
    { mod: 'Penetrate X% Cold Resistance while affected by Hatred', tier: 'S', note: 'Best-in-slot for cold damage builds' },
    { mod: 'Gain X% of Cold Damage as Extra Chaos while affected by Hatred', tier: 'A', note: 'Chaos conversion amplifier' },
    { mod: 'X% increased Cold Damage while affected by Hatred', tier: 'B', note: 'Flat damage increase' },
  ],
  'Anger': [
    { mod: 'Penetrate X% Fire Resistance while affected by Anger', tier: 'S', note: 'Best-in-slot for fire damage builds' },
    { mod: 'Gain X% of Fire Damage as Extra Chaos while affected by Anger', tier: 'A', note: 'Chaos conversion amplifier' },
  ],
  'Wrath': [
    { mod: 'Penetrate X% Lightning Resistance while affected by Wrath', tier: 'S', note: 'Best-in-slot for lightning builds' },
    { mod: 'Gain X% of Lightning Damage as Extra Chaos while affected by Wrath', tier: 'A', note: 'Chaos conversion amplifier' },
  ],
  'Precision': [
    { mod: 'X% increased Critical Strike Chance while affected by Precision', tier: 'S', note: 'Best crit scaling for attack builds' },
    { mod: 'X% of Physical Attack Damage Leeched as Life while affected by Precision', tier: 'A', note: 'Strong sustain for attack builds' },
    { mod: 'Gain X% of Physical Damage as Extra Lightning while affected by Precision', tier: 'B', note: 'Damage conversion' },
  ],
  'Grace': [
    { mod: 'X% chance to Dodge Attack Hits while affected by Grace', tier: 'S', note: 'Huge for evasion builds' },
    { mod: 'Unaffected by Bleeding while affected by Grace', tier: 'A', note: 'Replaces bleed flask' },
  ],
  'Determination': [
    { mod: 'X% of Armour applies to Chaos Damage taken while affected by Determination', tier: 'S', note: 'Incredible for armour-stacking builds' },
    { mod: 'Recover X% of Life when you Block while affected by Determination', tier: 'A', note: 'Good for block builds' },
  ],
  'Zealotry': [
    { mod: 'Consecrated Ground you create while affected by Zealotry grants X% increased Spell Damage', tier: 'S', note: 'Best for spell casters' },
    { mod: 'Spells have X% increased Critical Strike Chance while affected by Zealotry', tier: 'A', note: 'Strong crit scaling' },
  ],
  'Discipline': [
    { mod: 'Gain X Energy Shield when you Block while affected by Discipline', tier: 'S', note: 'Essential for ES block builds' },
    { mod: 'X% of Damage taken from Hits is Energy Shield before Life while affected by Discipline', tier: 'S', note: 'Massive defensive layer for ES builds' },
    { mod: 'Recover X% of Energy Shield when you use a Flask while affected by Discipline', tier: 'A', note: 'Flask synergy' },
  ],
  'Malevolence': [
    { mod: 'Regenerate X Life per second for each Debuff on Enemies while affected by Malevolence', tier: 'A', note: 'Sustain for DoT builds' },
    { mod: 'X% increased Damage over Time while affected by Malevolence', tier: 'A', note: 'Generic DoT scaling' },
  ],
  'Haste': [
    { mod: 'X% increased Attack Speed while affected by Haste', tier: 'A', note: 'Attack speed stacking' },
    { mod: 'X% increased Cast Speed while affected by Haste', tier: 'A', note: 'Cast speed scaling' },
  ],
};

function detectActiveAuras(skillGroups: any[]): string[] {
  const auras: string[] = [];
  const auraNames = Object.keys(WATCHERS_EYE_MODS);
  for (const group of skillGroups) {
    for (const gem of (group.gems || [])) {
      const name = gem.name || gem;
      if (auraNames.includes(name)) auras.push(name);
    }
  }
  return [...new Set(auras)];
}

export async function handleSuggestWatchersEye(context: JewelAdvisorContext) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  const skills = await luaClient.getSkills();
  const groups: any[] = skills?.groups ?? [];
  const activeAuras = detectActiveAuras(groups);

  let output = '=== Watcher\'s Eye Recommendations ===\n\n';

  if (activeAuras.length === 0) {
    output += 'No recognized auras detected in the skill setup.\n';
    output += 'Ensure auras (Hatred, Anger, Grace, Precision, Discipline, etc.) are in a socket group.\n';
    return { content: [{ type: 'text' as const, text: output }] };
  }

  output += `**Active Auras Detected:** ${activeAuras.join(', ')}\n\n`;
  output += `A Watcher's Eye can roll mods for any 2–3 of your active auras.\n`;
  output += `Look for combinations of S-tier mods from different auras.\n\n`;

  for (const aura of activeAuras) {
    const mods = WATCHERS_EYE_MODS[aura];
    if (!mods) continue;
    output += `### ${aura}\n`;
    for (const m of mods) {
      const tierIcon = m.tier === 'S' ? '⭐' : m.tier === 'A' ? '🔷' : '🔹';
      output += `  ${tierIcon} [${m.tier}] ${m.mod}\n`;
      output += `     _${m.note}_\n`;
    }
    output += '\n';
  }

  const sTierMods = activeAuras.flatMap(a => (WATCHERS_EYE_MODS[a] ?? []).filter(m => m.tier === 'S').map(m => `${a}: ${m.mod.slice(0, 50)}...`));
  if (sTierMods.length >= 2) {
    output += '**Best 2-mod combinations (S-tier):**\n';
    for (let i = 0; i < Math.min(sTierMods.length, 4); i++) {
      for (let j = i + 1; j < Math.min(sTierMods.length, 4); j++) {
        output += `  - ${sTierMods[i]} + ${sTierMods[j]}\n`;
      }
    }
  }

  output += '\n_Use `get_currency_rates` to estimate current market prices for these mods._\n';

  return { content: [{ type: 'text' as const, text: output }] };
}
```

### Step 2: Add schema in `getBuildGoalsToolSchemas()`

```typescript
{
  name: "suggest_watchers_eye",
  description: "Recommend valuable Watcher's Eye jewel mods based on the build's active auras",
  inputSchema: {
    type: "object",
    properties: {},
  },
},
```

### Step 3: Add router case

```typescript
import { handleSuggestWatchersEye } from "../handlers/jewelAdvisorHandlers.js";
// ...
case "suggest_watchers_eye":
  return await handleSuggestWatchersEye({
    getLuaClient: deps.getLuaClient,
    ensureLuaClient: deps.ensureLuaClient,
  });
```

### Step 4: Build and commit

```bash
npm run build
git add src/handlers/jewelAdvisorHandlers.ts src/server/toolSchemas.ts src/server/toolRouter.ts
git commit -m "feat: add suggest_watchers_eye tool with aura-based mod recommendations"
```

---

## Task 6: Cluster Jewel Build Analyzer (`analyze_build_cluster_jewels`)

Analyzes the cluster jewels currently equipped in the build (not searching for new ones) and evaluates which notables are providing value vs. which are wasted based on the build's archetype.

**Note:** `handleAnalyzeClusterJewels` in `clusterJewelHandlers.ts` is a *trade search tool* for buying cluster jewels. This is a different tool that analyzes what you already have equipped.

**Files:**
- Modify: `src/handlers/clusterJewelHandlers.ts`
- Modify: `src/server/toolSchemas.ts` → `getSkillGemToolSchemas()` (or new section)
- Modify: `src/server/toolRouter.ts`
- Modify: `src/server/toolGate.ts`

### Step 1: Add handler to `src/handlers/clusterJewelHandlers.ts`

Add at the bottom of the file (needs `getLuaClient`/`ensureLuaClient` context, not trade client):

```typescript
interface ClusterJewelBuildContext {
  getLuaClient: () => import('../pobLuaBridge.js').PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

// Well-known notable effects categorized by build type
const CLUSTER_NOTABLE_TAGS: Record<string, string[]> = {
  'Feasting Fiends': ['minion', 'leech'],
  'Renewal': ['minion', 'life_regen'],
  'Vicious Bite': ['minion', 'critical'],
  'Pure Agony': ['minion', 'ailment'],
  'Heraldry': ['herald', 'damage'],
  'Disciples': ['minion', 'aura'],
  'Dread March': ['minion', 'movement'],
  'Hulking Corpses': ['minion', 'tankiness'],
  'Grand Design': ['es', 'reservation'],
  'Flow of Life': ['life', 'leech'],
  'Fearless Assault': ['attack', 'stun'],
  'Martial Prowess': ['attack', 'accuracy'],
  'Fuel the Fight': ['attack', 'mana'],
  'Drive the Destruction': ['attack', 'damage'],
  'Force Multiplier': ['attack', 'critical'],
  'Disorienting Display': ['spell', 'utility'],
  'Vengeful Commander': ['aura', 'damage'],
  'Stalwart Commander': ['aura', 'life'],
  'Precise Commander': ['aura', 'critical'],
  'Wish for Death': ['chaos', 'damage'],
  'Touch of Cruelty': ['chaos', 'debuff'],
  'Unwaveringly Evil': ['chaos', 'damage'],
  'Cold to the Core': ['cold', 'penetration'],
  'Prismatic Heart': ['cold', 'damage'],
  'Widespread Destruction': ['area', 'damage'],
  'Smoking Remains': ['fire', 'damage'],
  'Burning Bright': ['fire', 'ignite'],
  'Snowforged': ['cold', 'freeze'],
  'Stormrider': ['lightning', 'shock'],
  'Supercharged': ['lightning', 'critical'],
};

function inferClusterArchetype(gemNames: string[]): string[] {
  const all = gemNames.map(n => n.toLowerCase()).join(' ');
  const tags: string[] = [];
  if (all.includes('summon') || all.includes('relic') || all.includes('skeleton') || all.includes('spectre')) tags.push('minion');
  if (all.includes('herald of')) tags.push('herald');
  if (all.includes('essence drain') || all.includes('bane') || all.includes('dark pact')) tags.push('chaos');
  if (all.includes('ignite') || all.includes('fireball') || all.includes('scorching')) tags.push('fire');
  if (all.includes('arc') || all.includes('storm brand') || all.includes('ball lightning')) tags.push('lightning');
  if (all.includes('frostbolt') || all.includes('ice nova') || all.includes('cold snap')) tags.push('cold');
  if (all.includes('penance') || all.includes('sacred') || all.includes('righteous')) tags.push('aura');
  return tags.length > 0 ? tags : ['generic'];
}

export async function handleAnalyzeBuildClusterJewels(context: ClusterJewelBuildContext) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  // Get equipped items to find cluster jewels
  const items = await luaClient.getItems();
  const clusterJewels = (items as any[]).filter((item: any) =>
    item.base && (item.base.includes('Cluster Jewel') || item.base.includes('Large Jewel') || item.base.includes('Medium Jewel') || item.base.includes('Small Jewel'))
    && item.slot && item.slot.toLowerCase().includes('jewel')
  );

  if (clusterJewels.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: '=== Cluster Jewel Analysis ===\n\nNo cluster jewels detected in equipped items.\nEnsure a build with cluster jewels is loaded.',
      }],
    };
  }

  // Detect build archetype from skills
  const skills = await luaClient.getSkills();
  const gemNames: string[] = [];
  for (const group of (skills?.groups ?? [])) {
    for (const gem of (group.gems ?? [])) gemNames.push(gem.name || gem);
  }
  const archetypeTags = inferClusterArchetype(gemNames);

  let output = `=== Cluster Jewel Analysis ===\n`;
  output += `**Build Archetype Tags:** ${archetypeTags.join(', ')}\n\n`;

  for (const jewel of clusterJewels) {
    const raw: string = jewel.raw || '';
    output += `### ${jewel.name || jewel.base} (${jewel.slot})\n`;
    output += `Base: ${jewel.base}\n`;

    // Parse notables from item text
    const notablePattern = /Added Small Passive Skills also grant: (.+)/g;
    const enchantPattern = /Adds (\d+) Passive Skills|Adds .+ Passive/;
    const notableMatches: string[] = [];

    // Extract notables mentioned in the item text
    const lines = raw.split('\n').map((l: string) => l.trim());
    for (const line of lines) {
      // Notables are typically lines with "Added Small Passive Skills also grant:" or just known notable names
      for (const notable of Object.keys(CLUSTER_NOTABLE_TAGS)) {
        if (line.includes(notable)) notableMatches.push(notable);
      }
    }

    if (notableMatches.length > 0) {
      output += `Notables: ${notableMatches.join(', ')}\n`;
      for (const notable of notableMatches) {
        const tags = CLUSTER_NOTABLE_TAGS[notable] ?? [];
        const relevant = tags.some(t => archetypeTags.includes(t));
        const icon = relevant ? '✅' : '⚠️';
        output += `  ${icon} ${notable} [${tags.join(', ')}]${relevant ? '' : ' — may not synergize with your archetype'}\n`;
      }
    } else {
      output += `  (Could not parse notables from item text — ensure item raw text includes notable names)\n`;
    }
    output += '\n';
  }

  output += `_To find better cluster jewels for your archetype, use \`search_cluster_jewels\` with the trade API._\n`;

  return { content: [{ type: 'text' as const, text: output }] };
}
```

### Step 2: Add schema to `src/server/toolSchemas.ts`

Add to `getBuildGoalsToolSchemas()`:

```typescript
{
  name: "analyze_build_cluster_jewels",
  description: "Analyze the cluster jewels currently equipped in the build, evaluate which notables synergize with the build archetype, and flag wasted notables",
  inputSchema: {
    type: "object",
    properties: {},
  },
},
```

### Step 3: Add router case and import

```typescript
import { handleSearchClusterJewels, handleAnalyzeClusterJewels, handleAnalyzeBuildClusterJewels } from "../handlers/clusterJewelHandlers.js";
// ...
case "analyze_build_cluster_jewels":
  return await handleAnalyzeBuildClusterJewels({
    getLuaClient: deps.getLuaClient,
    ensureLuaClient: deps.ensureLuaClient,
  });
```

Add `'analyze_build_cluster_jewels'` to `HIGH_IMPACT_TOOLS`.

### Step 4: Build and commit

```bash
npm run build
git add src/handlers/clusterJewelHandlers.ts src/server/toolSchemas.ts src/server/toolRouter.ts src/server/toolGate.ts
git commit -m "feat: add analyze_build_cluster_jewels tool for equipped jewel evaluation"
```

---

## Task 7: Gem Progression Path (`gem_upgrade_path`)

Uses `calcWith` (with gem level/quality overrides via config or temporary gem simulation) to produce a prioritized upgrade shopping list. Since PoB doesn't have a direct "simulate gem level" via `calcWith`, this tool uses heuristic scoring based on gem level effectiveness curves and the build's current DPS stats.

**Files:**
- Modify: `src/handlers/skillGemHandlers.ts`
- Modify: `src/server/toolSchemas.ts` → `getSkillGemToolSchemas()`
- Modify: `src/server/toolRouter.ts`

### Step 1: Add handler to `src/handlers/skillGemHandlers.ts`

```typescript
export async function handleGemUpgradePath(
  context: SkillGemHandlerContext,
  args: { build_name?: string; budget?: string }
) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  const skills = await luaClient.getSkills();
  const groups: any[] = skills?.groups ?? [];

  const budgetTier = (args.budget || 'endgame') as 'league_start' | 'mid_league' | 'endgame';
  const budgetMap = { league_start: 0, mid_league: 50, endgame: 999 };
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
          reason: 'Every gem level increases gem power — prioritise leveling gems in inactive weapon swap slots',
        });
      }

      // Quality upgrade
      if (quality < 20) {
        const gcp = Math.ceil((20 - quality) / 1);
        const costChaos = Math.round(gcp * 0.2);
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

      // 21/20 via Gemcutter's Incubator or vendor recipe
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

  let output = '=== Gem Upgrade Path ===\n';
  output += `Budget tier: ${budgetTier}\n\n`;

  if (upgrades.length === 0) {
    output += 'All gems appear to be fully upgraded!\n';
    return { content: [{ type: 'text' as const, text: output }] };
  }

  let rank = 1;
  for (const u of upgrades.slice(0, 15)) {
    output += `**${rank}. ${u.gemName}** (${u.groupLabel})\n`;
    output += `   Action: ${u.action}\n`;
    output += `   Cost: ${u.costEstimate}\n`;
    output += `   Why: ${u.reason}\n\n`;
    rank++;
  }

  output += '_Use `validate_gem_quality` for a full gem quality audit._\n';

  return { content: [{ type: 'text' as const, text: output }] };
}
```

Also add the `SkillGemHandlerContext` interface reference — check `skillGemHandlers.ts` for the existing context type to use.

### Step 2: Add schema to `src/server/toolSchemas.ts` in `getSkillGemToolSchemas()`

```typescript
{
  name: "gem_upgrade_path",
  description: "Generate a prioritized gem upgrade shopping list showing which gems to level, quality, and upgrade to awakened versions, ordered by impact and budget",
  inputSchema: {
    type: "object",
    properties: {
      build_name: { type: "string", description: "Build file (optional if loaded in Lua bridge)" },
      budget: { type: "string", description: "Budget tier: 'league_start', 'mid_league', 'endgame' (default: endgame)" },
    },
  },
},
```

### Step 3: Add router case

```typescript
case "gem_upgrade_path":
  return await handleGemUpgradePath(
    deps.contextBuilder.buildSkillGemContext(),
    args || {}
  );
```

### Step 4: Build and commit

```bash
npm run build
git add src/handlers/skillGemHandlers.ts src/server/toolSchemas.ts src/server/toolRouter.ts
git commit -m "feat: add gem_upgrade_path tool with prioritized upgrade shopping list"
```

---

## Task 8: Build Stats Export to Markdown (`export_build_summary`)

Generates a clean, paste-ready markdown summary of the loaded build. Pure formatting — reads from Lua stats, skill setup, tree, and equipped items.

**Files:**
- Modify: `src/handlers/exportHandlers.ts`
- Modify: `src/server/toolSchemas.ts` → `getExportToolSchemas()`
- Modify: `src/server/toolRouter.ts`

### Step 1: Add handler to `src/handlers/exportHandlers.ts`

```typescript
export async function handleExportBuildSummary(context: ExportContext) {
  const luaClient = context.luaClient;
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  const [info, stats, skills, tree] = await Promise.all([
    luaClient.getBuildInfo(),
    luaClient.getStats([
      'Life', 'EnergyShield', 'Mana', 'ManaUnreserved',
      'TotalDPS', 'CombinedDPS', 'MinionTotalDPS',
      'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
      'Armour', 'Evasion', 'PhysicalDamageReduction', 'TotalEHP',
      'LifeRegen', 'SpellSuppressionChance', 'BlockChance',
    ]),
    luaClient.getSkills(),
    luaClient.getTree(),
  ]);

  const classNames = ['Scion', 'Marauder', 'Ranger', 'Witch', 'Duelist', 'Templar', 'Shadow'];
  const className = classNames[tree.classId] || 'Unknown';
  const buildName = info?.name || 'Unnamed Build';
  const level = info?.level || '?';
  const ascendancy = info?.ascendancy || '';

  const dps = (stats.CombinedDPS || stats.TotalDPS || stats.MinionTotalDPS || 0) as number;
  const dpsLabel = stats.MinionTotalDPS && !stats.TotalDPS ? 'Minion DPS' : 'DPS';

  let output = `# ${buildName}\n\n`;
  output += `**Class:** ${className}${ascendancy ? ` (${ascendancy})` : ''}  \n`;
  output += `**Level:** ${level}\n\n`;

  output += `## Key Stats\n\n`;
  output += `| Stat | Value |\n|------|-------|\n`;
  output += `| Life | ${Number(stats.Life ?? 0).toLocaleString()} |\n`;
  if (Number(stats.EnergyShield ?? 0) > 100) {
    output += `| Energy Shield | ${Number(stats.EnergyShield).toLocaleString()} |\n`;
  }
  output += `| ${dpsLabel} | ${Math.round(dps).toLocaleString()} |\n`;
  output += `| Total EHP | ${Number(stats.TotalEHP ?? 0).toLocaleString()} |\n`;
  output += `| Fire/Cold/Light Resist | ${stats.FireResist}% / ${stats.ColdResist}% / ${stats.LightningResist}% |\n`;
  output += `| Chaos Resist | ${stats.ChaosResist}% |\n`;
  if (Number(stats.Armour ?? 0) > 0) output += `| Armour | ${Number(stats.Armour).toLocaleString()} |\n`;
  if (Number(stats.Evasion ?? 0) > 0) output += `| Evasion | ${Number(stats.Evasion).toLocaleString()} |\n`;
  if (Number(stats.BlockChance ?? 0) > 0) output += `| Block | ${stats.BlockChance}% |\n`;
  if (Number(stats.SpellSuppressionChance ?? 0) > 0) output += `| Spell Suppression | ${stats.SpellSuppressionChance}% |\n`;
  output += `\n`;

  // Main skill setup
  const mainGroup = skills?.groups?.find((g: any) => g.index === skills.mainSocketGroup) || skills?.groups?.[0];
  if (mainGroup) {
    const gemNames = (mainGroup.gems || []).map((g: any) => g.name || g).filter(Boolean);
    output += `## Main Skill\n\n`;
    output += `**${mainGroup.label || 'Main'}:** ${gemNames.join(' + ')}\n\n`;
  }

  // Keystone passives
  if (Array.isArray(tree.keystones) && tree.keystones.length > 0) {
    output += `## Keystones\n\n`;
    output += tree.keystones.map((k: string) => `- ${k}`).join('\n') + '\n\n';
  }

  output += `---\n_Generated with pob-mcp-server_\n`;

  return { content: [{ type: 'text' as const, text: output }] };
}
```

Note: `tree.keystones` may not be populated by the current `get_tree` Lua handler. If it's missing, skip that section. The `ExportContext` in `contextBuilder.ts` already has `luaClient`.

### Step 2: Add schema to `getExportToolSchemas()`

```typescript
{
  name: "export_build_summary",
  description: "Generate a clean markdown summary of the loaded build suitable for sharing on Reddit, Discord, or as build documentation",
  inputSchema: {
    type: "object",
    properties: {},
  },
},
```

### Step 3: Add router case

```typescript
case "export_build_summary":
  return await handleExportBuildSummary(deps.contextBuilder.buildExportContext());
```

Note: `buildExportContext()` captures `luaClient` at call time (known limitation from code review). This is fine here since the build must be loaded before calling this tool.

### Step 4: Build and commit

```bash
npm run build
git add src/handlers/exportHandlers.ts src/server/toolSchemas.ts src/server/toolRouter.ts
git commit -m "feat: add export_build_summary tool for markdown build export"
```

---

## Task 9: Config Preset Snapshots (`save_config_preset` / `load_config_preset`)

Save named configuration states (charges, conditions, enemy settings) to JSON files so users can quickly switch between "mapping" and "bossing" scenarios without re-entering every setting.

**Files:**
- Modify: `src/handlers/configHandlers.ts`
- Modify: `src/server/toolSchemas.ts` → `getConfigToolSchemas()`
- Modify: `src/server/toolRouter.ts`

### Step 1: Add handlers to `src/handlers/configHandlers.ts`

```typescript
import fs from 'fs/promises';
import path from 'path';

const PRESET_DIR_NAME = '.pob-mcp-presets';

async function getPresetPath(pobDirectory: string, name: string): Promise<string> {
  const dir = path.join(pobDirectory, PRESET_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, `${name}.json`);
}

export interface ConfigPresetContext {
  getLuaClient: () => import('../pobLuaBridge.js').PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
  pobDirectory: string;
}

export async function handleSaveConfigPreset(context: ConfigPresetContext, name: string) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active.');

  const config = await luaClient.getConfig();
  const filePath = await getPresetPath(context.pobDirectory, name);
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');

  return {
    content: [{
      type: 'text' as const,
      text: `✅ Config preset "${name}" saved with ${Object.keys(config).length} settings.\nPath: ${filePath}`,
    }],
  };
}

export async function handleLoadConfigPreset(context: ConfigPresetContext, name: string) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active.');

  const filePath = await getPresetPath(context.pobDirectory, name);
  let config: Record<string, any>;
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    throw new Error(`Preset "${name}" not found. Use save_config_preset to create it first.`);
  }

  await luaClient.setConfig(config);

  return {
    content: [{
      type: 'text' as const,
      text: `✅ Config preset "${name}" loaded (${Object.keys(config).length} settings applied).`,
    }],
  };
}

export async function handleListConfigPresets(context: ConfigPresetContext) {
  const dir = path.join(context.pobDirectory, PRESET_DIR_NAME);
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch { /* dir doesn't exist yet */ }
  const presets = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));

  return {
    content: [{
      type: 'text' as const,
      text: presets.length > 0
        ? `Available config presets:\n${presets.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
        : 'No config presets saved yet. Use save_config_preset to create one.',
    }],
  };
}
```

### Step 2: Add context type to `src/utils/contextBuilder.ts`

The `ConfigPresetContext` needs `pobDirectory`. Add a builder method:

```typescript
// In ContextBuilder class:
buildConfigPresetContext(): import('../handlers/configHandlers.js').ConfigPresetContext {
  return {
    getLuaClient: this.deps.getLuaClient,
    ensureLuaClient: this.deps.ensureLuaClient,
    pobDirectory: this.deps.pobDirectory,
  };
}
```

### Step 3: Add schemas to `getConfigToolSchemas()`

```typescript
{
  name: "save_config_preset",
  description: "Save the current configuration (charges, conditions, enemy settings) as a named preset for quick reuse",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Preset name (e.g. 'bossing', 'mapping', 'full-charges')" },
    },
    required: ["name"],
  },
},
{
  name: "load_config_preset",
  description: "Load a previously saved configuration preset, restoring all charge, condition, and enemy settings at once",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Preset name to load" },
    },
    required: ["name"],
  },
},
{
  name: "list_config_presets",
  description: "List all saved configuration presets",
  inputSchema: {
    type: "object",
    properties: {},
  },
},
```

### Step 4: Add router cases

```typescript
import { handleGetConfig, handleSetConfig, handleSetEnemyStats, handleSaveConfigPreset, handleLoadConfigPreset, handleListConfigPresets } from "../handlers/configHandlers.js";

// In switch:
case "save_config_preset":
  if (!args?.name) throw new Error("Missing preset name");
  return await handleSaveConfigPreset(deps.contextBuilder.buildConfigPresetContext(), args.name as string);

case "load_config_preset":
  if (!args?.name) throw new Error("Missing preset name");
  return await handleLoadConfigPreset(deps.contextBuilder.buildConfigPresetContext(), args.name as string);

case "list_config_presets":
  return await handleListConfigPresets(deps.contextBuilder.buildConfigPresetContext());
```

### Step 5: Build and commit

```bash
npm run build
git add src/handlers/configHandlers.ts src/server/toolSchemas.ts src/server/toolRouter.ts src/utils/contextBuilder.ts
git commit -m "feat: add save/load/list config preset tools for quick scenario switching"
```

---

## Task 10: Auto-context on Load (enhance `lua_load_build`)

After a successful `lua_load_build`, automatically fetch build info + top 3 issues + key stats and append them to the success message. No new tools — this enhances the existing handler.

**Files:**
- Modify: `src/handlers/luaHandlers.ts` — `handleLuaLoadBuild` function

### Step 1: Find handleLuaLoadBuild in `src/handlers/luaHandlers.ts`

The handler is around line 100–160. After the successful load (where `return { content: [...] }` is built), insert a stats fetch and issue check:

```typescript
// After successful load, build a quick summary to orient the user
let summary = '';
try {
  const [statsResult, issuesResult, infoResult] = await Promise.allSettled([
    luaClient.getStats(['Life', 'TotalDPS', 'CombinedDPS', 'MinionTotalDPS',
      'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist', 'TotalEHP']),
    handleGetBuildIssues({ getLuaClient: context.getLuaClient, ensureLuaClient: async () => {} }),
    luaClient.getBuildInfo(),
  ]);

  if (infoResult.status === 'fulfilled') {
    const info = infoResult.value;
    summary += `\n**${info.name || buildName}** | Level ${info.level} ${info.class}${info.ascendancy ? ` (${info.ascendancy})` : ''}\n`;
  }

  if (statsResult.status === 'fulfilled') {
    const s = statsResult.value;
    const dps = Number(s.CombinedDPS || s.TotalDPS || s.MinionTotalDPS || 0);
    const dpsLabel = (s.MinionTotalDPS && !s.TotalDPS) ? 'Minion DPS' : 'DPS';
    summary += `Life: ${Number(s.Life ?? 0).toLocaleString()} | ${dpsLabel}: ${Math.round(dps).toLocaleString()} | EHP: ${Number(s.TotalEHP ?? 0).toLocaleString()}\n`;
    summary += `Resists: F${s.FireResist}% C${s.ColdResist}% L${s.LightningResist}% Ch${s.ChaosResist}%\n`;
  }

  if (issuesResult.status === 'fulfilled') {
    const { issues } = issuesResult.value;
    const topIssues = issues.filter((i: any) => i.severity === 'error' || i.severity === 'warning').slice(0, 3);
    if (topIssues.length > 0) {
      summary += '\n**Top Issues:**\n';
      for (const issue of topIssues) {
        const icon = issue.severity === 'error' ? '🔴' : '🟡';
        summary += `  ${icon} ${issue.message}\n`;
      }
    } else {
      summary += '\n✅ No critical issues detected.\n';
    }
  }
} catch { /* auto-context is best-effort */ }
```

Add the import at the top of `luaHandlers.ts`:
```typescript
import { handleGetBuildIssues } from './buildGoalsHandlers.js';
```

### Step 2: Attach summary to the existing return value

Find the success return in `handleLuaLoadBuild` and append `summary` to the text:

```typescript
// Before return:
const loadText = text + (summary ? '\n---\n' + summary : '');
return {
  content: [{ type: 'text' as const, text: loadText }],
};
```

### Step 3: Build and commit

```bash
npm run build
git add src/handlers/luaHandlers.ts
git commit -m "feat: auto-display build summary (stats + top issues) on lua_load_build"
```

---

## Final Validation

After all tasks, run a build and verify tool registration:

```bash
cd /Users/ianderse/Projects/pob-mcp-server
npm run build
```

Verify all 10 new tool names appear in the appropriate `getXxxToolSchemas()` functions:
- `suggest_masteries` — `getLuaToolSchemas()`
- `get_build_notes`, `set_build_notes` — `getToolSchemas()`
- `plan_leveling` — `getLuaToolSchemas()`
- `check_boss_readiness` — `getBuildGoalsToolSchemas()`
- `suggest_watchers_eye` — `getBuildGoalsToolSchemas()`
- `analyze_build_cluster_jewels` — `getBuildGoalsToolSchemas()`
- `gem_upgrade_path` — `getSkillGemToolSchemas()`
- `export_build_summary` — `getExportToolSchemas()`
- `save_config_preset`, `load_config_preset`, `list_config_presets` — `getConfigToolSchemas()`

The `lua_load_build` enhancement has no new tool registration — it modifies the existing handler only.

```bash
git add -A
git commit -m "chore: finalize feature additions plan implementation"
```
