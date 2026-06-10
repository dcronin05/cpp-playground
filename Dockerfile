FROM node:20-slim

# Prevent interactive prompts during package install
ENV DEBIAN_FRONTEND=noninteractive

# Install Clang, standard C++ library, and core build tools
RUN apt-get update && apt-get install -y \
    clang \
    build-essential \
    libc++-dev \
    libc++abi-dev \
    && rm -rf /var/lib/apt/lists/*

# Set up work directory
WORKDIR /app

# Copy package config and install dependencies
COPY package.json ./
RUN npm install --only=production

# Copy the server and public asset files
COPY . .

# Expose backend port
EXPOSE 3000

# Run as standard non-root user 'node' for security
USER node

# Run application
CMD ["node", "server.js"]
