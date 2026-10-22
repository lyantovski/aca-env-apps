FROM node:24-alpine3.22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.server.json tsconfig.test.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
COPY shared ./shared
COPY server ./server
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-alpine3.22 AS runtime
LABEL com.azure.containerizationassist.createdby="containerization-assist"
WORKDIR /app
RUN apk add --no-cache bash tini postgresql17 postgresql17-client
ENV NODE_ENV=production PORT=8080
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node --chmod=755 docker/entrypoint.sh ./entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/health/ready || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/bin/bash", "/app/entrypoint.sh"]
