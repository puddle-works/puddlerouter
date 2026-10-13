/**
 * Checks across the repo's workflow files.
 *
 * Run with: make test
 */
import { assertEquals } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1";

interface Step {
  name: string;
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
