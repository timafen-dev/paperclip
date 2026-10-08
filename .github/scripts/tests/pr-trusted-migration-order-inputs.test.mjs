import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(
  new URL('../../workflows/pr-trusted.yml', import.meta.url),
  'utf8',
);

const expectedExpressions = {
  base: 'github.event.pull_request.base.sha || github.event.merge_group.base_sha',
  head: 'github.event.pull_request.head.sha || github.event.merge_group.head_sha',
};

function migrationOrderInput(kind, event) {
  const expression = expectedExpressions[kind];
  const workflowInput = `MIGRATION_ORDER_${kind.toUpperCase()}_SHA: $` + `{{ ${expression} }}`;
  assert.ok(
    workflow.includes(workflowInput),
    `expected ${kind} SHA fallback expression in the migration-order step`,
  );

  return expression.split(' || ').map((path) => (
    path.split('.').slice(1).reduce((value, key) => value?.[key], { event })
  )).find(Boolean);
}

test('migration-order policy passes exact PR event SHAs', () => {
  const event = {
    pull_request: {
      base: { sha: 'a'.repeat(40) },
      head: { sha: 'b'.repeat(40) },
    },
  };

  assert.equal(migrationOrderInput('base', event), event.pull_request.base.sha);
  assert.equal(migrationOrderInput('head', event), event.pull_request.head.sha);
});

test('migration-order policy passes exact merge_group event SHAs', () => {
  const event = {
    merge_group: {
      base_sha: 'c'.repeat(40),
      head_sha: 'd'.repeat(40),
    },
  };

  assert.equal(migrationOrderInput('base', event), event.merge_group.base_sha);
  assert.equal(migrationOrderInput('head', event), event.merge_group.head_sha);
});

test('migration-order policy invokes the checker with the resolved SHA inputs', () => {
  assert.match(
    workflow,
    /node \.github\/scripts\/check-pr-migration-order\.mjs\s+"\$MIGRATION_ORDER_BASE_SHA"\s+"\$MIGRATION_ORDER_HEAD_SHA"/,
  );
});
