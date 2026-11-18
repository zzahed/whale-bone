> The CLI fails closed with exit code 2 when an AI review is skipped or incomplete, including excluded/deleted changes alongside eligible changes. The example GitHub Actions workflow is still intentionally advisory through `continue-on-error: true`. Protected paths are never transmitted as raw CI diff content. Deterministic checks and human review remain authoritative.

# Optional, source-controlled AI checks

Whale Bone can run quality checks from repository-committed `.whalebone/checks/*.md` rules. Checks are evaluated against a bounded, protected-path-filtered Git diff and return a **strict JSON pass/fail** result. A failed rule exits 1. Transport, credential, parsing or incomplete-coverage results exit 2 (fail closed). Only complete passing checks exit 0. No repository files are written.

## Requirements

- An IT-approved **Windows** runner with Node.js, Git and Windows PowerShell 5.1. No npm install is needed by the checker.
- Explicit corporate authorization for transmitting source diffs from CI to the AI endpoint. Do not enable the workflow for external or public repositories until the policy is approved.
- `WHALEBONE_API_KEY` (and `WHALEBONE_BASE_URL`) supplied from the organization's secret manager. Do not commit keys or paste them into commands.
- A trusted immutable full base commit SHA, or a fully qualified remote-tracking ref (for example `refs/remotes/origin/main`). Unqualified refs such as `origin/main` are rejected because a same-named Git tag can take precedence.
- Check rules placed at `.whalebone/checks/*.md`. See `examples/whalebone-checks/code-quality.md`. The workflow at `examples/github-actions/whale-bone-ai-checks.yml` is **only a sample** and is never activated automatically.

## Usage

From an approved project on Windows:

```powershell
node C:\Tools\WhaleBone\scripts\ci-check.js --workspace C:\Projects\MyRepo --base <FULL_TRUSTED_BASE_COMMIT_SHA>
```

The checker loads ALL check definitions from the verified **base commit** using Git tree/blobs, not from the PR checkout. It rejects symlink or malformed base rule files. Rules added or changed in a PR do not govern that PR. The checker reads only eligible tracked changed files, excludes protected paths such as `.env`, `.git`, private keys and symlinks, caps the evaluated diff at 30 KB, and evaluates up to 12 bounded check rules. **When more than 24 eligible source files change, or when the diff exceeds 30 KB, it emits `SKIPPED (not PASS)` and exits 2 without an AI verdict**, rather than asserting all code passed. It performs no downloads or shell execution. Its requests use the unmodified Whale Bone PowerShell API transport and configured corporate proxy.

## Trusted source and merge-policy boundaries

- Pass a trusted base reference, preferably the immutable base SHA from the protected pull-request event, rather than `origin/main`. The script resolves it once to an immutable commit SHA for both rules and diffs. Do not accept a base ref supplied by PR source code.
- **Advisory only.** Do not configure this AI check as a mandatory branch protection/merge gate. The included example workflow sets `continue-on-error: true` and `shell: powershell` for Windows PowerShell 5.1.
- Pull-request diffs are untrusted text and can contain prompt injection. A system prompt cannot guarantee instruction immunity. Human reviewers, deterministic unit tests, SAST, and policy-based scanners remain required.
- Changes exceeding 30 KB or 24 eligible source files are not inspected; `SKIPPED` is not the same as a passing review. The user should split a review or use other deterministic checks.
- A `pull_request` workflow originating from an external fork may not receive the secret. Never switch to privileged `pull_request_target` with an untrusted checkout/test runner to obtain it. Use only approved internal CI designs.

## Important limits

AI check judgments may be inaccurate. Do not replace deterministic tests, SAST, dependency scanning, human review or deployment approvals. Check verdicts are conservative but not cryptographic proof. The included sample workflow is optional, not an automatically enabled CI integration. It must be adapted to your runner's approved Whale Bone installation and security controls.

## Completeness changes

- Deletion-only source changes are explicitly reported as `SKIPPED (not PASS)`. They are never treated as an empty successful review.
- The standalone CLI now returns exit 2 for SKIPPED/incomplete coverage. The example GitHub Actions workflow retains `continue-on-error: true` to keep the AI check advisory. Do not use the AI result as a required merge gate.

## Integrity changes

- The recommended GitHub workflow passes `${{ github.event.pull_request.base.sha }}` rather than ambiguous `origin/main`; users must not supply the base SHA from a PR-controlled file or untrusted input.
- The checker reports `SKIPPED (not PASS)` before invoking AI if more than 24 eligible files would be included. It does not silently judge a partial patch set.
- Git diff uses `--text --no-textconv --no-ext-diff` so PR-controlled `.gitattributes` cannot suppress a normal text patch with `-diff`. Models can still judge source incorrectly, and no deterministic policy gate is implied.
- Advisory workflow retains `continue-on-error: true`: a reported AI FAIL may therefore appear as a non-blocking job in GitHub. Read the log. Use deterministic and human review for actual merge approval.
