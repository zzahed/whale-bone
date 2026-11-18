# Changelog

## 0.0.1 — First public preview

- First public, MIT-licensed release.
- Works with any HTTPS OpenAI-compatible API endpoint (base URL ending `/v1`). There is no built-in vendor endpoint.
- New proxy settings: turn the proxy on or off, set its address (empty = Windows system proxy), and choose computer (Windows sign-in), user name and password, or no authentication. The proxy password is stored in VS Code SecretStorage.
- The same proxy settings apply to the API transport, the pip and npm relays, and generated API connector scripts.
- Fixes: activation no longer fails on an invalid setting; quoted keys in a workspace `.npmrc` can no longer override the managed registry; agent search matches redacted text only; a bare `SECRET_KEY` is now redacted; UTF-8 output split across chunks is decoded correctly.
