FROM node:20-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/index.mjs ./
RUN adduser -D appuser && chown -R appuser /app
USER appuser
EXPOSE 3101
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3101/health || exit 1
CMD ["node", "index.mjs"]
