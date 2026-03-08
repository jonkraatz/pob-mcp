import { wrapHandler } from '../utils/errorHandling.js';
import { TradeApiClient } from '../services/tradeClient.js';
import { TradeQueryBuilder } from '../services/tradeQueryBuilder.js';
import type { PoBLuaApiClient } from '../pobLuaBridge.js';

interface SlotWeight {
  tradeId: string;
  label: string;
  weight: number;
  normalizedWeight: number;
}

// Maps PoB slot names to PoE Trade API item category strings
const SLOT_TO_CATEGORY: Record<string, string> = {
  'Weapon 1':    'weapon.sceptre',
  'Helmet':      'armour.helmet',
  'Body Armour': 'armour.chest',
  'Gloves':      'armour.gloves',
  'Boots':       'armour.boots',
  'Belt':        'accessory.belt',
  'Ring 1':      'accessory.ring',
  'Ring 2':      'accessory.ring',
  'Amulet':      'accessory.amulet',
  'Weapon 2':    'armour.shield',
};

/**
 * analyze_slot_weights
 * Asks PoB's calc engine which mods matter most for the given gear slot.
 * Returns a ranked table of mods by DPS + EHP impact on the loaded build.
 */
export async function handleAnalyzeSlotWeights(
  deps: { getLuaClient: () => PoBLuaApiClient | null },
  args: {
    slot: string;
    dps_weight?: number;
    ehp_weight?: number;
    max_results?: number;
  },
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('analyze slot weights', async () => {
    const lua = deps.getLuaClient();
    if (!lua) {
      throw new Error('Lua bridge not active — call lua_start + lua_load_build first.');
    }

    const { slot, dps_weight = 1.0, ehp_weight = 0.5, max_results = 20 } = args;

    const weights: SlotWeight[] = await lua.getSlotWeights({
      slot,
      dps_weight,
      ehp_weight,
      max_results,
    });

    if (weights.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No significant mods found for slot "${slot}". Check that the build is loaded and the slot name is correct (e.g. "Gloves", "Helmet", "Ring 1").`,
        }],
      };
    }

    const lines = [
      `## Slot Weight Analysis: ${slot}`,
      `_DPS weight: ${dps_weight} · EHP weight: ${ehp_weight} — ranked by impact on the loaded build_`,
      '',
      '| Rank | Weight | Mod | Trade Stat ID |',
      '|------|--------|-----|---------------|',
      ...weights.map((w, i) =>
        `| ${i + 1} | ${w.normalizedWeight} | ${w.label} | \`${w.tradeId}\` |`
      ),
      '',
      `_Use \`find_upgrade_items slot="${slot}" league="..."\` to search PoE trade with these weights._`,
    ];

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });
}

/**
 * find_upgrade_items
 * Internally runs slot weight analysis then queries PoE trade with a
 * "type":"weight" stat group sorted by weighted score.
 * Items at the top of results have the highest combined value of build-relevant
 * mods — not just the highest single stat.
 */
export async function handleFindUpgradeItems(
  deps: {
    getLuaClient: () => PoBLuaApiClient | null;
    tradeClient: TradeApiClient | null;
  },
  args: {
    slot: string;
    league: string;
    max_price_chaos?: number;
    dps_weight?: number;
    ehp_weight?: number;
    min_weight?: number;
  },
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('find upgrade items', async () => {
    const lua = deps.getLuaClient();
    if (!lua) {
      throw new Error('Lua bridge not active — call lua_start + lua_load_build first.');
    }
    if (!deps.tradeClient) {
      throw new Error('Trade client not configured.');
    }

    const {
      slot,
      league,
      max_price_chaos,
      dps_weight = 1.0,
      ehp_weight = 0.5,
      min_weight = 10,
    } = args;

    // Step 1: Get ranked mod weights from PoB's own calc engine
    const weights: SlotWeight[] = await lua.getSlotWeights({
      slot,
      dps_weight,
      ehp_weight,
      max_results: 29, // trade API weight group cap is 35; leave headroom
    });

    const filtered = weights.filter(w => w.normalizedWeight >= min_weight);
    if (filtered.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No mods above min_weight=${min_weight} found for "${slot}". Lower min_weight or check the build is loaded.`,
        }],
      };
    }

    // Step 2: Build weighted trade query
    const category = SLOT_TO_CATEGORY[slot];
    if (!category) {
      throw new Error(`Unknown slot "${slot}". Valid: ${Object.keys(SLOT_TO_CATEGORY).join(', ')}`);
    }

    const builder = new TradeQueryBuilder()
      .withCategory(category)
      .withRarity('rare')
      .withWeightedStats(
        filtered.map(w => ({ id: w.tradeId, weight: w.normalizedWeight })),
        0,
      );

    if (max_price_chaos !== undefined) {
      builder.withPriceRange(undefined, max_price_chaos, 'chaos');
    }

    // Step 3: Submit to PoE Trade API
    const searchResult = await deps.tradeClient.searchItems(league, builder.build());
    const tradeUrl = `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}/${searchResult.id}`;

    const topMods = filtered.slice(0, 8);
    const lines = [
      `## Upgrade Search: ${slot} (${league})`,
      '',
      `**${filtered.length} mods ranked by build impact:**`,
      ...topMods.map(w => `- **${w.normalizedWeight}** — ${w.label}`),
      filtered.length > 8 ? `- _(+ ${filtered.length - 8} more mods included in query)_` : '',
      '',
      '**Trade search URL (sorted by weighted score):**',
      tradeUrl,
      '',
      `Items at the top of this search have the highest combined value of`,
      `these mods for your specific build — not just raw individual stat values.`,
      '',
      `_Total results: ${searchResult.total.toLocaleString()}_`,
    ].filter(l => l !== undefined);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });
}
