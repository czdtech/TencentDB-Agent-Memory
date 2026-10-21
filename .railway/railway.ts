import { defineRailway, github, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const memoryHubData = volume("memory-hub-data", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  const memoryCoreData = volume("memory-core-data", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  const memoryProxyData = volume("memory-proxy-data", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  const memoryHub = service("memory-hub", {
    source: github("czdtech/TencentDB-Agent-Memory", { branch: "deploy/railway-source", checkSuites: false, rootDirectory: "/deploy/railway-hub" }),
    build: { buildEnvironment: "V3", builder: "RAILPACK" },
    healthcheck: "/health",
    healthcheckTimeout: 300,
    replicas: { "us-west2": 1 },
    deploy: { limitOverride: { containers: { cpu: 1, memoryBytes: 1000000000 } } },
    volumeMounts: { "/data": memoryHubData },
  });
  const memoryCore = service("memory-core", {
    source: github("czdtech/TencentDB-Agent-Memory", { branch: "deploy/railway-source", checkSuites: false, rootDirectory: "MemoryCore" }),
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    start: "bash -c 'mkdir -p /data/config /data/tdai-memory || true; cat > /data/config/tdai-gateway.yaml << \"YAMLEOF\"\ndeployMode: standalone\nserver:\n  port: 8420\n  host: 0.0.0.0\ndata:\n  baseDir: /data/tdai-memory\nllm:\n  baseUrl: \"${TDAI_LLM_BASE_URL}\"\n  apiKey: \"${TDAI_LLM_API_KEY}\"\n  model: \"${TDAI_LLM_MODEL}\"\n  maxTokens: 32000\n  timeoutMs: 300000\nmemory:\n  promptMode: code\n  capture:\n    enabled: true\n  extraction:\n    enabled: true\n    enableDedup: true\n    maxMemoriesPerSession: 20\n  persona:\n    triggerEveryN: 50\n    maxScenes: 15\n  pipeline:\n    everyNConversations: 5\n    enableWarmup: false\n  recall:\n    enabled: true\n    maxResults: 5\n    scoreThreshold: 0.3\n    strategy: hybrid\n    timeoutMs: 5000\n  storeBackend: sqlite\n  embedding:\n    provider: openai\n    baseUrl: \"${TDAI_EMBEDDING_BASE_URL}\"\n    apiKey: \"${TDAI_EMBEDDING_API_KEY}\"\n    model: gemini-embedding-2\n    dimensions: 1536\n  bm25:\n    enabled: true\n    language: zh\nskill:\n  enabled: true\n  routing:\n    mode: bm25\n    searchTopK: 20\n  extraction:\n    enabled: true\n    maxIterations: 16\n    queue:\n      backend: local\n      keyPrefix: tdai\n      resultTtlSeconds: 86400\n      lockTtlMs: 600000\n      maxRetries: 2\n      retryBackoffsMs: [5000, 15000]\n  resources:\n    maxResourceSizeBytes: 5000000\nobservability:\n  otel:\n    enabled: false\n  clickhouse:\n    enabled: false\n  kafka:\n    enabled: false\n  langfuse:\n    enabled: false\nmetadata:\n  maxUsersPerInstance: 500\n  maxTeamsPerInstance: 100\n  store:\n    sqliteBaseDir: /data/tdai-memory/metadata-v3\nYAMLEOF\nexport TDAI_GATEWAY_PORT=\"${PORT:-8420}\"\nexec node --import tsx src/gateway/server.ts'",
    healthcheck: "/health",
    healthcheckTimeout: 300,
    replicas: { "us-west2": 1 },
    deploy: { limitOverride: { containers: { cpu: 1, memoryBytes: 2000000000 } } },
    volumeMounts: { "/data": memoryCoreData },
  });
  const memoryProxy = service("memory-proxy", {
    source: github("czdtech/TencentDB-Agent-Memory", { branch: "deploy/railway-source", checkSuites: false, rootDirectory: "MemoryProxy" }),
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    start: "bash -c 'mkdir -p /data/tdai-memory-proxy/fs /data/tdai-memory-proxy/logs || true; exec node --import tsx/esm src/index.ts --config /app/config.railway.yaml'",
    healthcheck: "/health",
    healthcheckTimeout: 300,
    preDeploy: [],
    replicas: { "us-west2": 1 },
    deploy: { limitOverride: { containers: { cpu: 1, memoryBytes: 1000000000 } } },
    volumeMounts: { "/data": memoryProxyData },
  });

  return project("tdam-cloud", {
    variables: { managed: false },
    resources: [memoryHub, memoryCore, memoryProxy, memoryHubData, memoryCoreData, memoryProxyData],
  });
});
