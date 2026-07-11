# KomodoCD

A simple automated GitOps reconciliation daemon for [Komodo](https://github.com/mbeentjes/komodo) to achieve an ArgoCD-like GitOps workflow. It monitors repository sync states, computes file changes via SHA-256 hashes of configured stack directories, triggers deployments when modifications are detected, and dispatches status alerts to Discord.

## 🚀 How to Run

### 1. Configure Environment

Create a `.env` file at the root of the project with the following configurations:

```env
KOMODO_URL=https://your-komodo-instance:9120
KOMODO_KEY=your_key_here
KOMODO_SECRET=your_secret_here
KOMODO_ROOT_DIRECTORY=/etc/komodo
GITOPS_REPO_NAME=GitOps
GITOPS_SYNC_NAME=GitOpsSync
```

### 2. Run with Docker Compose

Configure your services inside `docker-compose.yml` to mount the Komodo root directory:

```yaml
services:
  komodo-cd:
    image: topeestla/komodocd:latest
    container_name: komodo-cd-server
    restart: unless-stopped
    environment:
      - KOMODO_URL=${KOMODO_URL}
      - KOMODO_KEY=${KOMODO_KEY}
      - KOMODO_SECRET=${KOMODO_SECRET}
      - KOMODO_ROOT_DIRECTORY=${KOMODO_ROOT_DIRECTORY:-/etc/komodo}
      - GITOPS_REPO_NAME=${GITOPS_REPO_NAME}
      - GITOPS_SYNC_NAME=${GITOPS_SYNC_NAME}
    volumes:
      - "${KOMODO_ROOT_DIRECTORY:-/etc/komodo}:${KOMODO_ROOT_DIRECTORY:-/etc/komodo}"
```

Then run:

```bash
docker compose up -d
```

### 3. Run Locally (Development)

To run the daemon locally using Node.js:

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Or build and start in production mode
npm run build
npm start
```
