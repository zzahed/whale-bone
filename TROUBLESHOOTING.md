## Whale Bone: apply and generation settings

- If a proposed change was applied but the final file is not visible, click **Open final file** in Chat. Applying changes now attempts to close only its specific review comparison and focuses the saved workspace file. An error focusing the editor does not reverse an already saved file.
- Find Python pip under **Settings → Python & pip**, not under Files.
- The **Model & generation** settings allow output caps through 262,144 tokens and context estimates through 2,097,152 tokens. These are client-side configuration ceilings, not promises about your API provider. Use **Use maximum for selected model** to load supported metadata or documented gpt-oss architecture limits. If the API rejects a limit, lower it to the actual deployment-supported value.
- High output limits may increase latency or costs. The agent reserves space for system instructions and computes a per-request maximum based on estimated input size; actual provider tokenization may differ.

# Whale Bone: Offline troubleshooting

Whale Bone is a self-contained VS Code extension, not the OpenCode or Continue application. No additional coding agent, Node/npm, administrator permissions, or external installation is required for Whale Bone itself. You need an existing VS Code installation, Windows PowerShell, a working network connection to your configured API endpoint, and an API key. Python execution requires a separately installed Python interpreter.

## Usability and recovery

- **Settings tab blank or model URL invalid:** The sidebar now displays the last saved settings with a configuration-error banner. Correct the invalid value and select **Save settings**. The API URL must be HTTPS and end with `/v1`.
- **Workspace switching refused:** Finish or cancel the active AI request first. The extension preserves pending diffs and conversation history during the refusal.
- **Search says incomplete:** Some files were oversized, binary, unreadable or excluded by a scan budget. Narrow the directory or ask for an exact path. The repository worker keeps VS Code responsive but cannot guarantee exhaustive searching on every network share.
- **CI shows PARTIAL REVIEW:** Eligible changed files were reviewed, but deletions or excluded changes also need manual review. **SKIPPED** and **PARTIAL PASS** are not a full AI PASS and are never authoritative merge gates.
- **AI operation reaches its time limit:** Narrow the request or attach a specific file. Staged source diffs remain available for review, and no source file is changed without approval.
- **Linux SSH/WSL extension host:** Whale Bone requires local Windows PowerShell for its unchanged API transport. Run it in a supported Windows workspace host; remote Linux workspaces are not supported.

## Find errors and run checks

1. Open the **Whale Bone** Activity Bar icon. Open **Settings > Troubleshoot / Self-check**, or press Ctrl+Shift+P and run **Whale Bone: Troubleshoot and Self-Check**.
2. Choose **Run local self-check**. It checks settings, workspace trust, presence of a API key, and Windows PowerShell without making network calls.
3. Choose **Open Whale Bone logs**, or select **View > Output > Whale Bone**. Logs omit prompt contents and do not intentionally include API keys. Review before sharing logs.
4. Choose **Test API connection** to explicitly request the approved `/v1/models` endpoint. This confirms the gateway path but does not prove code-edit tool behavior.
5. Try a simple **Ask**, then a small **Build** proposal in a disposable workspace. Inspect the diff, press **Apply**, and confirm the change.

## Error reference

| Symptom | Interpretation and first action |
|---|---|
| HTTP 401 | API key missing, expired, or authentication mode is incorrect. Set API key in Whale Bone Settings. |
| HTTP 403 | Endpoint or account access denied. Check approved corporate network policy with IT. |
| HTTP 407 | Enterprise proxy authentication failed. Check Windows sign-in and approved proxy configuration with IT. |
| HTTP 429 | Gateway quota or rate limit. Reduce concurrency or ask the API administrator. |
| TLS / certificate error | Windows does not trust the inspected endpoint or there is a gateway error. Ask IT to verify trusted certificates; do not disable TLS verification. |
| Timeout | Network or model response slow. Check status and timeout setting; inspect the allowed enterprise network path. |
| Build returns prose but no diff | Model did not return a valid edit action. Ask for a smaller targeted change. Inspect the selected model and output-token limit. |
| Diff displays plaintext instead of Python | Inline Edit now highlights the current `.py` editor in place. Optional detailed diff uses `.py` virtual documents. Check that VS Code recognizes Python language mode. |
| No workspace selected | Use **Choose Workspace**, then open a file in that workspace. An active file elsewhere is not attached. |
| Apply is refused | You must open **View Diff**, the file must be unchanged since staging, and your VS Code workspace must be trusted. |
| Python commands not found | The Microsoft Python extension does not install Python itself. Configure a locally installed interpreter. Companion language services may not be available without separate offline packages. |

## Editor quick edit and native Chat

- Select the exact code in an open `.py` file, press **Ctrl+Alt+Shift+I**, and enter a targeted instruction. Whale Bone highlights the proposal in the SAME editor. Hover the selection to see proposed text and click CodeLens **Accept** / **Reject**, or choose **Review detailed diff**. Accept edits only those characters and leaves the file unsaved for you to save. No duplicate source file is created.
- In supported native VS Code Chat, use `@whalebone` for read-only workspace questions. The direct API model provider is deliberately disabled because Chat attachments may bypass protected-file filtering. Use Whale Bone Inline Edit or sidebar Build for reviewed edits.
- VS Code's built-in Ctrl+I inline chat remains managed by VS Code. The Whale Bone quick-edit prompt is a separate, supported editor command, not a replacement for that built-in inline-chat UI.

## Corporate network settings

- API URL: your HTTPS OpenAI-compatible endpoint ending `/v1` (no default).
- **Use a proxy** (`whaleBone.proxyEnabled`): when off, requests go direct and the Windows system proxy is ignored.
- Proxy address (`whaleBone.proxyUrl`): `host:port`; leave empty to use the Windows system proxy.
- Proxy authentication (`whaleBone.proxyAuth`): `computer` uses the signed-in Windows account (NTLM/Kerberos); `user` uses `whaleBone.proxyUsername` (`user` or `DOMAIN\user`) and the password from **Whale Bone: Set Proxy Password**; `none` sends no proxy credentials.
- User-Agent (`whaleBone.userAgent`) is editable in Settings.
- The PowerShell request implementation is unchanged; it only receives the extra proxy options on stdin.

If network testing is restricted on your machine, use local self-checks and ask IT to approve the required endpoints. Do not attempt to bypass enterprise controls.

## Programming commands

- **No Whale Bone lightbulb action:** First select the matching workspace in Whale Bone, trust it, and authorize sending workspace data to API using the sidebar. Lightbulbs only appear for permitted files in that workspace. The source file must also have a VS Code diagnostic (a squiggled error/warning); check the Problems panel and confirm the Python/JavaScript language extension is active.
- **Generated tests not offered:** Open a `.py`, `.js` or `.ts` file inside the selected workspace and save it first. The command only proposes a test file and does not install Python or Node.
- **Code review cannot find a file:** Open the file from the selected workspace and ensure it is saved and not a protected path. Check the Files tab's workspace selector.
- **No diff after fix:** The model may answer in prose or propose an edit that fails validation. Open Output > Whale Bone and use a more specific request. No file is written without a valid diff and explicit approval.

## Operational safeguards

- **Unsaved editor changes:** Inline Edit works on the current unsaved buffer and checks editor version before Apply. Propose Fix still offers **Save and continue**. Declining leaves the editor unchanged and makes no API request. Existing pending diff proposals are not deleted by a subsequent question.
- **Sidebar hidden or closed:** Results are retained in memory and replayed when Whale Bone reopens. Failures also appear as native VS Code error notifications. If no panel is visible, use **Whale Bone: Open Chat** and check **Output > Whale Bone**.
- **No lightbulb:** Activation occurs on startup completion, but actions only appear after you consent to API transfers for the selected trusted workspace. Verify Problems diagnostics are present.
- **Unexpected test filename:** Python `unittest` tests use `test_<source>_<hash>.py` in the workspace root by default; if `tests/__init__.py` exists, they go into `tests/`. This keeps them discoverable by `python -m unittest discover` on Python 3.11+. JavaScript and TypeScript test files use `tests/whalebone/`. Existing and pending test targets are never overwritten.
- **Keyboard conflict:** Use Ctrl+Alt+Shift+I or right-click **Whale Bone: Inline Edit**. Ctrl+Alt+I is not bound by Whale Bone.
- **First-open sidebar warning:** Whale Bone waits briefly for the sidebar to initialize; if it remains unavailable, open the Whale Bone Activity Bar icon and check Output > Whale Bone.
- **Propose fix did not open a diff:** An existing pending proposal for the same file may block a new one. Review or reject the older proposal first; Whale Bone will no longer open an old diff as if it were newly generated.
- **Tests not discovered:** Accept the generated Python diff, then run `python -m unittest discover -v` from the workspace root. The extension does not run tests automatically. If an existing project customizes unittest discovery, use that project's documented test command.
- **Unsupported source file:** Test generation supports `.py`, `.js`, and `.ts`, not `.pyi`, `.mjs`, or `.mts`. Right-click menu entries are filtered by extension; Files tab requests show an explicit error.
- **Direct model-picker option missing:** Intentional. `@whalebone` remains supported where VS Code Chat Participant API is available.

## External API connector scripts

- **No file appears in Ask mode:** Ask prints the PowerShell connector script in Chat. Choose **Build** or **Files → Generate external API script** to create a reviewable `.ps1` proposal in `tools/`.
- **Brave reports 401/403:** confirm an active Brave Search API key and the `BRAVE_API_KEY` environment variable in the same PowerShell session. Do not paste secrets into logs. An approved API key is not interchangeable with a Brave token.
- **Proxy returns 407/403:** the generated script uses your configured proxy and authentication (computer credentials, or a run-time credential prompt for user authentication). External vendor domains can be blocked independently of your AI endpoint; request approval from corporate IT. Do not bypass proxy or certificate policy.
- **Unknown providers:** the generic script is not ready to execute. Replace marked endpoint/authentication placeholders with information from official provider documentation; confirm HTTP method and request parameters.
- **Lightbulb absent before first message:** use **Files → Authorize workspace for API**. Authorizing does not make network calls and only enables prompts under the existing data-transfer consent policy.
- **Python pytest tests missing:** ensure the selected project has valid pytest settings (`testpaths`) and the generated file is in that directory. For standard-library unittest, Python 3.11 requires regular package directories for nested discovery. Whale Bone does not execute tests automatically.

## API connector versus ordinary coding requests

To request a deterministic, locally generated PowerShell scaffold, type `/connector Brave` or choose **Files → Generate external API script**. Normal prompts mentioning an API, including Python, JavaScript, repository fixes, and integration tasks, go to API unchanged. If a generated template needs a provider-specific endpoint or authentication details, consult the provider’s official documentation. Whale Bone does not run the generated script.

## Selection-focused editing and corrupted characters

- **AI explains more than the selection:** Use the explicit **Explain selection** action or click **@ Selection** in the Whale Bone composer. The badge must show **Selection ON**. This restricts API input to exactly the captured character range and blocks repository tools in that request. Clear the scope to return to general chat.
- **Inline editing asks for file selection:** It should not. Open an existing workspace file, highlight the code, then press **Ctrl+Alt+Shift+I**. The active file's workspace is selected automatically. Do not use **Generate unit tests**, which intentionally creates a new test file, if your goal is changing the current file.
- **CodeLens controls not visible:** Ensure **Editor: Code Lens** is enabled in VS Code settings. Hover the highlighted code to inspect the suggestion. Re-run Inline Edit only after accepting or rejecting an existing proposal.
- **Editor changed:** If you type while the request is running, Whale Bone rejects stale proposals rather than replacing unexpected text. Select the current code and retry. A rejected proposal does not write anything.
- **Garbled glyphs such as `â`, `â`, `Ù`:** Common reversible mojibake sequences are repaired in answers. Inline edits with clear signs of corruption are refused. Single ambiguous UTF-8-looking literals such as `Ã©` are preserved, so manually verify the returned source. The unchanged transport may still corrupt other response patterns, so do not apply multilingual source changes until the diff is verified on Windows.

## Whale Bone: editor editing, autocomplete, tests and CI

**Cursor insertion:** Place the cursor without selecting text, press Ctrl+Alt+Shift+I, and describe the code to insert. The model receives a bounded region around the cursor, not the whole file. Use CodeLens Accept / Reject / Retry. Nothing is saved automatically. If the file changes before Accept, the stale suggestion is refused.

**Retry a suggestion:** Keep the original editor open, click the CodeLens **Retry suggestion**, and provide a more precise prompt. The old proposed text remains available if the retry fails. If the CodeLens is missing, check VS Code **Editor: Code Lens** (`editor.codeLens`).

**Tab autocomplete absent:** This is OFF by default. Use the **Whale Bone: Toggle Tab Autocomplete** command, Files tab button or status bar. The active file must be allowed, the workspace trusted, data transfer consent recorded, and a API key already configured. Autocomplete never prompts for credentials while typing. If the proxy is slow, suggestions can arrive after the cursor changes and are discarded. The default debounce is 750 ms and a minimum request gap protects the corporate proxy. Check `editor.inlineSuggest.enabled` in VS Code if the provider is working but ghost text does not display.

**Approved test commands unavailable:** The default policy is read-only. Use **Whale Bone: Toggle Approved Test Tools** to enable *approved-tests* for the current VS Code configuration. Each proposed test run triggers a new modal approval. Project test scripts are executable code and may send their output to API, so authorize only trusted projects. Commands are strictly allowlisted, no shell execution is allowed. On Windows, `npm` scripts are not run through `.cmd` wrappers; prefer `node --test` or Python tests where available.

**CI checks report no rules:** Copy `examples/whalebone-checks/code-quality.md` to the target repository's `.whalebone/checks/` directory and commit it. See `CI-CHECKS.md` for the separate Windows runner, Git base revision, API secret and error exit codes. The sample CI workflow is NOT automatically enabled.

**Repository rules ignored:** Put a valid UTF-8 `.whalebone/rules.md` in the approved workspace. It is read as untrusted context for general Agent requests; exact-selection editor edits intentionally do not read other repository files or rules.

**Slow model response or autocomplete:** API requests still use the original non-streaming PowerShell transport. Each suggestion may incur network/proxy overhead. Disable autocomplete during high latency or restricted network conditions; this release does not modify transport encoding, streaming, or TLS behavior.

### Troubleshooting approved test execution and CI reviews

If **Build stops after a test request**, note that disabled or refused runs return a tool error to the agent so it can continue. Enable approved test tools deliberately only when needed. The interpreter must be installed outside the current workspace and resolvable from system PATH.

If tests exceed the timeout, adjust **Whale Bone: Agent Test Timeout Seconds** (10–600, default 180). The extension attempts process-tree termination, but test execution is not sandboxed and OS-level child cleanup is not guaranteed. Check Task Manager if a runner fails to exit.

If CI says **SKIPPED (not PASS)**, the eligible diff exceeds 30 KB; no AI judgment was made. Do not interpret a skipped check as code approval. AI checks are advisory and must not replace deterministic merge controls.

When editing in a VS Code multi-root workspace, Inline Edit operates on the active editor's own root without resetting the selected Chat workspace or pending Build edits. Explicitly switch Chat workspace only through the Choose Workspace control.

### Inline Edit and CI reviews

- **Invalid argument before the first AI call:** Use **Whale Bone: Troubleshoot and Self-Check** if issues persist.
- **Repeated approval dialogs for tests:** A denied test run is remembered for the current Build request and is not re-prompted. Unsupported command arguments produce a tool error and the AI may continue to propose edits without running tests.
- **Autocomplete too frequent:** Automatic trigger kind `1` respects the request gap; explicit Invoke kind `0` is exempt. Suggestions remain off by default and require trust/consent.
- **CI SKIPPED due to file count:** More than 24 eligible changes or a diff larger than 30 KB is reported SKIPPED (not PASS). Reduce the review scope and rely on human and deterministic CI for merge decisions.
- **CI ambiguous base ref:** `origin/main` is now rejected. Pass the trusted base SHA or `refs/remotes/origin/main`. The sample GitHub Actions workflow uses `${{ github.event.pull_request.base.sha }}`.

### Destination, selection, indexing and optional Python

- **Endpoint error:** In Whale Bone Settings, save an HTTPS URL ending `/v1`. An API key is never reused for another destination. On the first request, authorize the URL shown in the consent dialog.
- **Native `/selection`:** Highlight code in the active trusted editor before entering `@whalebone /selection`. This command does not use general repository tools.
- **Repository results incomplete:** If a search or listing reports `truncated` or `nextCursor`, narrow the query or request the next page. Never infer absence from an incomplete scan.
- **Python without Pylance/debugpy:** See `PYTHON-OFFLINE.md`. Whale Bone does not bundle all Python language companions or the interpreter.
- **CI deleted files:** `SKIPPED (not PASS)` means deletion review requires another check or a person.
- **Redirect limitation:** The PowerShell transport has not been changed. Any redirect behavior must be verified separately if using an untrusted or unapproved destination.

### Python package says “from versions: none” through the authenticated relay

Do not infer that the Python package/version is unavailable. Check **Whale Bone → Files → Python Packages → Test package index via proxy** using the same package name. The dedicated Python Packages Output channel reports upstream HTTP errors and unexpected proxy sign-in pages. `pip` requests use `127.0.0.1` locally, but the extension separately downloads PyPI metadata through the authenticated enterprise proxy. The selected Python architecture, wheel tags, and network access must all be checked independently.


## Python package installation: zero local relay requests

A pip error saying `from versions: none` along with `received 0 relay requests` is **not** proof of an unavailable PyPI version. The installed Python executable might be routing its localhost traffic through the corporate proxy, blocked by endpoint protection, or configured to use another index.

Whale Bone sets loopback `NO_PROXY` and performs an interpreter-level direct access preflight. Use **Manage Python Packages → Test Python localhost relay** to confirm the selected executable can connect to the temporary local server without contacting PyPI. Next use **Test package index via proxy** and **Download wheels for offline use**. For Windows Python 3.13, `Cython==3.3.1` has an official compatible wheel on public PyPI.

A `package.json` SchemaStore HTTP 403 is a separate editor schema-download warning. It is normally caused by corporate internet filtering, not the Python package manager.


## Whale Bone: pip configuration and source-secret protection

The Python package manager now supplies `PIP_CONFIG_FILE` set to the Python OS null device (`nul` on Windows), plus `--proxy=` for managed pip commands. This isolates the localhost relay from administrator-defined pip `proxy`, `no-index`, `extra-index-url`, and `find-links`. It does **not** modify the Windows corporate proxy or the authenticated PowerShell download helper. Retry installation in a workspace `.venv` after installing the updated VSIX and reloading VS Code. If the Python localhost preflight succeeds but pip still sends zero requests, inspect endpoint controls and pip startup diagnostics rather than changing the upstream proxy.

AI context redaction is strengthened for common credential assignments, inline objects, XML application settings and diff lines. It is best-effort and must not replace human review before sending source files to the model.

## Security and CI review

the project release notes documents the corrected AI context redaction paths, conservative autocomplete behavior near secrets, protected requirements files, and CI fail-closed handling. If a CI run reports `PARTIAL REVIEW` or `SKIPPED (not PASS)` due to omitted, deleted, oversize, protected, or non-UTF-8 changes, the runner exits nonzero. Fix review coverage or complete the required manual review rather than interpreting partial results as an approval.

Secret masking is still a best-effort heuristic, not a substitute for a corporate DLP solution. Keep workspace/source scopes narrow and do not deliberately paste credentials into prompts. The unchanged transport is still subject to real corporate Windows acceptance testing.


### Python package wheel: localhost ReadTimeoutError

A `ReadTimeoutError` for `http://127.0.0.1:<port>/files/...whl` indicates that the selected Python contacted Whale Bone's local package index but did not receive wheel bytes before pip's read timeout. The relay may still be downloading/scanning the wheel through the corporate NTLM proxy. This differs from `received 0 relay requests`. Pip's read timeout is 600 seconds, upstream retrieval has an 8-minute total deadline with transient retries, and relay progress is shown in `Output → Whale Bone: Python Packages`. Inspect the last `[PyPI relay]` message and distinguish a corporate proxy stall, HTTP 403/407 policy rejection, or a completed wheel transfer. The Python package name and version do not need to be changed solely because localhost timed out.
