#!/usr/bin/env bash

cd .mastra/output
export NODE_ENV=production
export PORT=3000
node index.mjs
