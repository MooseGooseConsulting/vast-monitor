ARG NODE_IMAGE=node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e
FROM ${NODE_IMAGE}

# The community monitor invokes the official Vast Python CLI.  Keep the exact
# script revision and its digest in the image so a rebuilt monitor still has
# the same read-only query surface as the existing deployment.
ARG VAST_CLI_COMMIT=38e0711b4f5d946484147cb9e5e3d76a49db12f8
ARG VAST_CLI_SHA256=efb81f79dfbb2a6a8a8230c73ffb0922c2c72925ad103eee5e197d575e1a8a91
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-pip \
    && python3 -m pip install --break-system-packages --no-cache-dir \
      certifi==2025.1.31 charset-normalizer==3.4.1 idna==3.18 \
      python-dateutil==2.9.0.post0 requests==2.34.2 six==1.17.0 urllib3==2.7.0 \
    && curl --fail --location --silent --show-error \
      "https://raw.githubusercontent.com/vast-ai/vast-python/${VAST_CLI_COMMIT}/vast.py" \
      --output /usr/local/bin/vast \
    && echo "${VAST_CLI_SHA256}  /usr/local/bin/vast" | sha256sum --check --strict \
    && chmod 0555 /usr/local/bin/vast \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . ./
ENV NODE_ENV=production
ENV VAST_CLI_PATH=/usr/local/bin/vast
EXPOSE 3000
CMD ["node", "src/index.js"]
