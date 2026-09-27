#!/usr/bin/env bash
set -euo pipefail
runtime_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
runtime_home="${HOME}/.local/share/crucible/harbor"
command -v container >/dev/null || { echo 'Install Apple container and run container system start first.' >&2; exit 1; }
python3 -c 'import sys; assert sys.version_info >= (3, 12), "Python 3.12+ is required"'
mkdir -p "$runtime_home"
python3 -m venv "$runtime_home/venv"
"$runtime_home/venv/bin/python" -m pip install -r "$runtime_dir/requirements.txt"
image_name="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$runtime_dir/image.json")"
container build -t "$image_name" -f "$runtime_dir/Dockerfile" "$runtime_dir"
echo "Crucible Harbor runtime ready: $image_name"
