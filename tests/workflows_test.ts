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
