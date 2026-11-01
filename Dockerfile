FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 JEV_USAGE_FILE=/tmp/usage.jsonl
USER node
EXPOSE 8080
CMD ["node", "server.js"]
