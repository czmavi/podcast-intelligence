FROM denoland/deno:2.9.3
WORKDIR /app
COPY deno.json ./
COPY apps ./apps
COPY packages ./packages
COPY migrations ./migrations
COPY scripts ./scripts
RUN deno cache apps/web/main.ts apps/worker/main.ts
EXPOSE 8000
CMD ["deno", "run", "-A", "apps/web/main.ts"]
