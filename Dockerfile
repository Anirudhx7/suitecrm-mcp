FROM node:20-alpine
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/index.mjs ./
EXPOSE 3101
CMD ["node", "index.mjs"]
