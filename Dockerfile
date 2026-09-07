FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . ./

ENV NODE_ENV=production \
    PORT=4173 \
    COMMONPLACE_DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 4173
CMD ["npm", "start"]
