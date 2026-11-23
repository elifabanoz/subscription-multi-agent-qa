#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Bu kontrol Linux veya WSL2 içinde çalıştırılmalıdır." >&2
  exit 2
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Eksik komut: $1" >&2
    exit 2
  fi
}

require_command node
require_command npm
require_command git
require_command codex
require_command claude

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if (( node_major < 22 )); then
  echo "Node.js 22 veya üzeri gerekli; mevcut sürüm: $(node --version)" >&2
  exit 2
fi

echo "Yerel testler çalıştırılıyor..."
npm test

echo "Codex ve Claude abonelik oturumları doğrulanıyor..."
npm run doctor

echo "WSL kurulumu hazır. Örnek çalışma:"
echo "npm run team -- --repo /absolute/path/to/your-project --config qa.config.json"
