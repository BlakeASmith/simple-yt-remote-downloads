# Build stage - compile Bun app to binary
FROM oven/bun:1.1.0-debian AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY tsconfig.json ./

# Skip bun install - no runtime dependencies needed and bun-types is built-in
# If needed, install can be done with: RUN bun install --no-save --frozen-lockfile

# Copy source code
COPY src/ ./src/
COPY public/ ./public/

# Build single binary
RUN bun build src/index.ts --compile --outfile youtube-dl-server

# Runtime stage - minimal image with yt-dlp
FROM debian:bookworm-slim

# Install yt-dlp and dependencies
# Using Python and pip for yt-dlp to get latest version
# ffmpeg is required for merging video/audio streams
# cron for scheduled downloads, curl for API calls, jq for JSON parsing
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    cron \
    curl \
    jq \
    && pip3 install --break-system-packages yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create downloads directory
RUN mkdir -p /downloads

WORKDIR /app

# Copy compiled binary from builder
COPY --from=builder /app/youtube-dl-server ./
COPY --from=builder /app/public ./public/

# Copy schedule checking script
COPY scripts/check-schedules.sh /usr/local/bin/check-schedules.sh
RUN chmod +x /usr/local/bin/check-schedules.sh

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
RUN echo "* * * * * /usr/local/bin/check-schedules.sh >> /var/log/schedule-check.log 2>&1" | crontab -

ENTRYPOINT ["/entrypoint.sh"]

# Run the server
CMD ["./youtube-dl-server"]
