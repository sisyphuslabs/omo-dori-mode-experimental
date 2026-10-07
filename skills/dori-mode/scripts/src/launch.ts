import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { readScreen } from "./panes.ts";
import { LANE_KEY, type Lane, statusOf } from "./registry.ts";
import { iso } from "./run.ts";
import { doneSyntaxErrors } from "./signals.ts";

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  readonly cwd?: string;
};

export class LaunchError extends Error {}

const STARTUP_FAILURE = /Cannot find module|All fallback models failed|No API key|model_not_available|usage limit|rate limit|quota|Session crashed|unknown provider/i;

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if (!LANE_KEY.test(input.key)) throw new LaunchError(`key must match ${LANE_KEY}`);
  const existing = await deps.registry.read(input.key);
  if (existing && statusOf(existing) !== "closed") throw new LaunchError(`lane ${input.key} is already registered`);
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
  const agentCommand = deps.config.agentCommand;
  if (input.model && !agentCommand.some((arg) => arg.includes("{model}"))) {
    throw new LaunchError(`--model ${input.model} would be ignored: agentCommand ${JSON.stringify(agentCommand)} has no {model} placeholder; add "--model","{model}" to agentCommand in the config or drop --model`);
  }
};

const FOOTER_HEADING = "## Lane footer (written by dori launch)";

// a relaunch replaces the old footer, so the lane never has to guess which key is its own
export const withFooter = (brief: string, lane: Lane, leadPane: string): string => {
  const at = brief.indexOf(FOOTER_HEADING);
  return `${(at >= 0 ? brief.slice(0, at) : brief).replace(/\s*$/, "")}\n${footer(lane, leadPane)}`;
};

// a closed lane's record moves to lanes/archive/ so its key can be reused
const archiveClosed = async (deps: FlowDeps, key: string): Promise<void> => {
  const old = await deps.registry.read(key);
  if (old && statusOf(old) === "closed") await deps.registry.archive(old);
};

export const footer = (lane: Lane, leadPane: string): string => [
  "",
  FOOTER_HEADING,
  `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
  `- Done = ${lane.done}. The lane closes only when every signal reads back live.`,
  `- Report to the lead at each milestone: [REPORT] ${lane.key} | <milestone|blocker|question|done> | <what, with links>, sent to pane ${leadPane || "(lead pane)"} as an argv array, never a shell string.`,
  `- When done: dori claim-done ${lane.key} --evidence "<merge SHA, closed issue, version>". See references/done-protocol.md.`,
  "",
].join("\n");

export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  await validateLaunch(deps, input);
  await archiveClosed(deps, input.key);
  const lane: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", pane: input.pane, brief: input.brief, done: input.done, cwd: input.cwd ?? deps.config.defaultCwd, openedAt: iso(deps.clock) };
  await deps.registry.write(lane);
  return lane;
};

export const launchLane = async (deps: FlowDeps, input: LaunchInput): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  await validateLaunch(deps, input);
  const model = input.model ?? deps.config.defaultModel;
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  const draft: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", brief: input.brief, done: input.done, cwd, model, openedAt: iso(deps.clock) };
  await Bun.write(input.brief, withFooter(await briefFile.text(), draft, deps.config.leadPane));
  const created = await deps.run(["herdr", "tab", "create", ...(deps.config.laneWorkspace ? ["--workspace", deps.config.laneWorkspace] : []), "--cwd", cwd, "--label", input.key, "--no-focus"]);
  if (created.code !== 0) throw new LaunchError(`herdr tab create failed: ${created.err || created.out}`);
  const made = (JSON.parse(created.out) as { result: { root_pane: { pane_id: string; tab_id?: string }; tab_id?: string } }).result;
  const pane = made.root_pane.pane_id;
  const tab = made.tab_id ?? made.root_pane.tab_id;
  const prompt = `${deps.config.launchKeywords}. Read and execute the lane brief at ${input.brief} in full. You are the ${input.key} lane; report as the brief's footer says.`;
  await deps.run(["herdr", "pane", "run", pane, fill(deps.config.agentCommand, { model, prompt }).map(quoteForPane).join(" ")]);
  await archiveClosed(deps, input.key);
  const lane: Lane = { ...draft, pane, ...(tab ? { tab } : {}) };
  await deps.registry.write(lane);
  await deps.clock.sleep(20_000);
  const bad = STARTUP_FAILURE.exec(await readScreen(deps.run, pane, 40));
  return { lane, startup: bad ? `STARTUP_ERROR ${input.key} ${pane}: ${bad[0]}` : `STARTUP_OK ${input.key} ${pane}` };
};

export const quoteForPane = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
