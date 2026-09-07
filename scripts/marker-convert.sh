#!/usr/bin/env sh
# Optional high-fidelity PDF adapter. Marker must be installed in this machine's
# Python environment; Commonplace intentionally does not install models itself.
set -eu

INPUT=${1:?usage: marker-convert.sh INPUT.pdf OUTPUT_DIR}
OUTPUT_DIR=${2:?usage: marker-convert.sh INPUT.pdf OUTPUT_DIR}
command -v marker_single >/dev/null || { echo "marker_single is not installed" >&2; exit 1; }

mkdir -p "$OUTPUT_DIR/assets"
marker_single "$INPUT" --output_dir "$OUTPUT_DIR/.marker-output"
MARKDOWN=$(find "$OUTPUT_DIR/.marker-output" -type f -name '*.md' -print -quit)
[ -n "$MARKDOWN" ] || { echo "Marker produced no Markdown" >&2; exit 1; }
cp "$MARKDOWN" "$OUTPUT_DIR/content.md"
find "$OUTPUT_DIR/.marker-output" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.webp' \) -exec cp {} "$OUTPUT_DIR/assets/" \;
rm -rf "$OUTPUT_DIR/.marker-output"
