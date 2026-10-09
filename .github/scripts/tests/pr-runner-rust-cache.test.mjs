import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../../workflows/${name}`, import.meta.url), "utf8");

function value(source) {
  const comment = source.indexOf(" #");
  return (comment === -1 ? source : source.slice(0, comment)).trim();
}

function parseWorkflow(source) {
  const jobs = {};
  let job;
  let step;
  let block;
  for (const line of source.split("\n")) {
    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobMatch) {
      job = { steps: [] };
      jobs[jobMatch[1]] = job;
      step = undefined;
      block = undefined;
      continue;
    }
    if (!job) continue;
    const stepMatch = line.match(/^ {6}- ([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (stepMatch) {
      step = { with: {} };
      job.steps.push(step);
      if (stepMatch[2]) step[stepMatch[1]] = value(stepMatch[2]);
      block = undefined;
      continue;
    }
    if (!step) continue;
    const propertyMatch = line.match(/^ {8}([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (propertyMatch) {
      const [, key, raw = ""] = propertyMatch;
      if (key === "with") {
        block = { kind: "with" };
      } else if (raw === "|") {
        step[key] = "";
        block = { kind: "run", indent: 10 };
      } else {
        step[key] = value(raw);
        block = undefined;
      }
      continue;
    }
    const withMatch = line.match(/^ {10}([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (block?.kind === "with" && withMatch) {
      step.with[withMatch[1]] = value(withMatch[2] ?? "");
      continue;
    }
    if (block?.kind === "run" && line.startsWith(" ".repeat(block.indent))) {
      step.run += `${line.slice(block.indent)}\n`;
    }
  }
  return { jobs };
}

function job(workflow, name) {
  const result = workflow.jobs[name];
  assert.ok(result, `workflow is missing ${name}`);
  return result;
}

function step(jobDefinition, name) {
  const result = jobDefinition.steps.find((candidate) => candidate.name === name);
  assert.ok(result, `job is missing ${name}`);
  return result;
}

function cacheStep(jobDefinition, name) {
  const result = step(jobDefinition, name);
  assert.match(result.uses ?? "", /^Swatinem\/rust-cache@[0-9a-f]{40}$/);
  return result;
}

function indexOfStep(jobDefinition, candidate) {
  const index = jobDefinition.steps.indexOf(candidate);
  assert.notEqual(index, -1);
  return index;
}

function normalization(run) {
  const start = run.indexOf("rustup show\n");
  assert.notEqual(start, -1, "toolchain preparation must inspect Rust");
  return run.slice(start);
}

const prWorkflow = parseWorkflow(read("pr-trusted.yml"));
const releaseWorkflow = parseWorkflow(read("release-verify.yml"));
const readerNames = ["typecheck_release_registry", "verify_paperclip_runner", "build", "canary_dry_run"];
const readers = readerNames.map((name) => [name, job(prWorkflow, name)]);
const writer = job(releaseWorkflow, "verify_paperclip_runner");
const writerCache = cacheStep(writer, "Cache Runner Rust dependencies");
const writerPin = step(writer, "Pin the Runner Rust workspace path");
const writerToolchain = step(writer, "Select the pinned Runner Rust toolchain");

test("PR workflow has only the guarded Rust-cache readers", () => {
  const rustCacheJobs = Object.entries(prWorkflow.jobs)
    .filter(([, definition]) => definition.steps.some((candidate) => candidate.uses?.startsWith("Swatinem/rust-cache@")))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(rustCacheJobs, [...readerNames].sort());
});

test("PR readers restore the release writer cache contract", () => {
  const keyFields = ["workspaces", "shared-key", "cache-workspace-crates", "cache-bin"];
  for (const [name, definition] of readers) {
    const reader = cacheStep(definition, "Restore Runner Rust dependencies (read only)");
    assert.equal(reader.uses, writerCache.uses, `${name}: Rust cache action version`);
    for (const field of keyFields) {
      assert.equal(reader.with[field], writerCache.with[field], `${name}: ${field}`);
    }
    assert.equal(reader.with["save-if"], "false", `${name}: PR cache stays read-only`);
  }
});

test("PR readers prepare the release cache identity before restoring", () => {
  for (const [name, definition] of readers) {
    const pin = step(definition, "Pin the Runner Rust workspace path");
    const toolchain = step(definition, "Select the pinned Runner Rust toolchain");
    const reader = cacheStep(definition, "Restore Runner Rust dependencies (read only)");
    assert.equal(pin.id, "runner_rust_workspace", `${name}: workspace output id`);
    assert.equal(pin.run, writerPin.run, `${name}: pinned workspace semantics`);
    assert.equal(normalization(toolchain.run), normalization(writerToolchain.run), `${name}: toolchain normalization semantics`);
    assert.ok(indexOfStep(definition, pin) < indexOfStep(definition, toolchain), `${name}: pin before normalization`);
    assert.ok(indexOfStep(definition, toolchain) < indexOfStep(definition, reader), `${name}: normalization before restore`);
  }
});
