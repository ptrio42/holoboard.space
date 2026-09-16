FROM node:24-alpine3.23@sha256:838d276a37a1e42da2a5d01e0ecbb4401ca4147728f62ca2eba6d023a352f88f AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_RELAY_URL=ws://localhost:8080/relay
ARG VITE_RELAY_PUBKEY
ARG VITE_PUBLIC_RELAYS=wss://nos.lol,wss://relay.damus.io,wss://relay.primal.net,wss://nostr.mom,wss://offchain.pub
ARG VITE_BOARD_LIMIT=50
ARG VITE_SATS_ENDPOINT

RUN npm run build

FROM nginx:1.30-alpine@sha256:73c75df4075c918f91017fdda46ad81e55e5af77ba3a64ca3d5014bd9244fe7f AS runtime
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=builder /app/dist /usr/share/nginx/html
RUN chown -R nginx:nginx /var/cache/nginx

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
