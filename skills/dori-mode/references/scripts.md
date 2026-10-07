# Scripts

`scripts/` is a bun + TypeScript package with one CLI, `dori`. Every external command runs as an argv array; nothing builds a shell string.

## Install and test

```sh
cd skills/dori-mode/scripts
bun install          # dev dependencies only (types, tsc)
bun link             # puts `dori` on your PATH
bun test             # behavior tests with fake herdr/git/gh; nothing real is touched
bunx tsc --noEmit    # typecheck
```

Needs: bun 1.3+, herdr, git, and the GitHub CLI (`gh`) for `merged`/`closed` signals (npm for `published`). The `command`, `file` and `url` signals need nothing extra. The full list of signal kinds is in `sessions.md`. The host guard reads `sysctl`, `memory_pressure` and `df` on macOS; on Linux it reads `/proc/loadavg` and `df`, and memory and swap read as unknown.

## Configuration

`~/.dori/config.json` (or the path in `DORI_CONFIG`). Every field is optional; see `config.example.json`. `DORI_STATE_DIR` and `DORI_LEAD_PANE` override the file.

| Field | Default | Used by |
|---|---|---|
| `stateDir` | `~/.dori/state` | registry, heavy slots |
| `laneWorkspace` | current workspace | `launch` |
| `workspaces` | all | `sync`, `dead-panes` |
| `ignorePanes`, `leadPane` | none | panes the sweeps skip; `leadPane` is also where lanes report |
| `defaultCwd` | home | where lanes start, and the repo whose worktrees they own |
| `agentCommand`, `defaultModel`, `launchKeywords` | `omo --model {model} {prompt}` | `launch` |
| `sessionsDir` | `~/.omo/agent/sessions` | session-id lookup |
| `nudgeAfterMin`, `postAfterMin` | 15, 20 | `freshness` |
| `closeAfterMin` | 5 | `watch` |
| `heavySlots`, `heavyMaxLoad` | 1, 80 | `heavy` |
| `deadPanePatterns` | `has stopped`, `no suitable jobs` | `dead-panes` |
| `guard` | load 150/80, 20% memory, 50 GB disk, 20 panes | `guard` |
| `hooks.threadReply`, `hooks.threadDone` | none | `freshness`, `close` |
| `hooks.transcribe` | none | `transcribe` (argv with `{file}`, prints the text) |

Hooks are argv templates for your messenger CLI. `{thread}`, `{text}` and `{key}` are filled into each argument separately, so the text stays one argument whatever it contains.

## Library modules

The CLI is a thin layer over typed modules you can import in your own scripts:

| Module | What it gives you |
|---|---|
| `src/messenger/slack.ts` | `Slack`: post, edit, thread replies, file upload (upload URL + complete), presence; 429 backoff |
| `src/messenger/telegram.ts` | `Telegram`: send, edit, typing, `sendMessageDraft` streaming with a `Thinking…` start, forum topics (create, rename, close, reopen), HTML tables |
| `src/messenger/discord.ts` | `Discord`: send without pings, edit, typing, threads (start, rename, archive); gateway presence |
| `src/messenger/typing.ts` | `typingWhile`: show typing while a piece of work runs, stop when it ends |
| `src/messenger/voice.ts` | `transcribe`: voice note to text through your hook |
| `src/messenger/thread-ledger.ts` | `ThreadLedger`: every thread the Dori posts in, persisted; given to `Slack`, it records each `chat.postMessage` (also raw `call`s) |
| `src/messenger/slack-inbound.ts` | `pollSlackInbound`: threads view, the ledger's threads and unread counts, deduplicated, own messages filtered |
| `src/messenger/slack-presence.ts` | `slackPresence`: hold a user account active |
| `src/routing.ts` | `canLaunch`, `idleLaneFor`: the routing checks |

Every module takes its HTTP, clock and timers as arguments. That is how the tests run without the network.

## Commands

Every command refuses an unknown `--flag` (exit 1, listing the valid ones), so a typo never runs silently. Arguments after a literal `--` (as in `dori heavy`) are not checked. A lane file in the registry that is not valid JSON is skipped with `LANE_FILE_UNREADABLE <path>` on stderr, so one broken file never stops `watch`, `freshness` or `sync`.

### `dori launch <key> --title T --brief FILE --done "..." [--thread REF] [--model M] [--cwd DIR]`
Opens a lane: writes the footer into the brief (replacing a footer an earlier launch wrote, so the brief keeps exactly one), opens a tab, starts the agent, and checks the pane for startup errors after 20 seconds. Exit 3 on `STARTUP_ERROR`. `--model` is refused when `agentCommand` has no `{model}` placeholder, because the model would otherwise be dropped silently. A key whose lane is closed (for example abandoned after `STARTUP_ERROR`) can be launched or adopted again; the old record moves to `<stateDir>/lanes/archive/`. A key whose lane is still open is refused.

### `dori adopt <key> --pane ID --title T --brief FILE --done "..." [--thread REF]`
Registers a lane that is already running.

### `dori sync [--write]`
Prints `key | thread | pane | session | status` for every open lane and every unregistered agent pane, followed by drift. Read-only unless `--write`, which stores session ids.

### `dori claim-done [<key>] --evidence TEXT` / `dori object-done <key> --reason TEXT ...`
The two halves of the done flow. Both message the lane's pane and check that Enter registered.

### `dori close <key> [--note TEXT]`
Closes a lane now. Refuses (exit 2) unless every `Done =` signal reads back live. On success it marks the thread done through `hooks.threadDone`, closes the tab, and removes the lane's worktrees with a plain `git worktree remove`, which refuses a dirty worktree.

### `dori watch`
Runs forever. Every 30 seconds it prints each new claim once (`LANE_DONE_CLAIMED`). Claims older than `closeAfterMin` are settled: unpushed or uncommitted work and failing signals turn into objections (`LANE_NOT_DONE`); otherwise the lane is closed (`LANE_CLOSED`). The deadline lives in the registry, so a restart picks up where it left off.

### `dori freshness [--loop MIN]`
For working lanes that have gone quiet: a nudge in the pane after `nudgeAfterMin`, then the lane's last `[REPORT]` line posted to its thread after `postAfterMin`, with home paths and pane ids scrubbed. Each happens once per silence. If `hooks.threadReply` exits non-zero, it prints `POST-FAILED <lane> exit N: ...` and does not record the post, so the next tick tries again.

### `dori dead-panes [--loop MIN]`
Prints `DEAD_PANE <id>` once per hour for a pane whose last lines match `deadPanePatterns`.

### `dori guard [--loop MIN]`
Prints `HOST_GUARD ALERT <reasons>` when load, free memory, free disk or the pane count crosses its threshold, and `HOST_GUARD CLEAR` when it recovers. It also prints `COMPUTE_READY` / `COMPUTE_BUSY` as load crosses `loadOk`. Only changes are printed.

### `dori can-launch`
Prints `CAN_LAUNCH` and exits 0 when the host has room for another lane. Otherwise it prints `HOLD <reasons>` and exits 4. The reasons come from the guard's memory, disk and pane-count thresholds. CPU load alone never holds a launch, because it moves too fast to plan around.

### `dori send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID]`
Posts a message, or edits one with `--edit`. Tokens come from `DORI_SLACK_TOKEN` (plus `DORI_SLACK_COOKIE` for a user token), `DORI_TELEGRAM_TOKEN` or `DORI_DISCORD_TOKEN`. Text containing `$(` is refused, since it can only come from a shell string. Rate limits are retried with the server's wait time; other errors fail at once. For Telegram, `--to` also takes a lane thread ref (`telegram:<chat>:<topic>` or `telegram:<chat>/<topic>`), so `hooks.threadReply` can pass `{thread}` straight through; if that topic does not exist, the message goes to the chat without a topic and a `WARN` line goes to stderr. Telegram text over 4096 characters is sent as several messages (cut at a newline where possible), and the id of the first one is printed.

### `dori presence <slack|discord>`
Keeps the account shown as online until stopped.
- **Discord:** the bot connects to the gateway and identifies as online.
- **Slack, user token:** it opens one web-client-type socket and tickles it every minute. Slack shows a user active only while such a socket is open, and auto-aways an idle one after about 30 minutes.
- Run one instance per account. Two writers flip each other's presence.

### `dori inbound slack [--loop MIN]`
Prints `INBOUND <source> <channel> <thread> <ts> <user> <text>`. It reads from three places, each message once:
- `threads-view`: unread replies in threads the account follows (Slack's own Threads view);
- `own-thread`: new replies in any thread the Dori posted in, tagged or not;
- `unread`: DMs, group DMs and channels with unread mentions.

The Dori's own messages and bot messages are skipped. Every message the Dori posts records its thread in `<stateDir>/slack-threads.json`, whichever helper sends it, so a guest's untagged reply under a root posted with a raw API call is still found.

### `dori transcribe <audio-file>`
Runs `hooks.transcribe` and prints the transcript. A failed or empty transcription is an error, never an empty message.

### `dori heavy <label> -- <command ...>`
Waits until load is under `heavyMaxLoad` and one of `heavySlots` is free, then runs the command and frees the slot when it exits. A slot held by a process that no longer exists (or a zombie) is taken over. Use it for full builds and test suites. Installs, focused tests and git do not need it.
