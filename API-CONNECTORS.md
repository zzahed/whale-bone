# External API connector generation

Whale Bone generates **PowerShell 5.1 source code**, not live API connections. The extension's API transport (`src/transport.js` and `ps/transport.ps1`) is unchanged.

## User workflow

1. In Chat enter the **explicit** `/connector Brave` command. In Ask mode a script is returned as text. In Build mode it is staged as `tools/connect_brave_api.ps1` and must pass **View diff → Apply → Confirm**. Alternatively open Files and select **Generate external API script**. Ordinary requests such as “Write a Python function to call the Brave API” now go to API without automatic interception.
2. Acquire an API key from the provider under its terms, with any necessary enterprise approvals.
3. In a fresh PowerShell session obtain `BRAVE_API_KEY` from an approved secret manager or use a masked prompt (`Read-Host -AsSecureString`) and convert to a process environment variable. Do **not** type the key into command history, hardcode it, or commit it.
4. After approving the generated script, run `./tools/connect_brave_api.ps1 -Query 'example search'` manually. No admin rights or external PowerShell modules are needed.
5. Use the **Whale Bone: Troubleshoot and Self-Check** command for local errors. API connectivity does not imply Brave connectivity.

The locally generated script is recorded in the sidebar conversation history so that a subsequent API question can refer to it. This is not an automatic external API connection.

## Brave source contract

- Endpoint: `https://api.search.brave.com/res/v1/web/search`
- HTTP: `GET` with URL-encoded query parameter `q`.
- Authentication: `X-Subscription-Token` request header, sourced from `BRAVE_API_KEY` process environment variable.
- Transport technique: Windows PowerShell `Invoke-WebRequest` + configured proxy + Windows default proxy credentials + configured User-Agent. HTTPS verification remains enabled.
- Official documentation: https://api-dashboard.search.brave.com/api-reference/web/search/get and https://api-dashboard.search.brave.com/documentation/guides/authentication

## Other API providers

The generated PowerShell scaffold is **not an API client until configured**. It deliberately uses `REPLACE_WITH_VERIFIED_PROVIDER_ENDPOINT` and `REVIEW_AUTH_HEADER` placeholders. Change these values only after checking the official specification, including HTTP method, parameters, pagination, quotas, token requirements, and data-handling policy. Some providers require OAuth flows or POST bodies. The generic GET example is **not** sufficient for those APIs.

## Security and operational limits

- No network request occurs during connector generation. The script does not execute itself and cannot change workspace files without explicit diff approval.
- The output uses the **current** Whale Bone proxy/User-Agent settings, but the extension's original API transport source remains byte-identical.
- External API credentials are not accepted by Whale Bone and are not stored in the VS Code workspace. The script looks up its own provider-specific process environment variable at runtime.
- The generated script is subject to the same user and corporate policies as any manually executed script. Endpoint allowlisting, PowerShell policy and endpoint protection are environment dependencies.
- Brave integration was checked against official documentation, but not against a live account or corporate proxy.
- Unknown providers' endpoints and authentication contracts are **not independently verified** and must be configured by the user.
