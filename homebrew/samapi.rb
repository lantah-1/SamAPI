class Samapi < Formula
  desc "SamAPI local model gateway"
  homepage "https://github.com/lantah-1/samapi"
  head "file:///Users/exping/dev/local/samapi", using: :git, branch: "main"

  depends_on "node"

  def install
    (etc/"samapi").mkpath
    (var/"lib/samapi").mkpath
    (var/"log/samapi").mkpath

    (etc/"samapi/samapi.env").write <<~EOS unless (etc/"samapi/samapi.env").exist?
      SAMAPI_HOST=0.0.0.0
      SAMAPI_PORT=8787
      SAMAPI_DATA_DIR=#{var}/lib/samapi
      SAMAPI_WEB_DIR=/Users/exping/dev/local/samapi/dist
      NODE_ENV=production
    EOS

    (bin/"samapi").write <<~EOS
      #!/bin/bash
      set -euo pipefail

      REPO="/Users/exping/dev/local/samapi"
      ENV_FILE="${SAMAPI_ENV_FILE:-#{etc}/samapi/samapi.env}"

      if [ -f "$ENV_FILE" ]; then
        set -a
        source "$ENV_FILE"
        set +a
      fi

      export SAMAPI_HOST="${SAMAPI_HOST:-0.0.0.0}"
      export SAMAPI_PORT="${SAMAPI_PORT:-8787}"
      export SAMAPI_DATA_DIR="${SAMAPI_DATA_DIR:-#{var}/lib/samapi}"
      export SAMAPI_WEB_DIR="${SAMAPI_WEB_DIR:-$REPO/dist}"
      export NODE_ENV="${NODE_ENV:-production}"

      TSX_CLI="$REPO/node_modules/tsx/dist/cli.mjs"
      if [ ! -f "$TSX_CLI" ]; then
        echo "Missing tsx runtime. Run 'pnpm install' in $REPO first." >&2
        exit 1
      fi

      if [ ! -f "$SAMAPI_WEB_DIR/index.html" ]; then
        echo "Missing web build. Run 'pnpm build' in $REPO first." >&2
        exit 1
      fi

      cd "$REPO"
      exec "#{Formula["node"].opt_bin}/node" "$TSX_CLI" "$REPO/server/index.ts"
    EOS
  end

  service do
    run [opt_bin/"samapi"]
    keep_alive true
    log_path var/"log/samapi/samapi.log"
    error_log_path var/"log/samapi/samapi.err.log"
  end
end
