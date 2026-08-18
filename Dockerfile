FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_FILE=/data/db.json

EXPOSE 3000

VOLUME ["/data"]

CMD ["npm", "start"]

