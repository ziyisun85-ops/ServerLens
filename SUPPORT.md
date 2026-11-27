# Support

## Before opening an issue

Verify that the same SSH target works outside VS Code without a password prompt:

```bash
ssh -o BatchMode=yes gpu-node-01 'nvidia-smi -L; df -P -k -T'
```

ServerLens requires non-interactive SSH authentication. GPU data also needs `nvidia-smi` on the server; servers without it are shown as CPU-only. Increase `serverlens.sshTimeout` when a server is reachable but slow to respond. The **ServerLens: Show Log** command opens the extension log (host aliases, timings and error kinds only).

## Bugs and feature requests

Use [GitHub Issues](https://github.com/ziyisun85-ops/ServerLens/issues). Remove real hostnames, IP addresses, usernames, credentials, mount paths and process information before posting logs or screenshots.

## Security reports

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).

## Installation

Install ServerLens from the Visual Studio Marketplace (search for "ServerLens" in the Extensions view, or run `code --install-extension ziyisun85-ops.serverlens`). Each release on [GitHub Releases](https://github.com/ziyisun85-ops/ServerLens/releases) also has the `.vsix` package for offline installation.
