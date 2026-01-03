# Build stage - build UI + compile Bun app to binary
FROM oven/bun:1.3.5-debian AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY tsconfig.json ./
COPY bun.lock ./

# Install dependencies (needed for UI build)
RUN bun install --frozen-lockfile

# Copy source code
COPY src/ ./src/
COPY public/ ./public/
COPY ui/ ./ui/

# Build UI assets into public/ and compile single binary
RUN bun run build:ui && bun run build:server

# Runtime stage - minimal image with yt-dlp
FROM debian:bookworm-slim

# Install yt-dlp and dependencies
# Using Python and pip for yt-dlp to get latest version
# ffmpeg is required for merging video/audio streams
# cron for scheduled downloads
# curl and unzip for installing Bun
# nodejs for yt-dlp JavaScript runtime support
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    cron \
    curl \
    unzip \
    nodejs \
    npm \
    && pip3 install --break-system-packages yt-dlp \
    && curl -fsSL https://bun.sh/install | bash \
    && mv /root/.bun/bin/bun /usr/local/bin/bun \
    && ln -sf /usr/bin/nodejs /usr/local/bin/node \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create downloads directory
RUN mkdir -p /downloads

WORKDIR /app

# Copy compiled binary from builder
COPY --from=builder /app/youtube-dl-server ./
COPY --from=builder /app/public ./public/

# Copy source files needed for schedule checker (scheduler.ts)
COPY src/scheduler.ts ./src/scheduler.ts

# Copy schedule checking script to app directory
COPY scripts/check-schedules.js ./check-schedules.js
RUN chmod +x ./check-schedules.js

# Copy entrypoint script
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Server listens on port 80
ENV PORT=80

# Expose port 80
EXPOSE 80

# Create volume mount point
VOLUME ["/downloads"]

# Set up cron job to check schedules every minute
RUN echo "* * * * * cd /app && /usr/local/bin/bun check-schedules.js >> /var/log/schedule-check.log 2>&1" | crontab -

ENTRYPOINT ["/entrypoint.sh"]

# Run the server
CMD ["./youtube-dl-server"]
