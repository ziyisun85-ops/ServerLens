# Changelog

## ServerLens 0.1.2 - 2026-11-28

- Refresh indicators spin only for refreshes you start (the Refresh button, a card's refresh icon, Retry). Background refreshes run continuously with many servers and now only update the "Updated" time, instead of keeping the icons spinning.
- Spinning icons no longer restart on every update and always stop at the end of a turn, so they no longer jitter. Applies to the sidebar and the dashboard.
- A per-server dashboard no longer shows "Refreshing" while other servers are being collected.

## ServerLens 0.1.1 - 2026-11-28

The extension code is the same as 0.1.0 (see below).

- The 0.1.0 package on GitHub Releases accidentally contained a CI test log (`vscode-test.log`). The release workflow now writes the log outside the package folder, `*.log` is excluded from packaging, and CI and the release workflow fail if the package contains anything other than the runtime files.
- Release workflow: artifact actions updated to v7 (Node 24).

## ServerLens 0.1.0 - 2026-11-28

First release of ServerLens (preview), forked from GPU Fleet Viewer 1.4.3. Requires VS Code 1.82 or later. Compared with GPU Fleet Viewer:

### Added
- **Sidebar Monitor view** with one card per server: GPU utilization and memory, CPU, RAM, swap, storage bars, error banner with the last successful update, collapsible cards, details section, hover tooltips, right-click actions, narrow-width layout, light/dark/high-contrast themes, English and Chinese.
- **Disk monitoring** of every real filesystem (`df -P -k -T`): pseudo filesystems hidden, several mount points of one filesystem merged, pinned paths, extra hidden mounts and types, network filesystems marked, green/yellow/red thresholds (70 % / 90 % by default, configurable).
- **Personal quotas** from `quota -v` and Lustre `lfs quota`, shown separately from free disk space.
- **Disk capacity alerts** that fire once per crossing, re-arm after a 2-point drop, survive reloads, and can be snoozed for 24 h or muted per disk.
- **CPU usage** from `/proc/stat` deltas (user/system/iowait/steal), logical/physical/usable cores, load averages; **memory** from `MemAvailable` (estimated on old kernels) and **swap**.
- **Storage analysis** on demand: presets for Home, Conda, pip, Hugging Face, PyTorch and `~/.cache`, configured folders or a custom path; `du` at low priority with a time limit, cancellable, one scan per server, read-only.
- Status descriptions in the Servers tree; status bar shows full disks and appears from VS Code startup. A visible Servers tree also keeps data fresh.
- Automated tests that run the extension inside a real VS Code (1.82.0 and stable) in CI, and a release workflow that, for every version tag, attaches the VSIX to a GitHub Release and publishes to the Marketplace with Trusted Publishing (no stored token).

### Changed
- One shared scheduler (MonitorService) for the sidebar, dashboards, tree and status bar instead of a polling loop per dashboard panel. GPU, CPU, memory and disk have separate intervals (5/5/5/60 s); metrics due together are batched into one SSH command; hosts never overlap; manual refreshes coalesce; failed hosts back off from 10 s to 2 min.
- **SSH connection reuse** through OpenSSH ControlMaster (private socket directory, closed on deactivate). Monitoring connections clear port forwards from the SSH config and disable agent/X11 forwarding.
- Remote commands are sent on stdin to `sh -s` with `LC_ALL=C`, so fish/tcsh login shells and noisy `~/.bashrc` output no longer break parsing; every command is limited with `timeout` when available.
- Servers without `nvidia-smi` are shown as CPU-only instead of failed; a broken or slow `nvidia-smi` no longer hides CPU, memory and disks. Slow `nvidia-smi` gets a longer limit on the next round, and slow hosts are polled less often.
- A hung network filesystem no longer blocks disk data: after a `df` timeout only local filesystems are read.
- GPU notifications and the status bar work without the dashboard being open.
- Text that comes from a server (mount points, error messages) can no longer form clickable command links in notifications; copied GPU UUIDs and PIDs are validated before they reach the clipboard.
- In Remote-SSH, WSL and container windows, "Open terminal" opens a local terminal, where the SSH aliases and keys live.
- Closing one VS Code window no longer cuts the shared SSH connections that other windows are using.
- `serverlens.sshConfigPath` is read only from your local user settings (also in Remote-SSH/WSL/container windows), never from a workspace or remote settings, and is not synced; the path is trimmed and `~` is expanded the same way for parsing and for `ssh -F`.
- Activation no longer fails when settings.json has unsaved edits or a list setting has the wrong type.
- New name, publisher, icons, settings/command prefix (`serverlens.*`); settings are copied once from `gpu-fleet-viewer.*`.

### Removed
- AI assistant, task tracing and GPU release reminders (and the `markdown-it` dependency).
- The `xml2js` dependency (the XML parsing path was only used by tests). ServerLens has no runtime dependencies.
- The workflow that published to the Marketplace on every push to `main`.

---

GPU Fleet Viewer history (upstream, before the fork):

## 1.4.3 - 2026-10-19

- Replace the authorization sidebar with separate conversations: new, switch, rename and delete, with isolated context, drafts, task scope and permission mode.
- Move permissions beside the input: confirm each file read, or Full Access for automatic reading of discovered task files through existing read-only tools; remove stored per-file grants.
- Cancel pending automatic reads when returning to confirmation mode, invalidate approvals when switching chats, and preserve interrupted work in its original conversation.
- Offer optional local conversation-text history, disabled by default; omit tool evidence and permissions, restore with confirmation required, and clear all panel copies when disabled.
- Preserve prefilled GPU questions on first opening and keep dashboard and server-panel chat storage separate.

## 1.4.2 - 2026-10-19

- Let the model explore observed task directories and open-file/path metadata, then request authorized head/tail text from actual files, without filename templates or question routing rules.
- Remove fixed-format progress extraction; send raw task evidence for model interpretation. Retain exact-file approval, read-only operations and sensitive-path protection.
- Retry non-streaming requests with tools before plain-chat fallback; explicitly show when the API/model cannot support investigation tools.
- Automatically collapse completed operation records after the final answer, with manual re-opening; distinguish user inputs, assistant answers and failures using restrained message styling.
- Share one SSH concurrency budget across dashboards, assistant queries and reminders; coalesce matching snapshots, reuse very recent data, and back off failed automatic queries while preserving immediate manual retries.
- Reorganize the dashboard header, actionable availability/warning summaries, search and compact filters; move language into settings and standardize the product name as GPU Fleet.
- Distinguish task details from the main dashboard and replace the extension, sidebar and dashboard marks with one simplified chip symbol.

## 1.4.1 - 2026-10-19

- Show actual AI connection, waiting, response and tool stages inline with elapsed time and expandable evidence.
- Replace log authorization dialogs with exact-file inline allow-once, remember and decline actions that automatically resume the pending query.
- Preserve safe network error codes, request phases and redacted HTTP diagnostics; retain pending work for retry, including cancellation during authorization.
- Default to unlimited tool calls, with an optional user budget and continuation; expand question, context, response, timeout and configurable log-read capacities.
- Compact old tool groups without breaking protocol pairs and bound displayed activity details so long investigations can keep running.
- Move GPU/task details into a right sidebar or narrow-window drawer, retaining selection and scroll through refreshes, with Escape and focus restoration.

## 1.4.0 - 2026-10-19

- Kept the dashboard and rebuilt AI as a compact chat dialog with a task/context sidebar, safe Markdown tables/code, streaming, cancellation, keyboard input and query evidence.
- Added native OpenAI/Anthropic tool turns for fresh GPU status, parent-process tracing, bounded host diagnosis, Slurm details/accounting and explicitly authorized task-log tails.
- Required local desktop extension execution so SSH uses the local network, SSH configuration, agent and jump hosts, including in remote workspaces.
- Added evidence-based progress/phase ETA and explicit unknown states; no arbitrary shell, task termination, remote writes or automatic training changes.
- Added persistent GPU release, verified task-end and scheduled reminders, independent of dashboard visibility, with deadlines and cancellation.
- Added per-server GPU visibility settings and consistent dashboard/statistics/AI scope, individual notification events, section resets, dependent controls and unsaved-change protection.
- Replaced the narrow process table with a selectable task list, readable commands, parent-process evidence and direct assistant/reminder actions.

## 1.3.0 - 2026-10-19

- Fixed dashboard flicker and jumping by preserving server, GPU, and process DOM nodes, keyboard focus, and inspector scroll during progressive refreshes.
- Preserved refresh progress while filtering, stopped opening the dashboard on extension activation, and reused fresh snapshots when returning to a panel.
- Added memory/card-count resource filters, My tasks, explicit filter reset, and retained filter/selection state across Webview reloads.
- Added grouped in-dashboard settings with validation, explicit saves, preserved unsaved edits, and batched refreshes.
- Refined dense layouts with neutral surfaces, semantic colors, readable metrics, and licensed Lucide line icons.
- Added optional OpenAI-compatible and Anthropic AI question answering with endpoint-scoped SecretStorage keys, previewed opt-in context, cancellation, and in-memory conversation history.
- Fixed shared SSH alias options, wildcard/Match block isolation, quoted/commented config values, and use of custom SSH config files for monitoring.
- Added automatic Marketplace publication for new stable versions merged into main, with matching GitHub releases and retry support.

## 1.2.0 - 2026-08-03

- Added persistent English and Simplified Chinese dashboard switching with independently managed locale files and locale parity checks.
- Reworked refresh scheduling to keep cached data visible, publish host results progressively, coalesce repeated requests, and wait until a refresh completes before scheduling the next automatic cycle.
- Prevented visual, language, threshold, favorite, and server-metadata changes from triggering unnecessary SSH queries.
- Added session-level snapshot reuse and removed the redundant health retry after a failed snapshot query.
- Added visual utilization meters for fleet summaries, GPU metrics, host memory, and disk usage while retaining exact numeric values.
- Moved unreachable servers into a collapsed, neutral unavailable-server section that expands for offline filtering and matching searches.
- Added tag-driven GitHub Actions automation for Marketplace publishing, VSIX artifacts, and GitHub Releases.

## 1.1.0 - 2026-08-01

- Reframed the dashboard around the daily research workflow: find a GPU, understand its owner and job, and enter a prepared SSH environment.
- Added configurable, explainable availability rules based on compute processes, used memory, and utilization.
- Added fleet search, status filters, GPU sorting, active-user aggregation, and an available-GPU Quick Pick command.
- Added full process commands, runtimes, copy actions, and best-effort Slurm job association.
- Added safe research terminals that prepare UUID-based `CUDA_VISIBLE_DEVICES` commands without executing them.
- Added lightweight CPU load, host memory, root disk, uptime, SSH latency, stale-data timestamps, and categorized connection errors.
- Added local aliases, groups, favorites, and duplicate physical-host detection with aggregate de-duplication.
- Added server and GPU state notifications with event selection and cooldown controls.
- Improved performance with bounded SSH concurrency, hidden-dashboard pausing, low-frequency Slurm caching, duplicate-host query suppression, and client-side filtering.
- Expanded parser, availability, aggregation, duplicate-host, responsive Webview, filter, and inspector tests.

## 1.0.0 - 2026-08-01

- Published GPU Fleet Viewer on the Visual Studio Marketplace as `yruichen.gpu-fleet-viewer`.
- Introduced the GPU Fleet Viewer name and a consistent extension namespace.
- Added automatic migration of settings from the legacy `gpu-server-viewer` namespace.
- Redesigned the dashboard around a fleet summary, server bands, and a responsive GPU matrix.
- Added utilization, memory, temperature, power, fan, and process-owner metrics.
- Added a full-width process inspector without changing GPU tile heights.
- Replaced slow XML collection with focused CSV queries.
- Added argument-safe SSH execution, batch authentication, timeouts, refresh locking, and friendly errors.
- Added configurable metrics, warning thresholds, alerts, server visibility, and status-bar summaries.
- Added parser, monitor, preview, and Webview interaction checks.

## Upstream history

This release is based on [Riku-0801/gpu-server-observer](https://github.com/Riku-0801/gpu-server-observer). See [NOTICE](NOTICE).
