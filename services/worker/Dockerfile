FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/worker/package.json services/worker/
COPY apps/web/package.json apps/web/
COPY tests/e2e/package.json tests/e2e/
RUN npm ci -w services/worker
COPY services/worker services/worker
RUN npm run build -w services/worker

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY services/worker/package.json services/worker/
COPY apps/web/package.json apps/web/
COPY tests/e2e/package.json tests/e2e/
RUN npm ci -w services/worker --omit=dev
COPY --from=build /app/services/worker/dist services/worker/dist
COPY db db
ENV MIGRATIONS_DIR=/app/db/migrations
WORKDIR /app/services/worker
EXPOSE 3001
CMD ["node", "dist/main.js"]
