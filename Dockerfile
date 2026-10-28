# Amphibian Launcher - build & run in Docker (works on macOS)
# The game's WASM toolchain (emsdk / ikvmc statics) is Linux-only, so on a Mac
# we build inside a Debian-based .NET 10 container pinned to linux/amd64
# (Docker Desktop's Rosetta emulation runs it fine on Apple Silicon).
#
# Build:  docker build --platform linux/amd64 -t amphibian .
# Run:    docker run --rm -it -p 5021:5021 --platform linux/amd64 amphibian
# Open:   https://localhost:5021  (Chrome or Edge only - not Safari/Firefox)

FROM --platform=linux/amd64 mcr.microsoft.com/dotnet/sdk:10.0

ENV DEBIAN_FRONTEND=noninteractive

# mono (runs ikvmc), a JDK, Node 22 + pnpm (frontend), plus Makefile utilities
RUN apt-get update && apt-get install -y \
        wget unzip make python3 curl ca-certificates \
        mono-devel openjdk-17-jdk-headless \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Frontend dependencies
RUN cd frontend && pnpm install

# .NET WebAssembly workload (big download)
RUN cd loader && dotnet workload restore

# Full backend build: downloads the prebuilt statics, compiles the ikvmc
# bundles + dotnet-wasm runtime, and copies them into frontend/public
RUN make build

EXPOSE 5021
CMD ["pnpm", "--dir", "frontend", "run", "dev"]
