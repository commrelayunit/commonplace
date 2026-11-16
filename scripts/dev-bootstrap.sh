#!/usr/bin/env sh
set -eu

REPO_URL=${FIRECRAWL_REPO_URL:-https://github.com/mendableai/firecrawl.git}
REPO_TAG=${FIRECRAWL_REPO_TAG:-v2.11.162}
CHECKOUT_DIR=${FIRECRAWL_CHECKOUT_DIR:-.dev/firecrawl}

if [ -d "$CHECKOUT_DIR/.git" ]; then
  echo "Firecrawl checkout already present at $CHECKOUT_DIR"
else
  git clone --branch "$REPO_TAG" --depth 1 "$REPO_URL" "$CHECKOUT_DIR"
fi

echo
echo "Add to .env:"
echo "FIRECRAWL_BASE_URL=http://localhost:3002"
echo "PDF_SERVICE_BASE_URL=http://localhost:${PDF_SERVICE_PORT:-8008}"
