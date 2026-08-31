import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface SignedArtifact {
  path: string;
  sha256: string;
}

interface ObjectiveAttestation {
  status: string;
  reviewer: string;
  artifacts: Record<string, SignedArtifact>;
  assertions: {
    fixed_baseline_comparison_included: boolean;
    automatic_relative_gate_accepted: boolean;
    production_rollout_authorized: boolean;
  };
}

const repoRoot = resolve(import.meta.dirname, '../..');
const attestationPath = resolve(repoRoot,
  'objective-eval-output/2026-08-31T13-25-50.386Z-r5-vs-legacy-attestation.json');

test('signed Objective attestation pins the immutable comparison and both summaries', async () => {
  const attestation = JSON.parse(await readFile(attestationPath, 'utf8')) as ObjectiveAttestation;
  assert.equal(attestation.status, 'signed');
  assert.equal(attestation.reviewer, 'RotteSya');
  assert.equal(attestation.assertions.fixed_baseline_comparison_included, true);
  assert.equal(attestation.assertions.automatic_relative_gate_accepted, true);
  assert.equal(attestation.assertions.production_rollout_authorized, false,
    'an evaluation signature must not silently authorize production mutation');

  assert.deepEqual(Object.keys(attestation.artifacts).sort(),
    ['baseline_summary', 'comparison', 'treatment_summary']);
  for (const artifact of Object.values(attestation.artifacts)) {
    assert.equal(artifact.path.startsWith('objective-eval-output/'), true);
    const bytes = await readFile(resolve(repoRoot, artifact.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256,
      `${artifact.path} changed after owner sign-off`);
  }

  const comparisonArtifact = attestation.artifacts.comparison;
  assert.ok(comparisonArtifact);
  const comparison = JSON.parse(await readFile(
    resolve(repoRoot, comparisonArtifact.path), 'utf8')) as { status?: string };
  assert.equal(comparison.status, 'pending_owner_review',
    'the generated comparison stays immutable; the separate attestation records sign-off');
});
