# Focus mode: design (TB-39)

Status: Phase 1 is built. Phases 2 and 3 are proposals. Investigated 2026-11-23 against Claude Code 2.1.330.

## The idea

Focus mode is one screen that shows only what needs a decision now. Each pending decision comes up on its own, from one project or several, and can be answered there: yes, no, pick an option, or send feedback to the agent.

The unit on this screen is a **decision**, not a session or a card. A session can raise several decisions over its life, and the screen is empty when none are open.

## What the investigation found

**1. The board misses the prompts that matter most.** Claude's live registry (`~/.claude/sessions/*.json`) marks a session `status: "waiting"` with a `waitingFor` reason. `stateOf` in `src/claude.js:566` treats anything that is not `idle` as running. During this investigation one session was stopped on an `AskUserQuestion`, and the board showed it as Running.

**2. "Needs me" is mostly history.** It held 23 sessions. None had a live process, 22 were last active more than a day ago, and 13 more than a week ago. It comes from the after-turn summary, which stays `blocked` until someone clears it.

**3. The data for a good prompt card already exists.** A waiting session's transcript ends in a tool call with no result. For `AskUserQuestion` that call holds the full questions and options. Registry status plus that unanswered call tells us what is being asked without installing anything. This was seen for a question. It still has to be confirmed for a tool permission prompt.

**4. Answering needs a hook.** The board reads Claude's files and has no way to write into a session.

| Way to answer | Covers | Verdict |
| --- | --- | --- |
| Open the session in Claude (exists, `src/server.js:294`) | Everything | Phase 1. Always the fallback |
| `PermissionRequest` hook calling the board | Tool approvals, questions (`updatedInput.answers`), plans | **Phase 2.** Documented, and a denial's message reaches Claude as feedback |
| Session messaging socket | Replying to a session whose turn ended | Later. The frame format is undocumented, and desktop sessions cannot show the dialog for held messages |
| Channels permission relay | Tool approvals only | No. Research preview, needs launch flags on every session |
| Agent SDK | Sessions the board itself starts | No. Cannot attach to existing sessions |

**5. An approval endpoint would let an agent approve itself.** The server's origin check only applies when an `Origin` header is present (`src/server.js:279`), and `curl` sends none. If approvals were a plain local POST, a session allowed to run `curl` could approve its own blocked command. This must be closed before tool approvals ship.

## What appears on the screen

| Tier | Rule | Behaviour |
| --- | --- | --- |
| **Decide now** | Live process, status `waiting` | Comes up as a decision card |
| **Reply** | Turn ended with a question, live process or active in the last 24 hours, not handled | Queued after Decide now |
| **Active** | Running, or finished in the last 2 hours | Quiet strip, never interrupts |
| Everything else | | Stays on Needs me |

On today's data this turns a list of 23 into 2 decisions, including the one the board currently misses.

Decision kinds and their controls:

- **Permission:** the exact command or diff, then Allow, Deny, Deny with feedback. No "always allow" in the first version.
- **Question:** the agent's options as buttons, multi-select where asked, plus free text.
- **Plan:** the rendered plan, then Approve or Revise with feedback.
- **Reply:** the agent's question and recap, then Open in Claude (a text box once replies can be delivered).

## Layout

```
 Focus    [All projects ▾]                        2 waiting · 3 running
┌───────────────────────────────────────────────────────┬─────────────┐
│ claude-taskboard · TB-39 · waiting 40s                │ UP NEXT     │
│ Session title · on step "Write the design"            │ ● shop      │
│                                                       │   Question  │
│ Claude wants to run:                                  │ ○ api       │
│ ┌───────────────────────────────────────────────────┐ │   Reply     │
│ │ npm test -- --grep focus                          │ │             │
│ └───────────────────────────────────────────────────┘ │ ACTIVE      │
│                                                       │ ◐ 3 running │
│ [ Allow  A ]  [ Deny  D ]  [ Feedback  F ]   Open ↗   │             │
└───────────────────────────────────────────────────────┴─────────────┘
```

Rules that keep it safe to use quickly:

- **Never swap the card under the user.** New decisions join the queue while one is on screen.
- **Arm actions after a short delay.** Buttons and keys on a new card wait about 600 ms, so a keystroke meant for the last card cannot approve this one.
- **Answered elsewhere is shown, not skipped.** If the prompt is answered in Claude, the card says so and waits for a keypress.
- **Order by what is blocked.** Decide now before Reply, oldest first, keeping one session's decisions together.
- **Project filter** is multi-select and remembered per browser.

## Architecture

```
~/.claude/sessions + transcript tail ──► src/focus.js ──► state.focus ──► public/focus.js
                                             ▲                                  │
PermissionRequest hook ── holds request ─────┘ ◄────── decision ────────────────┘
```

- `src/focus.js` derives decisions on each scan and stores nothing. It reads only the transcript tail of `waiting` sessions, so cost does not grow with history.
- A decision's id is `sessionId:toolUseId`. The hook's input has no `tool_use_id`, so a held request is matched by session, tool name and input.
- `stateOf` gains a real waiting state, which also corrects Needs me, the Dock badge and the menu-bar count.
- `wrap_up` parsing (`src/claude.js:322`) keeps `ask` but drops `actions`. Keeping them gives Reply cards their buttons.

Hook rules:

- **Fail open.** If the board is down, slow or not in Focus mode, the hook exits at once with no decision and Claude shows its normal prompt.
- **Only hold while someone is watching.** The hook waits only while a Focus page is connected.
- **Tool approvals come only from the Mac app,** using a secret kept in memory and never served over HTTP or written to disk. A browser tab can view them and open the session. This stops a plain `curl`. It cannot stop a process determined to attack the user's own account.
- **Transcript content is untrusted.** It is always escaped, and nothing in it can trigger an action.

## Unverified, to test before Phase 2

The docs do not settle these, and the design depends on them:

1. Does the desktop app's Code tab run hooks from `~/.claude/settings.json`?
2. While a hook is waiting, does Claude's own prompt still appear? If not, holding the hook hides the prompt in the app, and the design must change.
3. If the user answers in Claude first, what happens to the waiting hook?
4. What does a hook timeout do to a permission prompt? (The default timeout is 600 seconds.)
5. Do answers to `AskUserQuestion` and plan approvals through a hook work in desktop sessions?
6. Is a tool permission prompt's call in the transcript before the user answers?

Testing these means temporarily adding a logging hook to `~/.claude/settings.json`, which affects every session on this Mac, so it needs Mo's go-ahead.

## Phases

1. **Focus screen, read-only.** Fix waiting detection, add the Focus view with its tiers, cards and filters, and answer through Open in Claude. Installs nothing and changes no Claude settings.
2. **Answer in place.** After the tests above: an opt-in `taskboard focus install` hook, then questions, plans and tool approvals on the card.
3. **Reach the user anywhere.** Mac notifications or a floating panel when the board is not in front, and replies to idle sessions if a supported way to deliver them exists.
