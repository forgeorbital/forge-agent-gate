# Minimal image so Glama can sandbox-introspect the MCP server and the Docker MCP
# Catalog can run it. The gate itself takes no funds, keys, or credentials.
FROM node:20-slim
RUN npm install -g forge-agent-gate@0.1.4
ENTRYPOINT ["npx", "-y", "forge-agent-gate", "serve"]
