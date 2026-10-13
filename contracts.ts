import type { Contracts } from "https://raw.githubusercontent.com/puddle-works/puddle-tooling/v0.1.1/contracts/check.ts";
import { model as puddlerouter } from "./extensions/models/puddlerouter.ts";

// Maps each model instance a workflow reads with data.latest(...) to its type
// and the data names it writes. The puddlerouter workflow reads its own steps'
// output with steps.*, not data.latest, so this only records the shape.
export const CONTRACTS: Contracts = {
  puddlerouter: {
    model: puddlerouter,
    data: { turn: "turn", reply: "reply" },
  },
};
