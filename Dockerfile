FROM node:20-slim

WORKDIR /app

# Install curl for healthcheck
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Copy package files first for better layer caching
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV PONDER_TELEMETRY_DISABLED=true

# Expose the port that Ponder runs on
EXPOSE 42069

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:42069/health || exit 1

# Run database setup script if ABI_DATABASE_URL is provided and start the application
############################################
# WARNING: only working with npm run dev mode
############################################
CMD ["/bin/bash", "-c", "npm run setup-db && npm run start"] 