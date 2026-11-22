FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /srv/bai-backend
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY migrations ./migrations
USER node
EXPOSE 8080
CMD ["node", "src/api.mjs"]
