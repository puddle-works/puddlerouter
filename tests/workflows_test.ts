/**
 * Checks across the repo's workflow files.
 *
 * Run with: make test
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1";

interface Step {
  name: string;
  allowFailure?: boolean;
  guard?: string;
  dependsOn?: Array<{ step: string; condition: { type: string } }>;
  task: {
    type?: string;
    modelIdOrName?: string;
    methodName?: string;
    workflowIdOrName?: string;
    inputs?: unknown;
  };
}
interface Workflow {
  jobs: Array<{ steps: Step[] }>;
}

async function routeQuestion(file: string) {
  const path = new URL(`../workflows/${file}`, import.meta.url);
  const wf = parse(await Deno.readTextFile(path)) as Workflow;
  const step = wf.jobs.flatMap((j) => j.steps).find((s) => s.name === "route");
  if (!step) throw new Error(`${file} has no route step`);
  assertEquals(step.task.modelIdOrName, "jev");
  assertEquals(step.task.methodName, "choice");
  const { instructions, criteria } = step.task.inputs as {
    instructions: string;
    criteria: Record<string, string>;
  };
  return { instructions, criteria };
}

Deno.test("the router asks Jev the question the route eval scored", async () => {
  assertEquals(
    await routeQuestion("workflow-puddlerouter.yaml"),
    await routeQuestion("workflow-puddlerouter-route-eval.yaml"),
  );
});

async function stepOf(file: string, name: string): Promise<Step> {
  const path = new URL(`../workflows/${file}`, import.meta.url);
  const wf = parse(await Deno.readTextFile(path)) as Workflow;
  const step = wf.jobs.flatMap((j) => j.steps).find((s) => s.name === name);
  if (!step) throw new Error(`${file} has no ${name} step`);
  return step;
}

async function decisionQuestion(file: string) {
  const step = await stepOf(file, "decide");
  assertEquals(step.task.modelIdOrName, "jev");
  assertEquals(step.task.methodName, "noul");
  const { instructions, yes, no } = step.task.inputs as Record<string, string>;
  return { instructions, yes, no };
}

Deno.test("the router asks Jev the decision question the decision eval scored", async () => {
  assertEquals(
    await decisionQuestion("workflow-puddlerouter.yaml"),
    await decisionQuestion("workflow-puddlerouter-decision-eval.yaml"),
  );
});

Deno.test("the route step is skipped for an empty or withheld turn", async () => {
  const step = await stepOf("workflow-puddlerouter.yaml", "route");
  const guard = step.guard ?? "";
  assert(guard.includes("steps.load.outputs.empty"));
  assert(guard.includes("steps.load.outputs.withheld"));
});

Deno.test("the decide step only runs for a confident decision on a complete turn", async () => {
  const step = await stepOf("workflow-puddlerouter.yaml", "decide");
  assertEquals(step.allowFailure, true);
  const guard = step.guard ?? "";
  for (
    const part of [
      "steps.load.outputs.complete",
      'steps.route.outputs.choice == "decision"',
      "steps.route.outputs.confidence >= inputs.cutoff",
    ]
  ) assert(guard.includes(part), `guard lacks ${part}`);
});

Deno.test("reply runs after decide whatever happened and gets its answer", async () => {
  const step = await stepOf("workflow-puddlerouter.yaml", "reply");
  assert(
    step.dependsOn?.some((d) =>
      d.step === "decide" && d.condition.type === "always"
    ),
  );
  const inputs = step.task.inputs as Record<string, string>;
  assert(inputs.yes.includes("steps.decide.outputs.noul"));
  assert(inputs.complete.includes("steps.load.outputs.complete"));
  assert(inputs.answerCutoff.includes("inputs.answerCutoff"));
});

Deno.test("match, pick and execute only run for the deterministic route and its match", async () => {
  const wf = "workflow-puddlerouter.yaml";
  const guards: Record<string, string[]> = {
    match: [
      'steps.route.outputs.choice == "deterministic"',
      "steps.route.outputs.confidence >= inputs.cutoff",
    ],
    pick: ['steps.match.outputs.kind == "candidates"'],
    execute: ['steps.match.outputs.kind == "recipe"'],
  };
  for (const [name, parts] of Object.entries(guards)) {
    const step = await stepOf(wf, name);
    assertEquals(step.allowFailure, true, name);
    for (const part of parts) {
      assert((step.guard ?? "").includes(part), `${name} guard lacks ${part}`);
    }
  }
});

Deno.test("reply waits for pick and execute and gets their results", async () => {
  const step = await stepOf("workflow-puddlerouter.yaml", "reply");
  for (const name of ["match", "pick", "execute"]) {
    assert(
      name === "match" ||
        step.dependsOn?.some((d) =>
          d.step === name && d.condition.type === "always"
        ),
      name,
    );
  }
  const inputs = step.task.inputs as Record<string, string>;
  assert(inputs.resultText.includes("steps.execute.outputs.text"));
  assert(inputs.pickChoice.includes("steps.pick.outputs.choice"));
  assert(inputs.matchKind.includes("steps.match.outputs.kind"));
});

Deno.test("raise logs a Capture request, only in live mode for a turn nothing can answer, keyed by sourceRef", async () => {
  const step = await stepOf("workflow-puddlerouter.yaml", "raise");
  assertEquals(step.allowFailure, true);
  assertEquals(step.task.type, "workflow");
  assertEquals(step.task.workflowIdOrName, "@puddleworks/capture-log-request");
  const guard = step.guard ?? "";
  for (
    const part of [
      'inputs.mode == "live"',
      'steps.match.outputs.kind != "recipe"',
      'steps.pick.outputs.choice != "none"',
      "steps.pick.outputs.confidence >= inputs.cutoff",
    ]
  ) assert(guard.includes(part), `guard lacks ${part}`);
  const inputs = step.task.inputs as Record<string, string>;
  assert(inputs.title.includes("steps.match.outputs.requestTitle"));
  assert(inputs.description.includes("steps.match.outputs.requestDescription"));
  assert(inputs.sourceRef.includes("steps.match.outputs.requestKey"));
  const reply = await stepOf("workflow-puddlerouter.yaml", "reply");
  const url = (reply.task.inputs as Record<string, string>).requestUrl;
  for (
    const part of [
      "inputs.captureUrl",
      '"/requests/"',
      'steps.raise.outputs["create-request"].id',
    ]
  ) assert(url.includes(part), `requestUrl lacks ${part}`);
});

// capture-log-request calls this instance; Capture's requests live in this
// repo's swamp data, logged as Intake Bot so its earlier sourceRefs still match.
Deno.test("the capture instance keeps Capture here and logs as Intake Bot", async () => {
  const def = await readYaml(
    "models/@puddleworks/capture/requests/capture.yaml",
  ) as {
    type: string;
    name: string;
    globalArguments: Record<string, string>;
  };
  assertEquals(def.type, "@puddleworks/capture/requests");
  assertEquals(def.name, "capture");
  assertEquals(def.globalArguments.defaultAs, "intake-bot@example.com");
  assertEquals(def.globalArguments.appUrl, "http://127.0.0.1:3002");
  const viewer = await readYaml(
    "models/@puddleworks/capture/web/viewer.yaml",
  ) as { type: string; name: string };
  assertEquals(viewer.type, "@puddleworks/capture/web");
  assertEquals(viewer.name, "viewer");
  const wf = await readYaml("workflows/workflow-puddlerouter.yaml") as {
    inputs: { properties: Record<string, { default?: unknown }> };
  };
  assertEquals(
    wf.inputs.properties.captureUrl?.default,
    def.globalArguments.appUrl,
  );
  assertEquals(wf.inputs.properties.issueRepo, undefined);
  const manifest = await readYaml("manifest.yaml") as {
    dependencies: string[];
  };
  assert(manifest.dependencies.includes("@puddleworks/capture"));
  assert(!manifest.dependencies.includes("@puddleworks/capture-client"));
});

async function readYaml(path: string) {
  return parse(await Deno.readTextFile(new URL(`../${path}`, import.meta.url)));
}

// The @mesgme collective is on swamp's Free plan, which cannot publish
// privately; @puddleworks can. The hook calls the workflow by this name too.
Deno.test("the extension, model and workflow are all @puddleworks/puddlerouter", async () => {
  const name = "@puddleworks/puddlerouter";
  const manifest = await readYaml("manifest.yaml") as { name: string };
  const wf = await readYaml("workflows/workflow-puddlerouter.yaml") as {
    name: string;
  };
  const def = await readYaml(
    "models/@puddleworks/puddlerouter/puddlerouter.yaml",
  ) as { type: string };
  assertEquals(manifest.name, name);
  assertEquals(wf.name, name);
  assertEquals(def.type, name);
});

Deno.test("recall runs after load and every Jev step is skipped when it holds the answer", async () => {
  const wf = "workflow-puddlerouter.yaml";
  const recall = await stepOf(wf, "recall");
  assertEquals(recall.task.modelIdOrName, "puddlerouter");
  assertEquals(recall.task.methodName, "recall");
  assertEquals(recall.allowFailure, false);
  assert(recall.dependsOn?.some((d) => d.step === "load"));
  const flags: Record<string, string> = {
    route: "hasRoute",
    decide: "hasDecision",
    pick: "hasPick",
  };
  for (const [name, flag] of Object.entries(flags)) {
    const step = await stepOf(wf, name);
    assert(
      (step.guard ?? "").includes(`steps.recall.outputs.${flag}`),
      `${name} guard lacks recall.${flag}`,
    );
    assert(
      step.dependsOn?.some((d) => d.step === "recall"),
      `${name} lacks recall dep`,
    );
  }
  const reply = await stepOf(wf, "reply");
  const inputs = reply.task.inputs as Record<string, string>;
  assert(inputs.recalled.includes("steps.recall.outputs"));
  assert(reply.dependsOn?.some((d) => d.step === "recall"));
});

Deno.test("the route cache version is set", async () => {
  const src = await Deno.readTextFile(
    new URL("../extensions/models/puddlerouter.ts", import.meta.url),
  );
  assert(/export const ROUTE_CACHE_VERSION = "v\d+"/.test(src));
});

Deno.test("the recipes sync workflow runs the sync method on a daily schedule and is published", async () => {
  const file = "workflow-puddlerouter-recipes-sync.yaml";
  const sync = await stepOf(file, "sync");
  assertEquals(sync.task.modelIdOrName, "puddlerouter");
  assertEquals(sync.task.methodName, "sync");
  const wf = await readYaml(`workflows/${file}`) as {
    name: string;
    trigger: { schedule: string };
  };
  assertEquals(wf.name, "@puddleworks/puddlerouter-recipes-sync");
  assertEquals(wf.trigger.schedule, "0 6 * * *");
  const manifest = await readYaml("manifest.yaml") as { workflows: string[] };
  assert(manifest.workflows.includes(file));
});

Deno.test("the key check asks Jev a small question daily and raises one issue per outage", async () => {
  const file = "workflow-puddlerouter-key-check.yaml";
  const check = await stepOf(file, "check");
  assertEquals(check.task.modelIdOrName, "jev");
  // Not models: OpenCode Zen lists models in a shape @swamp/typesafe-ai
  // rejects, so that check never passed. choice is the call routing makes.
  assertEquals(check.task.methodName, "choice");
  assertEquals((check.task.inputs as Record<string, string>).name, "key-check");
  assertEquals(check.allowFailure, true);
  const raise = await stepOf(file, "raise");
  assertEquals(raise.task.modelIdOrName, "github");
  assertEquals(raise.task.methodName, "create_issue");
  assert(
    raise.dependsOn?.some((d) =>
      d.step === "check" && d.condition.type === "failed"
    ),
  );
  const inputs = raise.task.inputs as Record<string, string>;
  assert(inputs.repo.includes("inputs.repo"));
  // A successful check stores a new version of jev's choice-key-check data,
  // so the key changes after each recovery and stays the same during an
  // outage.
  assert(
    inputs.idempotencyKey.includes(
      'data.listVersions("jev", "choice-key-check")',
    ),
  );
  const wf = await readYaml(`workflows/${file}`) as {
    name: string;
    trigger: { schedule: string };
    inputs: { properties: { repo: { default: string } } };
  };
  assertEquals(wf.name, "@puddleworks/puddlerouter-key-check");
  assertEquals(wf.trigger.schedule, "0 8 * * *");
  assertEquals(wf.inputs.properties.repo.default, "puddle-works/puddlerouter");
  const manifest = await readYaml("manifest.yaml") as { workflows: string[] };
  assert(manifest.workflows.includes(file));
});

Deno.test("jev uses the paid jev-1.13 model, not the free tier", async () => {
  const jev = await readYaml("models/@swamp/typesafe-ai/jev.yaml") as {
    globalArguments: { model: string };
  };
  assertEquals(jev.globalArguments.model, "jev-1.13");
});

const MERGED = "steps.merged.outputs.matched";

Deno.test("merged runs after load, never for an empty or withheld turn, and never blocks", async () => {
  const wf = "workflow-puddlerouter.yaml";
  const step = await stepOf(wf, "merged");
  assertEquals(step.task.modelIdOrName, "puddlerouter");
  assertEquals(step.task.methodName, "merged");
  assertEquals(step.allowFailure, true);
  assert(step.dependsOn?.some((d) => d.step === "load"));
  const guard = step.guard ?? "";
  assert(guard.includes("steps.load.outputs.empty"));
  assert(guard.includes("steps.load.outputs.withheld"));
  const inputs = step.task.inputs as Record<string, string>;
  assert(inputs.text.includes("steps.load.outputs.text"));
});

Deno.test("a merged turn skips Jev and the recipe search", async () => {
  const wf = "workflow-puddlerouter.yaml";
  for (const name of ["route", "decide", "match"]) {
    const step = await stepOf(wf, name);
    assert((step.guard ?? "").includes(MERGED), `${name} guard lacks merged`);
    assert(
      step.dependsOn?.some((d) =>
        d.step === "merged" && d.condition.type === "always"
      ),
      `${name} lacks an always dep on merged`,
    );
  }
});

Deno.test("reply waits for merged and gets its result", async () => {
  const step = await stepOf("workflow-puddlerouter.yaml", "reply");
  assert(
    step.dependsOn?.some((d) =>
      d.step === "merged" && d.condition.type === "always"
    ),
  );
  const inputs = step.task.inputs as Record<string, string>;
  const fields: Record<string, string> = {
    mergedMatched: "matched",
    mergedOk: "ok",
    mergedText: "text",
    mergedSummary: "summary",
    mergedError: "error",
  };
  for (const [input, field] of Object.entries(fields)) {
    assert(
      inputs[input]?.includes(`steps.merged.outputs.${field}`),
      `reply ${input} lacks merged.${field}`,
    );
  }
});

Deno.test("the manifest ships the worktree_list extension and its dependencies", async () => {
  const manifest = await readYaml("manifest.yaml") as {
    models: string[];
    dependencies?: string[];
  };
  assert(manifest.models.includes("git_worktrees.ts"));
  for (const dep of ["@swamp/git", "@webframp/github"]) {
    assert(manifest.dependencies?.includes(dep), `dependencies lack ${dep}`);
  }
  const git = await readYaml("models/@swamp/git/git.yaml") as {
    type: string;
    name: string;
  };
  assertEquals([git.type, git.name], ["@swamp/git", "git"]);
});

Deno.test("every manifest dependency is pinned in upstream_extensions.json", async () => {
  const manifest = await readYaml("manifest.yaml") as {
    dependencies?: string[];
  };
  const path = new URL(
    "../extensions/models/upstream_extensions.json",
    import.meta.url,
  );
  const lock = JSON.parse(await Deno.readTextFile(path)) as Record<
    string,
    { version: string }
  >;
  for (const dep of manifest.dependencies ?? []) {
    assert(lock[dep]?.version, `upstream_extensions.json lacks ${dep}`);
  }
});

const CAPTURE = "steps.load.outputs.capture";

Deno.test("a capture: turn skips Jev and the merged check", async () => {
  const wf = "workflow-puddlerouter.yaml";
  for (const name of ["merged", "route", "decide"]) {
    const step = await stepOf(wf, name);
    assert((step.guard ?? "").includes(CAPTURE), `${name} guard lacks capture`);
  }
});

Deno.test("match runs for a capture: turn that is not empty or withheld, and is told so", async () => {
  const step = await stepOf("workflow-puddlerouter.yaml", "match");
  const guard = step.guard ?? "";
  for (
    const part of [
      CAPTURE,
      "steps.load.outputs.empty",
      "steps.load.outputs.withheld",
    ]
  ) assert(guard.includes(part), `match guard lacks ${part}`);
  const inputs = step.task.inputs as Record<string, string>;
  assert(inputs.capture?.includes(CAPTURE));
});

Deno.test("reply knows the turn had a capture: prefix", async () => {
  const step = await stepOf("workflow-puddlerouter.yaml", "reply");
  const inputs = step.task.inputs as Record<string, string>;
  assert(inputs.capture?.includes(CAPTURE));
});
