# Dori 엔진 자체개선 계획 (self-improve lane)

Tier: HEAVY. 오너가 "타협 없이" 검증해 달라고 요청했고, 장시간 실행되는 리드 모니터의 안정성이 걸려 있기 때문이다.

## 1. 사용자

- **오너**: Telegram에서 짧은 한국어로 요청하고, 답이 오지 않거나 잘리면 바로 불편을 느낀다.
- **리드 Dori(w1:p1)**: `dori` CLI를 실행하고 `watch`, `freshness`, `dead-panes`, `guard`, `poll.ts`를 상시 모니터로 띄워 둔다. 리드의 실수가 조용히 무시되면 오너가 피해를 본다.
- **레인 에이전트**: 브리프를 받아 `[REPORT]`를 보내고 `claim-done`을 실행한다.

## 2. 이상적인 상태

| ID | 이상적인 상태 | 이유 |
|----|---------------|------|
| I1 | 잘못된 플래그(오타)는 즉시 거부하고, 유효한 옵션 목록을 보여 준다 | `--threads` 같은 오타가 조용히 무시되면 레인 thread가 "none"으로 등록되고, 그러면 오너에게 진행 보고가 가지 않는다 |
| I2 | 레인 JSON 하나가 깨져도 `watch`, `freshness`, `sync`, `claim-done`이 나머지 레인으로 계속 동작하고, 깨진 파일을 경고로 알린다 | 상시 모니터가 파일 하나 때문에 모든 레인의 done 처리를 멈추면 안 된다 |
| I3 | `launch --model M`을 줬는데 `agentCommand`에 `{model}`이 없으면 조용히 무시하지 않고 거부한다 | 실제 config(`["omo","{prompt}"]`)에서 `--model`이 무시되고 있다. 리드는 모델을 바꿨다고 믿게 된다 |
| I4 | 4096자를 넘는 Telegram 메시지는 잘리거나 실패하지 않고 여러 메시지로 나뉘어 전달된다 | 긴 보고를 보낼 때 오너가 아무것도 받지 못하는 상황을 막는다 |
| I5 | 기존 동작(테스트 48개)에 리그레션이 없고, typecheck가 깨끗하다 | 회귀 방지를 위해서다 |

## 3. 현재와의 차이 (증거)

- G1: `scripts/src/cli.ts` 의 `parseArgs({ strict: false })` 때문에 알 수 없는 플래그가 무시된다 → I1
- G2: `scripts/src/registry.ts` 의 `list()`가 `Bun.file().json()`을 그대로 await한다. JSON 파일 하나가 깨지면 throw하고, `watchTick`가 매 tick 실패한다 → I2
- G3: `scripts/src/launch.ts` 의 `fill(agentCommand, {model, prompt})`가 `{model}`이 없는 템플릿에서 model을 버린다. `~/.dori/config.json` 의 `agentCommand`가 `["omo","{prompt}"]` 이다 → I3
- G4: `scripts/src/messenger/telegram.ts` 의 `send`가 텍스트를 그대로 `sendMessage`에 넘긴다. Telegram API는 4096자를 넘으면 "message is too long"으로 실패한다 → I4

## 4. 실행 계획 (quick 병렬, 쓰기 범위 분리)

- W1 (quick): cli.ts에서 알 수 없는 옵션을 거부한다. 테스트 파일은 `test/cli-flags.test.ts` 이다.
- W2 (quick): registry.ts에서 손상된 lane 파일을 건너뛰고 경고한다. 테스트 파일은 `test/registry.test.ts` 이다.
- W3 (quick): launch.ts에서 `{model}` 없는 템플릿에 `--model`을 주면 LaunchError를 던진다. 테스트 파일은 `test/launch-model.test.ts` 이다.
- W4 (quick): telegram.ts에서 4096자 단위로 분할 전송한다. 테스트 파일은 `test/telegram-split.test.ts` 이다.
- 리드가 직접 맡는 일: 통합, 엄격한 검증, 문서 동기화(`references/scripts.md`), 커밋, 보고.

## 5. QA 시나리오 (각각 이진 판정)

| QA | 실행 | PASS 조건 |
|----|------|-----------|
| Q1 | `DORI_CONFIG=<tmp> bun src/cli.ts launch k --titel x` | exit≠0이고, stderr에 `unknown option --titel`이 나온다 |
| Q2 | 임시 stateDir에 정상 lane과 `broken.json`(`{`)을 넣고 `DORI_STATE_DIR=<tmp> bun src/cli.ts sync` 실행 | exit 0이고, 정상 lane이 출력되며, stderr에 broken 경고가 나온다 |
| Q3 | 임시 config `agentCommand:["omo","{prompt}"]` 로 `bun src/cli.ts launch k --title t --brief b --done 'file /tmp/x' --model m` 실행 | exit≠0이고, `{model}` 안내 문구가 나온다 |
| Q4 | 가짜 http로 5000자를 `Telegram.send` | sendMessage가 2회 호출되고, 각 조각이 4096자 이하이며, 이어 붙이면 원문과 같다 |
| Q5 | `bun test` + `bunx tsc --noEmit` | 둘 다 exit 0이다 |

## 6. 증거 기록
(실행 후 아래에 추가한다)

- W4: quick 워커(st_01a11839)가 브리지 오류(tools 0)로 실패했기 때문에, 레인이 직접 구현했다.
- Q4 PASS: `bun test test/telegram-split.test.ts test/messenger.test.ts` 결과 14 pass, 0 fail이다. 5000자 메시지는 2회 전송되고 원문과 같게 이어지며, 첫 id를 반환하고, 서로게이트 쌍을 보존한다.
- W1: quick 워커(st_01a11836)도 브리지 오류로 실패했다. 변경이 남지 않았음을 git으로 확인한 뒤, 레인이 직접 구현했다.
- Q1 PASS: `bun src/cli.ts launch k --titel x` 결과 exit 1이고, stderr에 `unknown option --titel; valid: ...`가 나왔다. `test/cli-flags.test.ts`는 2 pass이며, `heavy ... -- --weird`는 검사 대상에서 제외된다.
- W2: quick 워커(st_01a11837)가 완료했다. 변경된 파일은 `registry.ts`의 `list()` try/catch와 `test/registry.test.ts`이다.
- Q2 PASS: 임시 stateDir에 good.json과 broken.json(`{`)을 두고 `bun src/cli.ts sync`를 실행했다. 결과는 exit 0이었고, `good | none | ... | working` 행이 출력됐으며, stderr에 `LANE_FILE_UNREADABLE .../broken.json: Failed to parse JSON`이 나왔다. 임시 디렉터리는 rm -rf로 정리했다.
- W3: quick 워커(st_01a11838)가 완료했다. 변경된 파일은 `launch.ts`의 `validateLaunch`와 `test/launch-model.test.ts`이다.
- Q3 PASS: 임시 config `agentCommand:["omo","{prompt}"]`로 `launch qak ... --model m`을 실행했다. 결과는 exit 1이었고, `--model m would be ignored: ... has no {model} placeholder`가 출력됐다. herdr 호출과 레지스트리 등록은 일어나지 않았고, 임시 디렉터리는 삭제했다.

### explore 감사로 추가한 갭과 QA
- G5: 레인 thread는 `telegram:123456789:10` 형식으로 저장되는데, `hooks.threadReply`가 이 값을 `--to`로 그대로 넘긴다. 이 때문에 freshness 자동 게시가 항상 실패한다. 이상적인 상태는 오너가 레인 진행 보고를 실제로 받는 것이다.
- G6: `UnsafeTextError`가 최상위 catch에 없어서, 백틱이 들어간 reason을 넣으면 raw 스택이 출력된다.
- Q6 PASS: 실제 봇으로 `dori send telegram --to telegram:123456789:10 --text ...`를 실행했다. 결과는 exit 0과 `SENT 15`였다. 토픽 10이 없어서 `WARN topic 10 not found ...; sent to the chat without a topic`가 출력됐고, 오너 채팅에 메시지가 도착했다. 폴백을 넣기 전에는 exit 1과 `message thread not found`가 나왔다.
- Q7 PASS: 백틱이 들어간 reason으로 `object-done qa --reason 'broke `foo`'`를 실행했다. 결과는 exit 1이었고, 스택 대신 `refusing to send text containing a backtick or $(` 한 줄만 출력됐다.
- Q5 PASS: `bun test` 결과 56 pass, 0 fail이고, `bunx tsc --noEmit` 결과 TSC_OK(exit 0)이다.

### 보류한 항목 (후속 작업)
- `~/.dori/config.json`의 `agentCommand`에 `{model}`이 없다. 리드가 쓰는 설정이므로 리드가 결정해야 하며, 현재는 Q3에 따라 `--model` 오용을 거부한다.
- `lastReplyAt`을 기록하는 코드가 없다. 이 때문에 무응답 시간이 레인 시작 시점부터 계산된다.
- `STARTUP_ERROR`가 난 레인을 닫을 방법이 없다. 현재 `close`는 Done 신호를 요구한다.
- poll.ts가 `edited_message`를 무시한다. 이 파일은 라이브 모니터이므로 수정하지 않았다.

## 7. 2차 라운드 (self-improve-2): 보류 항목 4건 처리

| # | 시나리오 | PASS 조건 | 결과 |
|---|---|---|---|
| R1 | 실제 `~/.dori/config.json`을 `loadConfig`로 읽고 `validateLaunch(... model:"openai/gpt-5")` 후 `fill(agentCommand)` | 거부 없이 `["omo","--model","openai/gpt-5","hi"]`가 나온다 | PASS: `VALID ["omo","--model","openai/gpt-5","hi"]`가 출력됐다. `omo --help`에 `--model <pattern>`이 있음을 확인했다. |
| R2 | `test/sweeps.test.ts`: 새 [REPORT] 줄이 보이면 `lastReplyAt`이 기록되고 무응답 시계가 초기화된다. `done-flow.test.ts`: done claim도 `lastReplyAt`을 기록한다 | 테스트가 통과한다 | PASS |
| R3 | 임시 stateDir에 pane 없는 lane을 두고 `DORI_CONFIG=<tmp> bun src/cli.ts abandon qa-dead --reason "STARTUP_ERROR usage limit"` 실행 | `ABANDONED qa-dead ...`가 출력되고 lane 파일 status가 closed가 된다 | PASS: 출력과 `{"closedAt":true,"status":"closed"}`를 확인했고, 임시 디렉터리는 rm -rf로 정리했다. 단위 테스트는 Done 신호가 OPEN이어도 tab만 닫고 worktree는 남김을 검증한다. |
| R4 | `~/.dori/poll.ts`가 오너의 `edited_message`에 `OWNER_EDIT chat=.. msg=.. text=..`를 출력한다 (같은 오너 필터, 같은 offset 파일) | `bun build`가 성공한다 | PASS (빌드 확인). 라이브 모니터라서 리드가 재시작해야 반영된다. |
| R5 | `bun test` + `bunx tsc --noEmit` | 둘 다 exit 0이다 | PASS: 59 pass, 0 fail이고 TSC_OK이다. |

## 8. 3차 라운드 (self-improve-3b)

### 사용자와 실제로 겪은 문제
- 리드 Dori: `self-improve-3` 레인이 `STARTUP_ERROR No API key`로 실패했다. 문서(references/sessions.md)는 "다른 모델로 다시 launch하라"고 안내하지만, abandon으로 닫은 키도 `lane ... is already registered`로 거부된다. 그래서 리드는 `self-improve-3b`라는 새 키를 만들어야 했다.
- 레인 에이전트: 같은 브리프로 다시 launch할 때마다 footer가 덧붙는다. 실제 `~/.dori/briefs/self-improve-3.md`에는 키가 서로 다른 footer가 3개(self-improve, self-improve-3, self-improve-3b) 있어서, 레인은 어떤 키로 보고하고 claim-done 할지 추측해야 한다.
- 오너: freshness가 `hooks.threadReply` 실행 결과를 확인하지 않는다. 전송이 실패해도 `POSTED`를 출력하고 `lastAutoReplyAt`을 기록하므로, 리드는 오너가 보고를 받았다고 믿고 재시도도 일어나지 않는다.

### 이상적인 상태
| ID | 상태 | 이유 |
|----|------|------|
| I6 | 같은 브리프로 몇 번을 launch해도 footer는 정확히 하나이고 최신 키를 담는다 | 레인이 보고 키를 추측하지 않아야 한다 |
| I7 | 닫힌(closed) 레인의 키는 다시 launch/adopt할 수 있고, 이전 기록은 `lanes/archive/`에 보존된다. 열린 레인의 키는 여전히 거부된다 | 문서대로 "다른 모델로 relaunch"가 가능해야 하고, 감사 기록은 잃지 않아야 한다 |
| I8 | threadReply 훅이 실패하면 `POST-FAILED`를 출력하고 `lastAutoReplyAt`을 기록하지 않아 다음 tick에서 재시도된다 | 리드와 오너에게 거짓 성공을 보여 주지 않아야 한다 |
| I9 | 기존 59개 테스트에 리그레션이 없고 typecheck가 깨끗하다 | 회귀 방지 |

### 차이 (증거)
- G7: `launch.ts` launchLane이 `brief 본문 + footer`를 덧붙이기만 한다 → I6
- G8: `launch.ts` validateLaunch가 `registry.read(key)`가 있으면 상태와 무관하게 거부한다 → I7
- G9: `freshness.ts` freshnessTick이 `deps.run(fill(hook,...))`의 exit code를 버린다 → I8

### 계획
- 직접 구현한다(변경은 파일 3개 + 테스트, 이전 라운드 quick 워커 브리지 실패 이력).
- launch.ts: 기존 `## Lane footer (written by dori launch)` 블록부터 끝까지 제거한 뒤 footer 하나를 붙인다. 닫힌 레인이면 `Registry.archive(key)`로 `lanes/archive/<key>.<closedAt>.json`에 옮긴 뒤 진행한다.
- freshness.ts: 훅 exit code를 확인하고 실패 시 `post-failed` act를 낸다.
- 문서: references/scripts.md, references/sessions.md를 동기화한다.

### QA 시나리오
| QA | 실행 | PASS 조건 |
|----|------|-----------|
| Q8 | footer 3개가 있는 브리프 복사본으로 단위 테스트 launch (fake herdr) | 결과 브리프에 footer 헤더가 정확히 1개이고 새 키를 담는다 |
| Q9 | 임시 stateDir에 closed 레인 `qa-re`를 두고 `DORI_CONFIG=<tmp> bun src/cli.ts adopt qa-re --pane w9:p9 ...` 실행, 이어서 같은 명령 재실행 | 첫 실행은 `ADOPTED`이고 archive 파일이 생긴다. 두 번째는 `already registered`로 exit 1이다 |
| Q10 | 단위 테스트: threadReply 훅이 exit 1을 반환 | act가 `post-failed`이고 lastAutoReplyAt이 없으며, 다음 tick에 다시 시도한다 |
| Q11 | `bun test` + `bunx tsc --noEmit` | 둘 다 exit 0 |

### 증거 기록
- Q8 PASS: `test/relaunch.test.ts` 첫 테스트에서 footer 2개가 있던 브리프가 footer 1개(`- Key: re-lane.`)만 남았고, 이전 기록이 `lanes/archive/re-lane.*.json`으로 옮겨졌다. 수정 전 src(git stash)에서는 이 테스트가 fail했다.
- Q9 PASS: 임시 stateDir의 closed 레인 `qa-re`로 `bun src/cli.ts adopt qa-re --pane w9:p9 ...`를 실행했다. 첫 실행은 exit 0과 `ADOPTED qa-re pane=w9:p9 thread=none`이었고 `archive/qa-re.2026-10-07T01-00-00Z.json`이 생겼다. 두 번째 실행은 exit 1과 `lane qa-re is already registered`였다. 임시 디렉터리는 rm -rf로 삭제했다(gone 확인).
- Q10 PASS: `test/relaunch.test.ts` 셋째 테스트에서 훅 exit 1이면 act가 `post-failed`(`exit 1 ...`)이고 lastAutoReplyAt이 없으며, 5분 뒤 tick에서 다시 `post-failed`로 재시도했다. 수정 전 src에서는 fail했다.
- Q11 PASS: 62 pass /  0 fail / TSC_OK.
