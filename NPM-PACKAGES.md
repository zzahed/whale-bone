# Node.js and npm manager

Open **Whale Bone → Settings → Node.js & npm → Manage npm packages / Run npm command**. The approved command interface supports `npm install -g yo generator-office`, `npm install package`, `npm uninstall package`, `npm list`, and `npm ci`. No shell chaining, direct URLs, arbitrary flags or package scripts are accepted. Node.js with npm must already be installed, but an administrator account is not required to install global packages under the Whale Bone per-user prefix.

The manager creates a temporary localhost registry, retrieves official npm metadata and tarballs through its separate Windows PowerShell helper using Windows-integrated proxy credentials, and executes the approved npm CLI using absolute paths and without a shell. Registry metadata retains artifact integrity values for npm to verify. Run global binary tools from the user prefix; the ordinary VS Code terminal does **not** automatically inherit the authenticated relay.

## Global installs

The manager operates from an isolated temporary working directory and installs to the user-writable Whale Bone prefix. `npm install -g yo generator-office` is supported. This is not an assurance every version of these packages runs without lifecycle scripts. Read the Output → Whale Bone: npm Packages log for compatibility warnings.

## Workspace installs and lockfiles

The manager rejects linked/hard-linked manifest/config/lock files, unsafe or symbolic-linked `node_modules` trees, outside-workspace references, and non-official package locations, including Git, SSH, `file:`, invalid npm aliases, stale localhost relay URLs, and remote overrides. `npm ci` requires a supported lockfile and its dependencies. After a managed installation succeeds, transient relay URLs in the lockfile are converted to permanent official registry URLs. IMPORTANT: `npm ci` normally deletes and recreates the existing `node_modules` tree. Whale Bone warns before proceeding and refuses redirected/symlinked install trees. This is not a sandbox; arbitrary npm packages and installs may modify other allowed workspace files. Incomplete installs may need manual clean-up. Workspaces/monorepos using `workspaces` or lockfile local link records are intentionally unsupported in managed mode for security.

## Troubleshooting and endpoint acceptance

Use **Test npm registry** to fetch package metadata AND its latest tarball without installing it. If the registry publishes an SHA-256/384/512 integrity value, Whale Bone checks it. The output shows the package version, sizes, elapsed times, HTTP failure category, and retry details. A 403, 407, invalid HTML response or TLS error requires corporate proxy diagnostics; do not disable TLS verification. If a saved Node/npm path is rejected, choose **Reset saved Node/npm paths**, then select trusted Node.js and `npm-cli.js` binaries again. Windows `.cmd` and `.bat` files are not valid `npm-cli.js` selections.

Test on Windows 11 corporate x64 and ARM64 endpoints before broad use. Check user-writable prefix, real `yo` installation, scoped dependencies, package-lock and shrinkwrap behavior, cancellation, offline cache, Unicode paths, blocked lifecycle scripts, and the authenticated proxy. API and PyPI transport remain unchanged.

## Safety controls

Before every local npm operation, Whale Bone inspects the existing `node_modules` tree and rejects symbolic links, junctions, hard-linked files, unreadable entries and trees exceeding 80,000 entries. This prevents the observed external-directory deletion from npm `ci` with a redirected `node_modules`. Global npm permits package binaries linked to targets within the same validated global prefix, but rejects links escaping it. Global prefix and npm cache paths must not traverse directory links. The npm subprocess also clears `NODE_PATH`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED` and inherited npm/proxy settings.

Compatibility: monorepo workspaces, managed local links and external package references are rejected rather than silently traversed. For such projects use a separately controlled, approved package workflow. The project validator is not a hard OS sandbox, and concurrent filesystem modification remains a residual risk.

## Upstream error diagnostics, retries and persistent cache

The local registry relay now distinguishes upstream HTTP failures (including HTTP 502 and proxy 407), TLS certificate issues, timeouts and transient connection resets. Upstream 429, 500, 502, 503, 504 and transport timeouts/resets receive up to three attempts with exponential backoff, subject to an eight-minute total deadline per artifact. 401/403/404/407, TLS failures and unrecognized failures are not retried. Retries are controlled by Whale Bone rather than npm and never alter Windows proxy credentials or registry host policy. Logs show each package, attempt, failure category and duration without dumping raw proxy error text or secrets.

Completed registry downloads persist in `%USERPROFILE%\.whalebone\npm-registry-cache` (the OS home directory is used to resolve this path). Package metadata expires after 30 minutes; tarballs remain cacheable because npm verifies declared integrity. The cache is capped at 1.2 GiB and accepts only ordinary single-linked hashed files. Oldest cached items are removed if the startup size exceeds the cap. A separate npm CLI cache remains at `%USERPROFILE%\.whalebone\npm-cache`. The local listening port still changes on each operation, and ordinary terminal commands are not affected.

For HTTP 502 on `follow-redirects`, run **Settings → Node.js & npm → Manage npm packages → Test npm registry**, enter `follow-redirects`, and inspect **Output → Whale Bone: npm Packages**. If all retries return HTTP 502, the logs show an upstream failure but do not identify whether the corporate proxy, SSL inspection, or the registry returned it. Escalate using the exact timestamp, package name, HTTP status and approved destination host. Do not disable TLS or change the API/PyPI transport layer.

## Registry metadata compatibility and failure classification

The official npm registry publishes metadata for all historical package versions. Whale Bone excludes only the incompatible versions (those using a Git/file dependency, lacking a supported artifact, or publishing a tarball outside the approved registry) while preserving the registry-only restriction for all allowed versions and tarballs. The `latest` tag is never silently downgraded: when it points to an excluded version, the relay reports a policy error.

The **Whale Bone: npm Packages** output now logs aggregate historical-version exclusions and lists distinct `metadataVersionsRejected`, `metadataProcessingFailures` and `relayInternalFailures` counters. Invalid JSON is classified as metadata-format (HTTP 502). Packages with no permitted versions or an unsupported latest version receive HTTP 422 and an actionable message. Error details never expose rejected external URLs or credentials.

If a package still fails, share only the relevant `[npm relay] Metadata`, `[npm relay] ERROR`, and `npm relay diagnostic counters` lines with secrets redacted. A remaining HTTP 502 with zero upstream failures can still indicate a local processing error; do not assume the corporate proxy returned that status. The relay does not disable TLS validation or change corporate proxy settings.

## Fix npm HTTP 422 for development-only metadata

The upstream npm package metadata may contain `devDependencies` that the publisher uses to build or test the package. These are **not** installed when that package is consumed as a dependency. The previous relay incorrectly validated those development-only sources as installation requirements, and could return HTTP 422 for otherwise valid package releases. For example, `globby` publishes a GitHub-sourced development dependency while its runtime dependencies use the official registry.

The relay now checks each published version's installable `dependencies`, `optionalDependencies` and `peerDependencies`, preserves the approved official-registry tarball URL and integrity fields, and strips the published version's `devDependencies` from the metadata sent to npm. Unsafe runtime and peer dependencies still cause that version to be excluded; an unsafe `latest` tag still fails closed. The user's own workspace `package.json` **still validates `devDependencies`** because local `npm install` can install those dependencies. No registry host, TLS, user-agent or Windows proxy behavior was changed.

If `execa` or `globby` still returns HTTP 422, record the current `[npm relay] Metadata` exclusion reasons and `[npm relay] ERROR` lines. The exact corporate registry response was not available for this local correction. Node.js v18 may not satisfy the latest releases' declared `engines.node`; an HTTP 200 from the registry alone does not establish runtime compatibility.

## Bounded download queue and runtime compatibility

- Upstream download-slot queue expires with retryable HTTP 503 instead of waiting indefinitely for npm to close the localhost socket.
- After closing npm, pending relay requests are accounted as cancellations, not repeated generic failures.
- Npm concurrent sockets are limited to six, matching relay workers. Registry cache persists successful prior downloads.
- Npm installs use `engine-strict=true` and reject packages that declare incompatibility with the selected Node.js version. This prevents unsupported packages from proceeding to an expensive installation.
- Current OpenClaw releases require Node.js 24.x or 26.x, not the earlier WinPython-provided Node.js 18. Scripts remain disabled by policy, which may prevent packages with native compilation from functioning even if npm downloads them.

## Resilient npm localhost relay connections

When npm downloads hundreds of dependencies, a transient reset of its HTTP connection to the local Whale Bone relay could abort an entire installation because npm client fetch retries were disabled. Managed npm now retries transient network/5xx failures up to two times with bounded 1–5-second retry delays, advertises a longer keep-alive lifetime for the local server, limits npm to eight concurrent registry sockets, and reports early localhost client disconnects separately from upstream fetch failures. The PowerShell proxy/authentication downloader and other frozen transport files are unchanged. A persistent ECONNRESET on every attempt still requires diagnosis of the VS Code extension host and endpoint security.
