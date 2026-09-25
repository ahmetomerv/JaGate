# Run with Docker Compose

The repository includes a [Dockerfile](https://github.com/ahmetomerv/JaGate/blob/main/Dockerfile) and [Compose example](https://github.com/ahmetomerv/JaGate/blob/main/compose.yaml). Docker builds the Node 24 gateway and mounts `/app/data` in the `jagate-data` named volume. The host port is bound to `127.0.0.1:3080`.

First follow the bot and numeric ID steps in [Get started locally](/guide/getting-started). Then, from the repository root:

```sh
cp .env.example .env
openssl rand -hex 32
# Edit .env: replace the CLIENT_KEYS placeholder and fill in the bot token and numeric IDs.
docker compose up --build -d
curl -i http://127.0.0.1:3080/ready
```

The Compose file sets `HOST=0.0.0.0` **inside** the container so the host's loopback port can reach it. The host-facing port remains bound to `127.0.0.1`. View startup or delivery errors with `docker compose logs gateway`. Use a dedicated bot: an existing webhook or concurrent poller prevents normal startup.

For an end-to-end action test, install the repository's development dependencies on your host with `npm ci`, load the `example` client key as shown in [Get started locally](/guide/getting-started), and run `node --import tsx examples/demo.ts`. The demo calls the container's API through the loopback port; after approval it writes a local temporary file on your host.

## Back up SQLite

SQLite runs in WAL mode. Use its online backup API while the service is running, and keep the backup private because request text and metadata are stored in it:

```sh
docker compose exec -T gateway node -e 'const db=require("better-sqlite3")("/app/data/gateway.sqlite"); db.backup("/app/data/gateway-backup.sqlite").then(()=>db.close())'
docker compose cp gateway:/app/data/gateway-backup.sqlite ./gateway-backup.sqlite
docker compose exec -T gateway rm /app/data/gateway-backup.sqlite
```

Test a restore into a separate volume. Do not copy only the main database file while WAL writes are active. Only one gateway instance should own this database and bot token. Stop the service with `docker compose down`; keep the named volume unless you intentionally want to remove its data.
