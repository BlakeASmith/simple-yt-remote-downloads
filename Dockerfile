# Build stage - compile Bun app to binary
FROM oven/bun:1-debian AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY tsconfig.json ./

# Install dev dependencies for build
RUN bun install

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
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    && pip3 install --break-system-packages yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create downloads directory
RUN mkdir -p /downloads

WORKDIR /app

# Copy compiled binary from builder
COPY --from=builder /app/youtube-dl-server ./
COPY --from=builder /app/public ./public/

# Environment variables
ENV DOWNLOADS_ROOT=/downloads
ENV PORT=80

# Expose port 80
EXPOSE 80

# Create volume mount point
VOLUME ["/downloads"]

# Run the server
CMD ["./youtube-dl-server"]
