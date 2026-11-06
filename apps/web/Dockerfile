FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/worker/package.json services/worker/
COPY apps/web/package.json apps/web/
COPY tests/e2e/package.json tests/e2e/
RUN npm ci -w apps/web
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
