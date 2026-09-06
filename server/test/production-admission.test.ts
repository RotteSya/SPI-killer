import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, validateTrialPolicy, type Config } from '../src/config.ts';
import { FIXED_TRIAL_POLICY } from '../src/billing.ts';

function production(): Config {
  return { ...config, requireDurableStorage: true, isServerless: true,
    quotaPolicyVersion: FIXED_TRIAL_POLICY.version, trialQuestions: 30, trialMinQuestions: 30, trialMaxQuestions: 30,
    provider: 'anthropic', objectiveProvider: 'deepseek', model: 'control', objectiveModel: 'treatment',
    modelDailyBudgetMicros: 1000, attemptBudgetUpperMicros: 100, modelCostCurrency: 'CNY', modelPricingVersion: 'test',
    cronSecret: 'test-only-recovery-secret-32-characters',
    modelPricingJSON: JSON.stringify(['anthropic:control', 'deepseek:treatment'].map(model =>
      ({ model, input_micros_per_million_tokens: 100, output_micros_per_million_tokens: 200 }))),
  };
}
test('production admission requires real priced slots, fixed30, a finite shared budget and independent recovery', () => {
  assert.doesNotThrow(() => validateTrialPolicy(production()));
  for (const changes of [
    { trialMaxQuestions: 180 }, { quotaPolicyVersion: 'legacy' },
    { provider: 'mock' }, { objectiveProvider: 'mock' },
    { attemptBudgetUpperMicros: 0 }, { attemptBudgetUpperMicros: 1001 },
    { modelDailyBudgetMicros: Number.MAX_VALUE }, { modelPricingJSON: '[]' },
    { modelPricingVersion: 'unset' }, { modelCostCurrency: 'unknown' }, { cronSecret: '' },
  ] as Partial<Config>[]) {
    assert.throws(() => validateTrialPolicy({ ...production(), ...changes }));
  }
});
