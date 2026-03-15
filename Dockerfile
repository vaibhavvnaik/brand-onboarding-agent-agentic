FROM node:20-bookworm

WORKDIR /app

# Install app dependencies first for better layer caching
COPY package*.json ./

# Install Node deps and Playwright browser + OS dependencies deterministically
RUN npm ci \
  && npx playwright install --with-deps chromium \
  && npm cache clean --force

# Copy application source
COPY . .

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 8080

# boot.js applies runtime env and encoding fixes before starting server
CMD ["node", "boot.js"]

