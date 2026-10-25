# LiveCompanion: update center for Bitfocus Companion installs (controllers, satellites, Docker)
FROM node:22-alpine

ENV NODE_ENV=production \
    CONFIG=/data/config.json \
    PORT=8080

# the system ssh client does the talking to the devices; tzdata for the daily check time
RUN apk add --no-cache openssh-client openssh-keygen tzdata

WORKDIR /app
COPY package.json server.js discover.js ./
COPY lib ./lib
COPY bin ./bin
COPY public ./public
RUN chmod +x bin/askpass.sh

# settings, the SSH key and backups are kept in /data (a volume, so they survive updates)
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
