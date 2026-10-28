#!/bin/bash
# Netlify build entrypoint. The Netlify build image only ships the .NET 8 SDK, but
# ikvmc needs the net10.0 reference assemblies and the loader targets net10.0 with
# the wasm workload, so install a .NET 10 SDK (mirrors setup-dotnet in the workflows).
set -euo pipefail

export DOTNET_ROOT="$HOME/.dotnet10"
export PATH="$DOTNET_ROOT:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

if ! "$DOTNET_ROOT/dotnet" --list-sdks 2>/dev/null | grep -q '^10\.'; then
	echo "[netlify] installing .NET 10 SDK into $DOTNET_ROOT"
	curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
	bash /tmp/dotnet-install.sh --channel 10.0 --install-dir "$DOTNET_ROOT"
fi
dotnet --info | head -n 20

(cd loader && dotnet workload restore)

# Netlify only auto-installs dependencies for a package.json at the base directory (the repo root), and the
# frontend lives in its own subdirectory, so install it here (mirrors the Pages workflow). Without this,
# `pnpm build` fails with "tsc: not found".
echo "[netlify] installing frontend dependencies"
(cd frontend && pnpm install --frozen-lockfile)

make publish "$@"
