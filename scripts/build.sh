#!/usr/bin/env bash

set -e

export NODE_OPTIONS='--max-old-space-size=1536'

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Project root: $PROJECT_ROOT"

# Check if build already exists (pre-built to speed up deployment)
if [ -f "$PROJECT_ROOT/.mastra/output/index.mjs" ] && [ -d "$PROJECT_ROOT/.mastra/output/node_modules" ]; then
  echo "Using existing pre-built Mastra output..."
else
  echo "Building Mastra application..."
  mastra build
fi

# Copy client files to build output for production serving
if [ -d "$PROJECT_ROOT/client" ]; then
  echo "Copying client files to .mastra/output/client..."
  mkdir -p "$PROJECT_ROOT/.mastra/output/client"
  cp -r "$PROJECT_ROOT/client/"* "$PROJECT_ROOT/.mastra/output/client/"
  echo "Client files copied successfully"
  ls -la "$PROJECT_ROOT/.mastra/output/client/"
else
  echo "WARNING: Client folder not found at $PROJECT_ROOT/client"
fi

# Create a wrapper script that sets PORT=3000 for production health checks
cat > "$PROJECT_ROOT/.mastra/output/start.sh" << 'EOF'
#!/usr/bin/env bash
export PORT=3000
exec node index.mjs
EOF
chmod +x "$PROJECT_ROOT/.mastra/output/start.sh"

# Patch the index.mjs to default to PORT 3000 for production health checks (only if not already patched)
if [ -f "$PROJECT_ROOT/.mastra/output/index.mjs" ]; then
  if ! grep -q 'process.env.PORT = process.env.PORT' "$PROJECT_ROOT/.mastra/output/index.mjs"; then
    echo "Patching index.mjs to use PORT 3000 for production..."
    sed -i '1s/^/process.env.PORT = process.env.PORT || "3000";\n/' "$PROJECT_ROOT/.mastra/output/index.mjs"
  else
    echo "index.mjs already patched for PORT 3000"
  fi
fi

echo "Build complete!"
