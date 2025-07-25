#!/usr/bin/env bash
set -euo pipefail

find . -type f -name "*.yaml" | while read -r file; do
  echo "🚀 Starting services defined in: $file"
  docker-compose -f "$file" up -d
done

echo "✅ All docker-compose YAMLs started."
