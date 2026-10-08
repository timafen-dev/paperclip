import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const trustedPath = path.join(repoRoot, ".github/workflows/pr-trusted.yml");
const callerPath = path.join(repoRoot, ".github/workflows/pr.yml");
const upstreamMasterCommit = "0ac194450a48a407450921a16c3ef8684dcb85ca";
const upstreamMasterBlob = "b87e5115b9cfbf616fd26784dd0a7430002d9ece";
const sha = character => character.repeat(40);

function gitBlobSha(text) {
  return createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
}

function upstreamEquivalent(patched) {
  return patched
    .replace(
      "  # Preserve the pull-request number lane while giving each merge queue head\n" +
      "  # its own non-empty lane (merge_group has no pull_request payload).\n" +
      "  group: ${{ github.event_name == 'merge_group' && format('merge-group-{0}', github.event.merge_group.head_sha) || format('pr-{0}', github.event.pull_request.number) }}",
      "  group: pr-${{ github.event.pull_request.number }}",
    )
    .replace(
      "    env:\n" +
      "      # merge_group does not populate pull_request; use the event's exact\n" +
      "      # queue base/head snapshots for every diff-based policy check.\n" +
      "      PR_BASE_SHA: ${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.event.pull_request.base.sha }}\n" +
      "      PR_HEAD_SHA: ${{ github.event_name == 'merge_group' && github.event.merge_group.head_sha || github.event.pull_request.head.sha }}\n",
      "",
    )
    .replace(
      "          github.event_name == 'merge_group' ||\n" +
      "          (github.head_ref != 'chore/refresh-lockfile' &&\n" +
      "          github.event.pull_request.user.login != 'dependabot[bot]')",
      "          github.head_ref != 'chore/refresh-lockfile' &&\n" +
      "          github.event.pull_request.user.login != 'dependabot[bot]'",
    )
    .replaceAll('"$PR_BASE_SHA...$PR_HEAD_SHA"', '"${{ github.event.pull_request.base.sha }}...${{ github.event.pull_request.head.sha }}"')
    .replace('          "$PR_BASE_SHA"\n          "$PR_HEAD_SHA"', '          "${{ github.event.pull_request.base.sha }}"\n          "${{ github.event.pull_request.head.sha }}"')
    .replace('PAPERCLIP_RELEASE_BOOTSTRAP_BASE_SHA="$PR_BASE_SHA"', 'PAPERCLIP_RELEASE_BOOTSTRAP_BASE_SHA="${{ github.event.pull_request.base.sha }}"');
}

function selectInputs(eventName, event) {
  if (eventName === "merge_group") return { base: event.merge_group.base_sha, head: event.merge_group.head_sha, group: `merge-group-${event.merge_group.head_sha}` };
  return { base: event.pull_request.base.sha, head: event.pull_request.head.sha, group: `pr-${event.pull_request.number}` };
}

test("patched reusable workflow restores exactly to the recorded upstream master blob", () => {
  const patched = readFileSync(trustedPath, "utf8");
  const restored = upstreamEquivalent(patched);
  assert.equal(gitBlobSha(restored), upstreamMasterBlob, `expected upstream master ${upstreamMasterCommit}`);
});

test("caller keeps pull requests on upstream master and routes only merge groups locally", () => {
  const caller = readFileSync(callerPath, "utf8");
  assert.match(caller, /pull_request:\n    if: github\.event_name == 'pull_request'[\s\S]*?uses: paperclipai\/paperclip\/\.github\/workflows\/pr-trusted\.yml@master/);
  assert.match(caller, /merge_group:\n    if: github\.event_name == 'merge_group'\n    uses: \.\/\.github\/workflows\/pr-trusted\.yml/);
});

test("both event shapes resolve valid exact diff inputs and non-colliding concurrency keys", () => {
  const pullRequest = selectInputs("pull_request", { pull_request: { number: 42, base: { sha: sha("a") }, head: { sha: sha("b") } } });
  const mergeGroup = selectInputs("merge_group", { merge_group: { base_sha: sha("c"), head_sha: sha("d") } });
  for (const inputs of [pullRequest, mergeGroup]) {
    assert.match(inputs.base, /^[a-f0-9]{40}$/);
    assert.match(inputs.head, /^[a-f0-9]{40}$/);
    assert.ok(inputs.group.length > 0);
  }
  assert.equal(pullRequest.group, "pr-42");
  assert.equal(mergeGroup.group, `merge-group-${sha("d")}`);
  assert.notEqual(pullRequest.group, mergeGroup.group);
});

test("workflow binds every guarded diff to the event-safe inputs", () => {
  const workflow = readFileSync(trustedPath, "utf8");
  assert.match(workflow, /PR_BASE_SHA: \$\{\{ github\.event_name == 'merge_group' && github\.event\.merge_group\.base_sha \|\| github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /PR_HEAD_SHA: \$\{\{ github\.event_name == 'merge_group' && github\.event\.merge_group\.head_sha \|\| github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /github\.event_name == 'merge_group' \|\|\n          \(github\.head_ref != 'chore\/refresh-lockfile'/);
  assert.equal((workflow.match(/\$PR_BASE_SHA\.\.\.\$PR_HEAD_SHA/g) ?? []).length, 2);
  assert.match(workflow, /PAPERCLIP_RELEASE_BOOTSTRAP_BASE_SHA="\$PR_BASE_SHA"/);
});
