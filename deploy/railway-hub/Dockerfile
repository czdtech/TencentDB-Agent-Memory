FROM agentmemory/memory-hub:1.0.3-beta.1@sha256:53a3285b6444628384fc0b9a1b5da66558daddbed8aba880ee66d390764b7c6a

WORKDIR /app/railway-hub
COPY entry.mjs smoke.mjs ./

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=5s --retries=15 --start-period=60s \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "/app/railway-hub/entry.mjs"]
