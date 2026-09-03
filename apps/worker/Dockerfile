FROM denoland/deno:2.9.3

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY deno.json ./
COPY apps ./apps
COPY packages ./packages
COPY migrations ./migrations
COPY scripts ./scripts
RUN deno cache apps/worker/main.ts

CMD ["deno", "run", "-A", "apps/worker/main.ts"]
