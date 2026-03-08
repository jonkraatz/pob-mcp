import { describe, test, expect } from 'bun:test';
import { TradeQueryBuilder } from '../../src/services/tradeQueryBuilder.js';

describe('TradeQueryBuilder.withWeightedStats', () => {
  test('produces a type:weight stat group with per-filter weights', () => {
    const query = new TradeQueryBuilder()
      .withWeightedStats([
        { id: 'explicit.stat_3299347043', weight: 100 },
        { id: 'explicit.stat_587431675',  weight: 50 },
      ], 20)
      .build();

    expect(query.query.stats).toBeDefined();
    expect(query.query.stats!.length).toBe(1);
    const group = query.query.stats![0];
    expect(group.type).toBe('weight');
    expect(group.value?.min).toBe(20);
    expect(group.filters).toHaveLength(2);
    expect(group.filters[0].id).toBe('explicit.stat_3299347043');
    expect(group.filters[0].value?.weight).toBe(100);
    expect(group.filters[1].value?.weight).toBe(50);
  });

  test('sets sort to statgroup.0 desc', () => {
    const query = new TradeQueryBuilder()
      .withWeightedStats([{ id: 'explicit.stat_1', weight: 80 }])
      .build();

    expect(query.sort).toEqual({ 'statgroup.0': 'desc' });
  });

  test('uses minScore=0 by default', () => {
    const query = new TradeQueryBuilder()
      .withWeightedStats([{ id: 'explicit.stat_1', weight: 80 }])
      .build();

    expect(query.query.stats![0].value?.min).toBe(0);
  });

  test('can be chained with withCategory and withRarity', () => {
    const query = new TradeQueryBuilder()
      .withCategory('armour.gloves')
      .withRarity('rare')
      .withWeightedStats([{ id: 'explicit.stat_1', weight: 90 }], 5)
      .build();

    expect(query.query.stats![0].type).toBe('weight');
    expect(query.query.filters?.type_filters?.filters?.rarity?.option).toBe('rare');
  });
});
