# Sessions (lanes)

A lane is one agent session doing one job in its own herdr tab. You launch it, track it in the registry, answer it when it is stuck, and close it when its work is proven done.

## Launching

```sh
dori launch fix-login --title "Fix the login redirect loop" \
  --brief ~/briefs/fix-login.md --done "merged acme/app#412; closed acme/app#398" \
  --thread "telegram:<chat>/<topic>" --model anthropic/claude-opus-5-5
```

`launch` checks the key and the `Done =` line, appends a footer to the brief, opens a tab in `laneWorkspace`, starts the agent, and after 20 seconds reads the pane for startup errors (missing module, no API key, rate limit, quota). On `STARTUP_ERROR`, `dori abandon <key> --reason ...`, then relaunch the same key on another model; the brief keeps a single footer.

Write the brief like a careful prompt:

- open with the keywords you would type yourself (for example `ulw set goal and work`);
- where the code is and what has been learned so far;
- the ideal end state, from the point of view of whoever uses the result;
- what not to touch;
- how and when to report.

**Why the `Done =` line has to be checkable:** the watcher closes lanes on its own, so it can only trust what it can read back itself. `launch` and `adopt` refuse any signal outside this list. Signals are joined with `;`, and every one has to pass.

| Signal | Passes when |
|---|---|
| `merged <owner/repo>#N` | the PR is merged and has a merge commit |
| `closed <owner/repo>#N` | the issue is closed |
| `published <pkg>@<version>` | npm has that exact version |
| `command ["argv","as","json"] [stdout~"regex"]` | the command exits 0 when the watcher runs it, and stdout matches if a regex is given |
| `file <path> [sha256=<hex>] [json:.a.b=<json value>]` | the file exists, its sha256 matches, and the JSON field equals the value |
| `url <http(s) url> [status=200] [body~"regex"]` | a GET returns that status, and the body matches if a regex is given |

The last three are for work that never lands as a PR: a local setup, a QA pass, a running service. Write the check so that it can fail. `command ["bun","test"] stdout~" 0 fail"` is a real check, while `command ["true"]` checks nothing. The watcher runs commands itself, in the lane's directory, as a plain argv with no shell. They have a 2-minute limit. It never trusts the lane's own report that something passed. Relative file paths resolve from the lane's directory, and `~` is your home. JSON values compare as JSON, so `json:.n=3` and `json:.n="3"` are different checks.

Example for a QA-only lane:

```
Done = command ["bun","test"] stdout~" 0 fail"; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

Work no script can check (a design review, a judgement call) stays in the lane's own plan. You judge it yourself before the claim.

## The registry

One JSON file per lane under `<stateDir>/lanes/`, written atomically (temp file + rename), so two writers never leave a half-written file. Each lane records:

| Field | Meaning |
|---|---|
| `thread` | where its updates go, as `platform:thread` (or `none`) |
| `pane`, `tab` | its herdr location |
| `session` | the agent's own session id, so a closed job can be reopened later |
| `status` | `working`, `done-claimed`, `verified-done`, `not-done`, `closed` |
| `claim`, `objection`, `history` | what was claimed, what was objected, every status change |

`dori sync` compares the registry with live panes and prints drift (a pane that is gone, a session id that changed, an empty `Done =` line). It never deletes anything. With `--write` it stores the session ids it found.

How the session id is found for a pane, in order:

1. the agent process's `--session <id>` argument;
2. `PI_SESSION_ID` in the environment of one of its child processes;
3. the session file whose timestamp falls within three minutes after the agent process started.

The id from step 1 is the session the agent was launched with. If someone switches sessions inside the agent, only steps 2 and 3 notice.

When the owner writes in a closed lane's thread, reopen its recorded session in a new tab, set its monitors again, and keep replying there.

## Messaging a session

Before you type into a pane:

1. check it runs a live agent (`herdr pane process-info --pane <id>`), not a shell, a stopped agent or a startup screen;
2. read it (`herdr pane read <id> --source recent-unwrapped --lines 40`) and confirm the input line is empty and no approval or question prompt is open;
3. send once, as one argument (the scripts' `sendVerified` does this);
4. read the pane again: if your text is still on the input line, press Enter again, then re-check.

Exit code 0 and echoed input are not proof the agent got the message. A reply from the session, or its record of handling the message, is.

## Watching

- Sessions that turn blocked or ask a question: answer them or bring them to the owner.
- Sessions that report a bug: reproduce it before it counts, then give it its own thread.
- `dori dead-panes` reports agent panes that stopped; restart the session in place (`<agent> --session <id>`) unless its work is finished.
