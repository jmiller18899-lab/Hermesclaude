FROM python:3.11-slim

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install hermes-agent v0.15.0 (patch release)
RUN pip install --no-cache-dir "hermes-agent==0.15.0"

# Node gateway
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

# HERMES_INSECURE=1 opts in to 0.0.0.0 bind (explicit, no inference)
ENV HERMES_INSECURE=""

CMD ["node", "server.js"]
