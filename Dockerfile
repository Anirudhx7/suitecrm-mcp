FROM node:20-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/index.mjs server/auth.mjs ./
RUN adduser -D appuser \
    && chown -R appuser /app \
    && mkdir -p /etc/suitecrm-mcp \
    && chown appuser /etc/suitecrm-mcp
USER appuser
EXPOSE 3100
EXPOSE 3101
# Metrics ports are bound to 127.0.0.1 by default. Set METRICS_BIND=0.0.0.0 so
# a Prometheus container on the same Docker network can reach them by service name.
EXPOSE 9090
EXPOSE 9091
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3101/health || exit 1
CMD ["node", "index.mjs"]
