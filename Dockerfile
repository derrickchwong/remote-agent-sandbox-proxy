FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm install typescript @types/node @types/express && \
    npm run build && \
    npm uninstall typescript @types/node @types/express

# Remove source files, keep only compiled JS
RUN rm -rf src tsconfig.json

# Run as non-root user
USER node

EXPOSE 8080

CMD ["node", "dist/server.js"]
