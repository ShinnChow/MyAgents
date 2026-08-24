# Windows AI Review Traps

> Purpose: a living adversarial-review checklist for MyAgents changes that are developed mostly on macOS but must work on Windows.
>
> This is not a generic Windows compatibility guide and not a release-note archive. Each entry is a recurring failure pattern that AI agents are likely to miss, backed by issues or fixes this repo has already hit, and phrased as review pressure to apply before Windows users rediscover it.

## How To Use This Document

Read this when a change touches any boundary that behaves differently on Windows:

- process spawn, CLI wrappers, shell commands, PowerShell, npm/npx, Git Bash, runtime binaries
- byte/text decoding, JSON/config files, logs, localized command output
- workspace paths, resource paths, URLs made from paths, custom protocols, symlinks/junctions
- WebView2 rendering, CSP, iframe/srcdoc widgets, child webviews, scrollbars, attachments
- config/session/task persistence, updates, file replacement, fsync, install metadata
- runtime detection, PATH/proxy/env injection, managed runtime packaging or signing

Review rule: do not ask "does this work on my Mac?". Ask "which Windows boundary did this cross, and what existing MyAgents owner already normalizes that boundary?" If no owner/helper exists, add one close to the boundary instead of sprinkling call-site guards.

## Evidence Sources

These are representative incidents that shaped the patterns below:

| Pattern | Evidence |
|---|---|
| PowerShell / localized output is not stable UTF-8 | `managed-codex` Authenticode install failure: `Authenticode output is not UTF-8`; commit `f5edd8eb` hardened publishing; current client-side fix base64-wraps Authenticode JSON |
| SDK/tool subprocess output can be non-UTF-8 | `cc580bf9 fix(windows): force utf-8 sdk shell output`; `windows_platform.md` SDK shell output encoding section |
| UTF-8 BOM from Windows editors breaks config parsing | `CHANGELOG.md` entries for issue #170 and Windows config crash; `src/shared/utils.ts` BOM stripping |
| Workspace path identity mismatch silently breaks features | #320 / `d7d431d2`; `src/shared/workspacePath.ts`; `pit_of_success.md` workspace path section |
| Archive paths accidentally serialized with OS separators | Managed Codex Windows install wrote `executableRelativePath` as `vendor\\...`; status reads rejected it as an archive path and preserved stale `downloading` at 100% |
| File URLs are not paths with a prefix | Plugin local install parsed `file:///C:/...` via `new URL().pathname`, which becomes `/C:/...`; on Windows `resolve()` turns that into `C:\C:\...` |
| `\\?\` long-path prefix breaks non-Rust consumers | `pit_of_success.md::normalize_external_path`; #229 stripped `\\?\` from bundled Node path in `myagents.cmd` |
| Windows shell quoting drops CLI content | issue #149; `src/cli/myagents.ts` requires `--content-file` / `--prompt-file` for fragile payloads |
| GUI process spawn flashes or hangs through console wrappers | issue #170; `process_cmd::new`; `ed9c341c`, `1bb503db`, `bcb1a04e` |
| WebView2 applies CSP/resource rules differently from macOS | `windows_cross_platform_review.md`; `798e59b8` custom protocol URL fix; widget Chart.js inline injection |
| AV / indexer transient locks break writes | `windows_platform.md::cmd_fsync_path`; `CHANGELOG.md` Windows access denied / OneDrive / Backblaze entries |
| Health checks and updates race harder on Windows | #236 global sidecar false restart; #232 durable open-tabs restore across Windows NSIS restart; `auto_update.md` cache=disk invariant |

## Trap 1: Treating Process Output As UTF-8 Text

**Why AI misses it.** On macOS, command output is usually UTF-8. AI code often writes `String::from_utf8(stdout)` or `JSON.parse(result.stdout)` after a subprocess returns JSON. On Windows, PowerShell 5.1, console code pages, localized status messages, and third-party tools can produce bytes that are not UTF-8 even when the script itself was passed as UTF-16LE via `-EncodedCommand`.

**Real failures.**

- Managed Codex download succeeded, but install failed while verifying `codex.exe` Authenticode because PowerShell emitted localized JSON in a non-UTF-8 encoding. The fix is to make PowerShell produce base64 of UTF-8 JSON and have Rust/Node decode the base64 payload.
- Claude Agent SDK Bash tool output on Windows needed explicit `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, and a Git Bash `chcp.com 65001` prelude.
- Windows Notepad and other editors can save UTF-8 JSON with BOM; config readers must strip leading BOM before JSON parse.

**Review pressure.**

- Is this stdout/stderr meant for machine parsing? If yes, do not rely on ambient console encoding.
- If the producer is PowerShell, emit one ASCII-safe envelope: base64(UTF-8(JSON)).
- If the producer is a shell command whose output enters session history/SSE, set the subprocess env before the output is generated. Do not try to repair already-decoded tool-result strings in the renderer.
- If reading user-editable JSON/config/text, strip a leading UTF-8 BOM at the file boundary.
- Preserve non-UTF-8 diagnostic output with `String::from_utf8_lossy` only for human-readable error messages, not structured protocol.

**Smells.**

- `String::from_utf8(output.stdout)` near `powershell`, `cmd`, `Get-*`, `signtool`, `npm`, or other Windows-facing commands.
- `JSON.parse(result.stdout.trim())` after a PowerShell script.
- Encoding fixes in UI rendering code instead of at the process/file boundary.

## Trap 2: Assuming Path Strings Have One Identity

**Why AI misses it.** macOS paths are usually POSIX, case-sensitive enough for developer mental models, and use `/`. Windows paths can arrive as `C:\...`, `C:/...`, `c:/...`, UNC paths, paths with trailing separators, or extended-length `\\?\` paths. Different stores in MyAgents legitimately persist different forms.

**Real failures.**

- Managed Codex Windows download installed successfully, but `installed.json` stored `executableRelativePath` with backslashes from `PathBuf::to_string_lossy()`. The status reader validates that field as an archive-relative path, failed to locate the nested `vendor/.../codex.exe`, and preserved the stale 100% `downloading` state.
- Plugin local install accepted `file://` sources, but parsing with `new URL(...).pathname` produced `/C:/...` for Windows drive URLs and could resolve to `C:\C:\...`. The fix is to use Node's `fileURLToPath` and `pathToFileURL` helpers at the URL boundary.

- #320: legacy cron/task/session/project lookups could not find the owning workspace because one store used backslashes and another used forward slashes. This caused "找不到工作区", empty recent sessions, task cards without workspace names, and invalid workspace filters.
- `\\?\` paths from Tauri/Rust resource discovery work with Rust `fs`, but break Node file URLs, npm, CLI wrappers, and spawned programs.
- Windows non-system drive paths previously hit path safety allowlist mistakes for "open with default" / "show in explorer".

**Review pressure.**

- Is a `Project.path` compared with `Task.workspacePath`, `CronTask.workspacePath`, session `agentDir`, or `defaultWorkspacePath`? Use `workspacePathsEqual`.
- Is a path used as a Map/Set key? Normalize with `normalizeWorkspacePathIdentity` at both build and lookup.
- Is a path from a ZIP/manifest/archive key persisted to JSON? Store the normalized archive key with `/`, not `PathBuf::to_string_lossy()`. If legacy installed metadata already contains backslashes, accept it only at the installed-metadata read boundary, not in manifest validation.
- Is a filesystem path crossing a `file://` URL boundary? Use `pathToFileURL` / `fileURLToPath` instead of `new URL(...).pathname`, ``file://${path}``, or manual slash replacement.
- Is a Rust `PathBuf` crossing into Node, npm, URL, shell args, config JSON, or a child process? Strip `\\?\` via `normalize_external_path` at the boundary. Do not mutate pure path-format helpers to guess callers.
- Is code deriving a filesystem fact such as available bytes? Query the existing target path through `filesystem_capacity::available_space`; path normalization and mount-prefix matching do not own filesystem identity.
- Is the code using canonicalize before write? For paths that may not exist yet, use the lexical write-side resolver, not read-side canonicalization.
- Are symlinks/junctions involved? Directory tests need the repo's junction-aware helpers, not only `Dirent.isDirectory()`.

**Smells.**

- Raw `===` path comparison outside same-owner in-memory tree nodes.
- Inline `.replace(/\\/g, '/')` as a "quick fix".
- `new URL(fileUrl).pathname`, ``file://${path}``, or ``file:///${path.replace(/\\/g, '/')}`` around local paths.
- `PathBuf::to_string_lossy()` used to serialize archive members, manifest paths, or installed metadata.
- `PathBuf::to_string_lossy()` immediately passed to Node/npm/URL/spawn without boundary normalization.
- `sysinfo::Disks` / mount enumeration followed by `path.starts_with(mount_point)` to decide target capacity.

## Trap 3: Shell Quoting And `.cmd` Wrappers Are Not Portable Protocols

**Why AI misses it.** AI-generated commands often work in zsh/bash and look escaped enough. On Windows, MyAgents may pass through Git Bash, `cmd.exe`, `.cmd` shims, npm wrappers, PowerShell, and Node argv parsing. Each layer has different quoting and newline behavior.

**Real failures.**

- issue #149: `myagents thought create '<text>'` sometimes arrived without content on Windows, producing a server-side 422. The durable workaround is `--content-file`.
- `myagents session send -p` rejects multiline or large inline prompts because `cmd.exe` can treat newline as a command boundary and drop subsequent flags.
- `.cmd` shim args needed explicit escaping; npm/npx on Windows often require wrapper-aware spawn resolution.
- Codex TOML config args with quotes previously caused external runtime startup issues.

**Review pressure.**

- For user/AI-generated long text, multiline text, JSON, prompts, or shell-sensitive characters: prefer file handoff (`--prompt-file`, `--content-file`, temp file) over inline flags.
- Do not construct shell command strings when `Command` / `spawn` can pass an argv array.
- If invoking `npm`/`npx` on Windows from Node, use the repo's spawn invocation resolver so `.cmd` and bundled Node layouts are handled intentionally.
- If invoking tools from Rust GUI code, use `process_cmd::new` and `system_binary::find` where appropriate.
- Test the parse boundary with Windows-like argv cases, not only POSIX shell strings.

**Smells.**

- `shell: true` added only to "make Windows work" without a quoting test.
- New CLI flags that accept arbitrary text but no `--*-file` escape hatch.
- String-built command lines that include user text, TOML, JSON, paths with spaces, or quotes.

## Trap 4: Spawning Processes As If Tauri Were A Terminal

**Why AI misses it.** On macOS dev machines, GUI and terminal often share enough PATH/env that a child process works. On Windows, a Tauri GUI app is not an interactive terminal: PATH differs, console windows can flash, proxies can poison localhost, and process trees can be hidden behind shell wrappers.

**Real failures.**

- Raw process spawn from GUI caused black console windows.
- User-installed or MyAgents-managed CLIs were not detected because the app over-relied on shell PATH.
- Plugin/Sidecar/npm processes needed consistent proxy env and localhost bypass.
- Stale process cleanup moved to native process enumeration because ad-hoc PowerShell/WMI/pgrep approaches were slow or fragile.

**Review pressure.**

- Rust process spawn: default to `crate::process_cmd::new()`; apply `proxy_config::apply_to_subprocess` unless there is a documented reason not to.
- Binary discovery from the app: use `system_binary::find`, bundled-runtime helpers, or runtime-specific detection owners. Do not assume shell PATH.
- Preserve `NO_PROXY` / localhost exclusions when adding proxy env. A system proxy must not capture app-local HTTP.
- Do not add ad-hoc PowerShell process cleanup; use `process_cleanup` owners.
- PTY is the explicit exception: terminal PTY ownership is separate and does not use `process_cmd`.

**Smells.**

- `std::process::Command::new` in Rust app code outside known exceptions.
- `powershell` used for process enumeration, deletion, or opening paths when a native owner exists.
- New runtime detection that shells out to `where`/`which` as the only source of truth.

## Trap 5: WebView2 Is Chromium, Not A Mac WebView With Different Fonts

**Why AI misses it.** Visual changes are usually built and eyeballed on macOS. Windows runs WebView2/Chromium with different CSP behavior, scrollbar geometry, child-webview composition, custom protocol URL forms, and default font fallback.

**Real failures.**

- Tool attachments initially used loopback HTTP URLs that did not match `img-src`; Windows needed app-owned custom protocol URL shape `http://myagents.localhost/...`.
- `srcdoc` widgets that load CDN scripts can be blank under Chromium CSP inheritance. Chart.js was fixed by bundled inline injection; the pattern can recur for D3/Lucide/Mermaid-like libraries.
- Windows scrollbars consume layout width unless gutter is stabilized; macOS overlay scrollbars hide the issue.
- OS child WebView2 bounds do not participate in CSS transitions like WKWebView; one-shot geometry sampling was replaced with a reconciler after #339.
- Windows Chinese font fallback showed SimSun when the font stack missed Microsoft YaHei / YaHei UI.

**Review pressure.**

- For subresources, distinguish `connect-src`, `img-src`, `media-src`, and `script-src`. Adding loopback to `connect-src` does not make `<img>` work.
- Use `myagentsProtocol` / attachment URL helpers for app-owned resources. Do not invent `file://`, `asset://`, raw loopback, or platform-specific URL literals in components.
- If widget code injects external scripts, prefer bundled raw source + inline injection inside the sandbox over relaxing parent CSP.
- If a scroll container can cross the overflow threshold on Windows, consider `scrollbar-gutter: stable`.
- For child webviews, assume CSS transitions and OS controller geometry can desync; use existing browser bounds owners/reconcilers.

**Smells.**

- Comment says "CORS allows this image" for an `<img>` source. CSP, not CORS, is the gate.
- `http://127.0.0.1:${port}` appears in renderer media URLs.
- New `iframe srcdoc` code that depends on CDN scripts.
- UI text/font fixes only tested with Latin characters.

## Trap 6: Windows File IO Has Short, Real Contention Windows

**Why AI misses it.** macOS dev writes rarely collide with antivirus/indexers. Windows users frequently run Defender, OneDrive, enterprise backup, or search indexers that briefly open newly-written files with restrictive sharing.

**Real failures.**

- Config/project/history writes saw `拒绝访问`, `ERROR_ACCESS_DENIED`, or `ERROR_SHARING_VIOLATION` shortly after writes.
- `FlushFileBuffers` needs write access on Windows even for fsync-like semantics; Unix fsync habits do not transfer.
- Updater and installer paths can be killed or replaced while sidecars still hold files.

**Review pressure.**

- Config/session/task writes should use the existing atomic write/fsync helpers, including Windows retry/backoff behavior.
- Do not open a just-written file/directory assuming immediate exclusive availability.
- Do not treat a single transient health-check or file-open failure as proof a process or install is corrupt.
- Windows directory fsync is intentionally no-op; do not cargo-cult Unix parent-dir fsync behavior.
- Update flows need explicit cache=disk consistency: memory state must not point to bytes that are not durably on disk.

**Smells.**

- New direct `fs::rename`, `File::open`, or fsync-like code around persistent app state without checking existing config IO helpers.
- Single failed health probe triggers restart/delete/reinstall.
- Update code caches "latest" before the replacement bytes are written.

## Trap 7: Runtime Identity And Environment Drift Are Easier To Hide On Windows

**Why AI misses it.** External runtimes often work in the developer's terminal, then fail inside MyAgents because the app process has different env, PATH, proxy, HOME-like state, or runtime source. Windows makes this more visible because installed CLIs, `.cmd` wrappers, Git Bash, and enterprise proxy settings differ by launch context.

**Real failures.**

- Windows Claude Code CLI runtime lost context until system prompt / session resume handling respected Windows process behavior.
- Runtime env policy had to distinguish MyAgents proxy from terminal proxy.
- MyAgents-managed Codex provider must resolve as `runtime='codex'`, `runtimeSource='managed-provider'`, and use managed `CODEX_HOME`; mixing it with user-managed system CLI state creates confusing success/failure.
- Runtime model/session/provider identity mismatches previously surfaced as "No conversation found", wrong model, or false success.

**Review pressure.**

- Runtime/provider/session routing changes should go through `session-engine` and runtime identity helpers, not route-layer ad-hoc branches.
- External runtime process env should be produced by the runtime env owner (`env-utils`, managed runtime env, proxy policy), not copied from whichever process happens to call spawn.
- Managed provider readiness must include install status, auth method, provider gate, runtime source, and disabled state.
- CLI diagnostics should reflect the same env policy as real sessions.
- Do not use "terminal works" as proof the app works; compare effective env, PATH first segments, proxy vars, `CODEX_HOME`, and runtime source.

**Smells.**

- New code checks only `runtime === 'codex'` and ignores `runtimeSource`.
- A route handler decides builtin vs external itself instead of using `SessionEngine`.
- Managed runtime code reads or writes the user's normal CLI home without an explicit design reason.

## Trap 8: Windows Release Artifacts Need Windows-Specific Proof

**Why AI misses it.** macOS release flows can build, sign, notarize, and upload with a consistent toolchain. Windows artifacts need Authenticode, NSIS behavior, bundled `.exe`/`.cmd` resources, app-local DLLs, Git for Windows, and often a Windows host to verify facts that macOS cannot observe.

**Real failures.**

- Managed Codex Windows artifacts require Authenticode signer certificate metadata. macOS must not publish official Windows runtime artifacts by bypassing this.
- Windows portable package once used the wrong executable name and could not start.
- Windows build scripts needed Node heap tuning and rustup path/stderr hardening.
- Git for Windows and VC++ runtime packaging are release-time prerequisites, not optional local setup.

**Review pressure.**

- If a manifest says a Windows artifact is signed, verify it on Windows and persist the signer certificate SHA-256.
- If a packaging script emits machine-readable PowerShell output, use the Trap 1 base64 UTF-8 JSON envelope.
- Release checks should inspect committed artifacts/config, not just a dirty working tree that may contain local fixes.
- Build scripts should not infer Managed Codex runtime version from the desktop app version; use `src/shared/managed-codex-runtime.json::version` and derive the immutable set as `codex-<version>`.
- Windows build/test failures can be toolchain environment issues, but do not paper over them until you know whether the binary launches.

**Smells.**

- `--allow-unsigned`, `ForceRepublish`, or manifest override used to "get past" Windows signing without a documented emergency.
- Windows publish script trusts npm metadata or downloaded bytes without platform signature verification.
- A release note says Windows support was verified but no Windows-specific artifact path was exercised.

## Adversarial Review Script

Use this as a compact prompt when reviewing a PR from macOS:

1. List every new or changed boundary: process, shell, bytes, path, URL, WebView/CSP, file IO, runtime identity, update/install.
2. For each boundary, name the existing owner/helper. If there is none, explain why a new owner is required.
3. Search for the smells in this document. Treat any smell as a finding unless the diff includes a test or explicit invariant.
4. Ask whether the code would still work when:
   - paths are `C:\...`, `C:/...`, UNC, lowercase drive, trailing slash, or `\\?\...`
   - stdout contains Chinese localized text or PowerShell 5.1 chooses a legacy code page
   - text contains quotes, newlines, backslashes, JSON, or shell metacharacters
   - the app is launched from Explorer, not a terminal
   - Defender/OneDrive briefly locks a just-written file
   - WebView2 enforces CSP stricter than WKWebView
   - runtime source is `managed-provider`, not `system-cli`
5. Prefer tests that encode the boundary shape directly: Windows-style path identity tests, argv parser tests, protocol URL tests, BOM/encoding tests, and pure policy tests. If true Windows execution is required, mark it explicitly as an on-Windows smoke rather than pretending macOS CI covered it.

## When To Add A New Entry

Add a new entry only when it is a pattern likely to recur, not just a fixed bug:

- It crosses a Windows-specific boundary.
- The mistake is plausible for an AI agent or macOS-only developer to repeat.
- The repo has either a real incident, a code comment, or an invariant that proves the risk.
- The entry points to the owner/helper or explains what owner should exist.

Do not add one-off symptoms, old release notes with no future design pressure, or generic Windows advice that does not map to this codebase.
