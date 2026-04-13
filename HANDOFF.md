# CoahCode Handoff Prompt

Use this as the starting prompt for the next coding session on this repo.

---

You are continuing work on **CoahCode**, a fork of [T3 Code](https://github.com/pingdotgg/t3code) that is being pushed toward a Cursor-like harness runtime without breaking the existing Claude and Codex login paths.

## Repo + Environment

- Repo: `https://github.com/coah80/coahcode`
- Local path: `~/Projects/cursor-harness/coahcode-build`
- Date of this handoff: `2026-04-13`
- Runtime: Bun
- Monorepo: Turborepo
- Server: Effect-TS + SQLite + WebSocket RPC
- Web: React 19 + TanStack Router + Query + Tailwind 4 + Vite
- Desktop: Electron

## Non-Negotiables

- Keep the repo’s current Claude login/auth flow intact.
- Keep the repo’s current Codex/OpenAI login/auth flow intact.
- Do not replace working backend systems with client-side stubs.
- Do not regress the harness integration that is already in place.
- Reliability and predictable state matter more than novelty.
- If a feature exists in UI but is not durably persisted, treat that as unfinished.

## Product Direction

The target is still:

- T3 Code UX and provider compatibility
- Cursor-style harness behavior
- parallel tool execution per model turn
- MCP, skills, and LSP support
- scheduled recurring agent work
- steer vs queue follow-ups
- model switching that applies after the active run is interrupted or finishes
- better thread organization and drag/drop
- project-oriented workflow starting from a Home area

The repo is no longer in the old "parallel harness exists off to the side" state. A lot of the integration work is already real. The remaining work is hardening, edge cases, runtime parity, and UX cleanup.

## Current State

### 1. CoahCode is still a fork of T3 Code

`README.md` already says:

- CoahCode is a fork of T3 Code
- it adds a Cursor-style harness layer, MCP support, LSP integration, scheduled runs, steering, and related UX changes

Do not let that regress during future edits.

### 2. The harness is integrated, but not exposed as a "third provider" in normal chat UX anymore

The important behavior shift is this:

- users still choose Claude or Codex in normal chat flows
- the backend now decides whether those sessions run through the native provider runtime or the CoahCode runtime
- this is controlled by `assistantHarnessMode`

Relevant files:

- `packages/contracts/src/settings.ts`
- `apps/server/src/provider/Layers/routedProviderAdapter.ts`
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `apps/web/src/session-logic.ts`

Current behavior:

- `assistantHarnessMode` can be `"native"` or `"coahcode"`
- the default is `"coahcode"`
- the visible provider picker stays Claude/Codex focused
- the routed adapter checks whether harness upstream auth is available for the chosen provider
- if auth is available, the routed adapter runs the chat through the harness backend
- if auth is not available, it falls back to the native provider adapter

This means:

- the user keeps the existing Claude/Codex login behavior
- CoahCode is not forced to be a separate provider choice
- the runtime can prefer the harness backend when safely possible

This is the current answer to the user’s request for "CoahCode harness should not be a separate thing" and "only one harness can be active." Right now that concept is implemented as a runtime mode switch, not a full plugin-style harness registry.

### 3. There is now a Home project flow

This was added to support starting from a generic Home area without forcing every first message into a project.

Relevant files:

- `apps/server/src/harness/engine/home.ts`
- `packages/shared/src/homeProject.ts`
- `packages/contracts/src/orchestration.ts`
- `apps/server/src/ws.ts`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/ChatView.tsx`

Current behavior:

- workspace discovery includes the user home directory as a special `Home` workspace
- the sidebar ensures a real Home project exists and pins it at the top
- Home uses a dedicated `HomeIcon`
- when the user starts from a local draft thread under Home and sends the first message, the app first asks a local routing question
- the choices are:
  - `Create project folder`
  - `Keep in Home`
- `Keep in Home` is for general-purpose chat, research, or anything that should not become a dedicated project
- `Create project folder` uses the Home bootstrap flow to create a real project and move the thread into it
- the question is local UI state, not a provider-runtime request, because it must happen before the first turn is sent
- after the user chooses `Create project folder`, the UI adds bootstrap metadata to the turn-start command
- that bootstrap metadata includes `createProject`
- the server creates a filesystem folder under an appropriate project directory
- then it creates a project in orchestration
- then it creates the thread in that new project
- then it starts the turn

The folder name is sanitized through:

- `packages/shared/src/homeProject.ts`

And the server-side project creation uses:

- `createProject(...)` in `apps/server/src/harness/engine/home.ts`

That helper now:

- finds a suitable project root under `~/Projects`, `~/Developer`, `~/repos`, `~/workspace`, or `~/code`
- falls back to `~/Projects`
- sanitizes the folder name
- auto-increments duplicate names like `Project`, `Project 2`, `Project 3`

There is also a first-turn naming refinement now:

- if Home creates a new project from the first message, the existing first-turn AI title generation can rename the project entry in orchestration/UI
- this is intentionally limited to eligible auto-created projects
- it does **not** rename the live filesystem directory during the active run

This is the current "start in Home, choose whether this is a project, and only then create/move into a project folder" path.

### 4. Scheduled tasks are real, persisted, and editable now

Relevant files:

- `apps/server/src/persistence/Migrations/024_ScheduledTasks.ts`
- `apps/server/src/scheduledTasks/Services/ScheduledTasks.ts`
- `apps/server/src/scheduledTasks/Layers/ScheduledTasks.ts`
- `apps/server/src/scheduledTasks/Layers/Runner.ts`
- `apps/server/src/harness/tools/scheduledTasks.ts`
- `apps/server/src/ws.ts`
- `packages/contracts/src/ipc.ts`
- `packages/contracts/src/rpc.ts`
- `packages/shared/src/scheduler.ts`
- `apps/web/src/lib/scheduledTasksReactQuery.ts`
- `apps/web/src/components/ScheduledTasks.tsx`

Current backend behavior:

- scheduled tasks persist in SQLite
- there is server-side CRUD
- there is an active runner
- the harness can create scheduled tasks from natural language
- the scheduled task manager now supports `list`, `create`, `update`, `toggle`, and `delete`

Current UI behavior:

- the settings UI shows scheduled tasks
- tasks can be created manually
- tasks can be edited in place
- tasks can be paused/resumed
- tasks can be deleted
- each task shows:
  - prompt
  - schedule label
  - workspace
  - model
  - last run
  - next run
  - a filling progress bar
  - a live countdown label

Shared scheduler helpers live in:

- `packages/shared/src/scheduler.ts`

The goal here was the user’s request for:

- "shows what tasks you have scheduled"
- "pause, change the time, or just remove them"
- "a bar + timer that slowly fills until it’s time for the task to run again"

That work is in place.

### 5. Natural-language task creation exists in the harness

Relevant file:

- `apps/server/src/harness/tools/scheduledTasks.ts`

The harness is prompted to translate asks like:

- "every 5 minutes improve one thing on this site and push"

into real scheduled tasks. The tool parses cadence, stores the recurring instruction, and persists the task instead of treating the whole thing as an ordinary chat reply.

This still needs stronger safety and better observability, but the basic capability is real.

### 6. Project icon overrides are implemented

Relevant files:

- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/ProjectIconDialog.tsx`
- `apps/web/src/components/ProjectFavicon.tsx`
- `apps/web/src/projectIcons.tsx`
- `packages/contracts/src/orchestration.ts`
- `apps/server/src/orchestration/decider.ts`
- `apps/server/src/orchestration/projector.ts`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/server/src/persistence/Services/ProjectionProjects.ts`
- `apps/server/src/persistence/Layers/ProjectionProjects.ts`
- `apps/server/src/persistence/Migrations/025_ProjectIcons.ts`

Current behavior:

- right-click a project row in the sidebar
- choose `Change folder icon`
- select a preset Material/Google-style icon
- or upload a custom image
- project metadata persists the override
- the icon survives reloads

This work is already in the repo. Do not accidentally regress it while touching sidebar behavior.

### 7. Thread dragging has custom physics

Relevant files:

- `apps/web/src/hooks/usePhysicsDrag.tsx`
- `apps/web/src/components/Sidebar.tsx`

Current behavior:

- thread dragging is not a stiff default drag image anymore
- the drag ghost dangles from the pointer
- pointer momentum affects the motion
- the rope stretches more under faster movement
- the whole motion is intentionally looser and more swingable than before

This is materially better than the earlier half-wired version, but it still needs edge-case tuning.

### 8. OpenCode-style interop support exists

Relevant files:

- `apps/server/src/harness/opencodeInterop.ts`
- `apps/server/src/harness/skills/loader.ts`
- `apps/server/src/provider/Layers/harnessRuntime.ts`
- `apps/server/src/harness/mcp/client.ts`
- `apps/server/src/harness/lsp/client.ts`

Current behavior:

- the harness can import OpenCode-style config sources
- it can load skills and instruction files
- it can load MCP configuration
- it can resolve upstream auth/base URLs from compatible config inputs

This is part of the answer to "can I use my skills, MCPs, and LSPs like OpenCode does?"

### 9. Model switching and queued follow-ups are wired

Relevant files:

- `apps/web/src/components/chat/ModelSwitcher.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/chat/ComposerQueuedFollowUpsPanel.tsx`
- `apps/web/src/components/chat/SteeringIndicator.tsx`
- `apps/server/src/harness/engine/modelSwitch.ts`
- `apps/server/src/harness/engine/steering.ts`
- `apps/web/src/components/ChatView.tsx`

Current behavior:

- model switching exists in the composer for harness-backed runtime paths
- it is supposed to apply after the active run is interrupted or finishes
- queued follow-ups are persisted in the web app rather than disappearing immediately on refresh
- steering UI exists and is usable
- the default follow-up behavior is now `queue`, not `steer`
- while a run is active, typing a follow-up brings back the purple send arrow instead of forcing the red stop square
- the red stop square only stays visible when a run is active and there is no sendable follow-up content in the composer
- Enter or the purple send button will queue by default unless the user explicitly toggles behavior to `steer`

This area still needs harder runtime validation.

## Required Verification Status At This Handoff

At this handoff point the following pass:

- `bun fmt`
- `bun lint`
- `bun run typecheck`

`bun lint` still has warnings, but it exits successfully.

Known warnings:

- `apps/web/src/components/ChatView.tsx`
  - several `react-hooks/exhaustive-deps` warnings
- `apps/web/src/environments/runtime/catalog.test.ts`
  - `unicorn/consistent-function-scoping`

These are real cleanup items, but they are not new breakages from the latest Home/scheduler/runtime work.

## What Still Needs To Be Hardened

Treat everything below as real remaining engineering work, not optional polish.

### Priority 0: Runtime Correctness

1. Harness attachment support is still incomplete.
   - Audit turn input, provider adapter translation, persistence, and replay paths.
   - Make sure attachments behave correctly through the routed provider setup, not just the native adapters.

2. Steering persistence still needs to become durable server state.
   - The UI behavior exists.
   - The exact upstream-style persistence model is not fully replicated server-side yet.
   - Move the source of truth into orchestration/evented state instead of relying on client-only behavior.

3. Model switching needs stronger real-world validation.
   - Verify active-run interruption.
   - Verify change-after-complete.
   - Verify reconnect/reload.
   - Verify interaction with queued follow-ups.
   - Verify Claude and Codex routed sessions separately.

4. MCP tool-call lifecycle parity is still incomplete.
   - The user explicitly asked that MCP tool calls show the same things as other tools.
   - Audit event mapping, titles, progress states, result previews, and failures.
   - This is partially implemented, not fully polished.

5. Revisit the Home routing question once the UX settles.
   - Right now it is a local pre-send question, not a provider/runtime question.
   - That is intentional because the decision has to happen before the first turn.
   - If you change it, do not accidentally force all Home chats into projects again.

### Priority 1: CoahCode Runtime Routing

1. The current `"native"` vs `"coahcode"` switch is a practical first version, not the final design.
   - It behaves like one active harness/runtime mode at a time.
   - It is not yet a fuller "installable harnesses" system.

2. The current routing strategy is intentionally conservative.
   - If CoahCode runtime can safely resolve upstream auth, it uses the harness backend.
   - If not, it falls back to the native provider adapter.

3. There is still no fully safe, official bridge that reuses Claude/Codex logged-in state directly inside every harness transport path.
   - Do not hack around this by scraping opaque tokens from unrelated tools.
   - If you want tighter auth reuse, do it through official SDK/provider mechanisms or repo-owned login flows.

4. If the long-term goal is true installable harnesses:
   - formalize a harness/runtime registry
   - persist the active runtime selection more explicitly
   - make runtime capabilities discoverable in settings

### Priority 2: Home Project Flow

1. Smoke-test the Home flow end to end.
   - Start from Home.
   - Create a draft thread.
   - Send first prompt.
   - Confirm the local routing question appears.
   - Choose `Keep in Home` and verify the first turn stays in Home.
   - Choose `Create project folder` and verify filesystem folder creation, project creation, and immediate thread move.

2. Validate naming behavior.
   - duplicate project names
   - weird punctuation
   - empty/blank titles
   - very long titles

3. Validate the first-turn AI rename behavior.
   - It should rename eligible auto-created project entries in the UI/read model.
   - It should not rename unrelated manual projects.
   - It should not try to rename the filesystem directory mid-run.

### Priority 3: Scheduled Task Reliability

1. Smoke-test scheduled tasks from both entry points.
   - from the settings UI
   - from natural-language chat instructions

2. Add real task run history.
   - last success
   - last failure
   - last output preview
   - active/running status

3. Harden overlap handling.
   - Verify behavior when a task runtime exceeds its interval.
   - Verify no accidental double-run on reconnect or server restart.

4. Improve safety around autonomous prompts.
   - Especially prompts that include git mutation, pushing, or destructive shell behavior.

5. Consider better cron editing UX.
   - current UI uses presets and editable task data
   - there is still room for a more explicit editor if this becomes a daily-use feature

### Priority 4: MCP / Skills / LSP

1. Add better settings UX for MCP servers.
   - add/edit/remove local stdio MCPs
   - add/edit/remove remote MCPs
   - header/auth support
   - persistence clarity

2. Improve skill visibility.
   - show what skill sources were discovered
   - show when OpenCode-imported skills are active
   - expose readable errors when skill loading fails

3. Revisit LSP lifecycle strategy.
   - Decide whether managers should stay more persistent or remain per-run scoped.
   - Be careful not to trade reliability for an optimization that complicates recovery.

### Priority 5: UX Polish

1. Project icon workflow.
   - validate oversized uploads
   - maybe resize/compress images
   - make reset/removal clearer

2. Drag/drop affordances.
   - better drop hover feedback
   - verify dragging from Home-origin threads into other folders/projects
   - tune the physics without making drop targeting sloppy

3. Composer behavior cleanup.
   - Queue is the default now. Make sure settings copy and affordances reflect that.
   - The send/stop button behavior should remain:
     - purple arrow when a sendable follow-up is typed
     - stop square only when there is no sendable follow-up content during a run
   - If you change this, do not regress the “type while running, then press Enter/button to queue” flow.

4. Naming cleanup.
   - audit lingering `T3`, `t3`, or pre-fork copy in the desktop app and package metadata
   - keep CoahCode naming consistent

## What Still Needs Better Tests

- routed provider adapter backend selection
- harness event rewriting back to Claude/Codex provider identities
- Home bootstrap project creation flow
- Home routing question behavior
- Home keep-vs-project decision persistence across the first send path
- scheduled task natural-language parsing
- scheduled task update/toggle/delete RPCs
- project icon persistence and projection replay
- model switch application timing
- steering persistence once moved server-side
- drag/drop between projects from Home-origin threads

## Files That Matter Most Right Now

### Runtime routing

- `apps/server/src/provider/Layers/routedProviderAdapter.ts`
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- `packages/contracts/src/settings.ts`
- `apps/web/src/components/settings/SettingsPanels.tsx`

### Home project flow

- `apps/server/src/harness/engine/home.ts`
- `packages/shared/src/homeProject.ts`
- `packages/contracts/src/orchestration.ts`
- `apps/server/src/ws.ts`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/ChatView.tsx`

### Composer follow-up / send controls

- `packages/contracts/src/settings.ts`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/chat/ComposerPrimaryActions.tsx`
- `apps/web/src/components/chat/SteeringIndicator.tsx`

### Scheduled tasks

- `apps/server/src/scheduledTasks/Layers/ScheduledTasks.ts`
- `apps/server/src/scheduledTasks/Layers/Runner.ts`
- `apps/server/src/harness/tools/scheduledTasks.ts`
- `apps/web/src/components/ScheduledTasks.tsx`
- `packages/shared/src/scheduler.ts`

### Sidebar organization / drag / icons

- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/hooks/usePhysicsDrag.tsx`
- `apps/web/src/components/ProjectIconDialog.tsx`
- `apps/web/src/projectIcons.tsx`

### Harness runtime and interoperability

- `apps/server/src/provider/Layers/HarnessAdapter.ts`
- `apps/server/src/provider/Layers/harnessRuntime.ts`
- `apps/server/src/harness/engine/loop.ts`
- `apps/server/src/harness/opencodeInterop.ts`
- `apps/server/src/harness/mcp/client.ts`
- `apps/server/src/harness/lsp/client.ts`
- `apps/server/src/harness/skills/loader.ts`

## Suggested Next Sequence

1. Launch the desktop app and smoke-test the Home-first-send workflow.
2. Smoke-test scheduled task creation from both the settings UI and natural-language harness prompts.
3. Harden harness attachment support.
4. Move steering persistence fully into durable orchestration state.
5. Improve MCP tool-call lifecycle parity and MCP settings UX.
6. Decide whether to formalize a true harness registry beyond the current `"native"` vs `"coahcode"` runtime mode.

## Required Verification Before Calling Work Done

- `bun fmt`
- `bun lint`
- `bun run typecheck`
- `bun run dev:desktop`

If backend behavior changed materially, do manual smoke tests in the running app. UI-only confidence is not enough for this repo anymore.

## Final Reminder

This repo is past the prototype stage of "a separate harness folder exists." The work now is integration hardening:

- reduce hidden state
- reduce client/server mismatch
- preserve provider auth compatibility
- keep Cursor-style speed wins
- make Home, scheduled tasks, and tool lifecycle behavior feel intentional instead of half-finished

Do not waste time re-litigating whether the harness should exist. It already does. Focus on making the current architecture reliable and coherent.
