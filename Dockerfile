FROM node:22-slim
WORKDIR /app
COPY server.js dashboard.html package.json ./
EXPOSE 8080
CMD ["node", "server.js"]
