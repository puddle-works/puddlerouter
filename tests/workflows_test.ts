/**
 * Checks across the repo's workflow files.
 *
 * Run with: make test
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1.3.0";

interface Step {
  name: string;
  allowFailure?: boolean;
  guard?: string;
  dependsOn?: Array<{ step: string; condition: { type: string } }>;
  task: { modelIdOrName?: string; methodName?: string; inputs?: unknown };
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

Deno.test("raise only runs in live mode for a turn nothing can answer, keyed by sourceRef", async () => {
  const step = await stepOf("workflow-puddlerouter.yaml", "raise");
  assertEquals(step.allowFailure, true);
  assertEquals(step.task.modelIdOrName, "github");
  assertEquals(step.task.methodName, "create_issue");
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
  assert(inputs.idempotencyKey.includes("steps.match.outputs.issueKey"));
  const reply = await stepOf("workflow-puddlerouter.yaml", "reply");
  assert(
    (reply.task.inputs as Record<string, string>).issueUrl.includes(
      "steps.raise.outputs",
    ),
  );
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
