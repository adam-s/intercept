---
name: ec2-deploy
description: Deploy to EC2 production server. Use when deploying new code, rebuilding Docker images, wiping and reseeding the database, checking container health, or managing the EC2 instance via AWS CLI.
---

# EC2 Deploy Skill

## Consent check — **CRITICAL · MANDATORY**

**Check if `.agents/user-consent.md` exists with `ACCEPTED: true`.** If yes, display: `Prior consent on file (DATE). Proceeding.` and skip to "Config."

If not, present the 3 warnings from `.agents/skills/instruction-tuning/SKILL.md` (ToS, autonomous agents, resource consumption). All 3 must be accepted. Write `.agents/user-consent.md` on acceptance. This file is shared across all skills that affect external infrastructure.

---

Manage EC2 instances and Docker Compose services using the AWS CLI and SSH.

**Use this skill when asked to:**
- Deploy new code to production
- Wipe and reseed the production database
- Restart/rebuild containers
- Check container health, logs, or DB state
- Find the EC2 instance IP or connection info

---

## Config

Configure these values based on your deployment environment. All commands below reference them by name.

| Variable | Description | Example |
|----------|-------------|---------|
| `INSTANCE_NAME` | EC2 instance name tag | `my-app-prod` |
| `SSH_KEY` | Local SSH private key | `~/.ssh/my-app-prod-key.pem` |
| `SSH_USER` | OS user on instance | `ubuntu` (or `ec2-user`) |
| `PROJECT_DIR` | Git repo root on instance | `/home/ubuntu/my-project` |
| `COMPOSE_FILE` | Docker Compose config | `docker-compose.prod.yml` |
| `DB_USER` | Database username | `appuser` |
| `DB_NAME` | Database name | `app_db` |

Get your `INSTANCE_ID` from AWS console or `aws ec2 describe-instances --filters "Name=tag:Name,Values=$INSTANCE_NAME"`.

---

## Instance Discovery

**ALWAYS start here.** Never hardcode IPs — use AWS CLI to get the current public IP:

```bash
aws ec2 describe-instances \
  --filters "Name=instance-state-name,Values=running" \
  --query "Reservations[*].Instances[*].{ID:InstanceId,Name:Tags[?Key=='Name']|[0].Value,IP:PublicIpAddress,Type:InstanceType,State:State.Name}" \
  --output table
```

Find your instance name from the output above. If its public IP has changed, this command will always show the current one.

---

## SSH Connection

```bash
ssh -i $SSH_KEY -o StrictHostKeyChecking=no $SSH_USER@<PUBLIC_IP>
```

- **Key file**: `$SSH_KEY` (configure before use)
- **Username**: `$SSH_USER` (typically `ubuntu` for Ubuntu, `ec2-user` for Amazon Linux)
- **Project root**: `$PROJECT_DIR` (your git repo path)

Verify the key before SSHing:
```bash
aws ec2 describe-instances \
  --instance-ids $INSTANCE_ID \
  --query "Reservations[0].Instances[0].KeyName" \
  --output text
```

---

## Container Architecture

Docker containers managed via `docker-compose.prod.yml`:

| Container | Image | Purpose |
|-----------|-------|---------|
| `app_db` | timescale/timescaledb or postgres | PostgreSQL database |
| `app_redis` | redis:7-alpine | Job queue (BullMQ) |
| `app_api` | your-app-api (local build) | API server |
| `app_web` | your-app-web (local build) | Frontend (Next.js or similar) |
| `app_proxy` | caddy:2-alpine | Reverse proxy (80/443) |

**Key facts:**
- Database is NOT exposed to host ports in production — only accessible via `docker exec` or within Docker network
- `.env` file is at `$PROJECT_DIR/.env` (not in the Docker image)
- Adjust container names to match your `docker-compose.prod.yml`

---

## Routine Deployment (code only, no DB wipe)

When only code changes (no schema or seed changes):

```bash
ssh -i $SSH_KEY $SSH_USER@<IP> "
  cd $PROJECT_DIR
  git pull origin main
  docker compose -f $COMPOSE_FILE build api web
  docker compose -f $COMPOSE_FILE up -d
"
```

---

## Full Wipe + Reseed Deployment

When schema changed or a clean slate is needed.

### Step 1: Ensure local commit is pushed

```bash
git push origin main
```

### Step 2: Pull on EC2

```bash
ssh -i $SSH_KEY $SSH_USER@<IP> "
  cd $PROJECT_DIR && git pull origin main && git log --oneline -3
"
```

### Step 3: Drop and recreate the database

```bash
ssh -i $SSH_KEY $SSH_USER@<IP> "
  docker exec app_db psql -U $DB_USER -d postgres \
    -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB_NAME' AND pid<>pg_backend_pid();\"
  docker exec app_db psql -U $DB_USER -d postgres \
    -c 'DROP DATABASE IF EXISTS $DB_NAME;'
  docker exec app_db psql -U $DB_USER -d postgres \
    -c 'CREATE DATABASE $DB_NAME OWNER $DB_USER;'
"
```

### Step 4: Stop api and web (keep db + redis running)

```bash
ssh -i $SSH_KEY $SSH_USER@<IP> "
  cd $PROJECT_DIR
  docker compose -f $COMPOSE_FILE stop api web
"
```

### Step 5: Rebuild images

```bash
ssh -i $SSH_KEY $SSH_USER@<IP> "
  cd $PROJECT_DIR
  docker compose -f $COMPOSE_FILE build api web
"
```

Takes 3–8 minutes depending on dependency installations.

### Step 6: Run migrations and seed data

```bash
ssh -i $SSH_KEY $SSH_USER@<IP> "
  cd $PROJECT_DIR
  docker compose -f $COMPOSE_FILE run --rm --no-deps api \
    sh -c 'cd /app && pnpm run db:migrate && pnpm run db:seed'
"
```

Adjust migration/seed commands to match your project setup.

### Step 7: Start all containers

```bash
ssh -i $SSH_KEY $SSH_USER@<IP> "
  cd $PROJECT_DIR
  docker compose -f $COMPOSE_FILE up -d
"
```

### Step 8: Verify

```bash
# Container health
ssh -i $SSH_KEY $SSH_USER@<IP> \
  "docker ps --format 'table {{.Names}}\t{{.Status}}'"

# API health
curl -s https://your-domain.com/api/health

# DB check
ssh -i $SSH_KEY $SSH_USER@<IP> "
  docker exec app_db psql -U $DB_USER -d $DB_NAME -c 'SELECT COUNT(*) FROM information_schema.tables;'
"
```

---

## Running Ad-Hoc Commands

### Execute SQL in the DB

```bash
ssh -i $SSH_KEY $SSH_USER@<IP> \
  "docker exec app_db psql -U $DB_USER -d $DB_NAME -c 'SELECT COUNT(*) FROM users;'"
```

### View container logs

```bash
ssh -i $SSH_KEY $SSH_USER@<IP> \
  "docker logs app_api --tail 50 -f"
```

### Run a script in the api container

```bash
ssh -i $SSH_KEY $SSH_USER@<IP> "
  cd $PROJECT_DIR
  docker compose -f $COMPOSE_FILE run --rm --no-deps api \
    sh -c 'pnpm run scripts/my-script.ts'
"
```

---

## Debugging Common Issues

| Issue | Likely Cause | Fix |
|-------|------------|-----|
| `docker exec app_db psql` fails | postgres not running or wrong container name | Check `docker ps` to see running containers, update `app_db` name |
| `DROP DATABASE` hangs | connections still open | Run terminate step first before DROP |
| SSH auth fails | Wrong key or username | Verify with `aws ec2 describe-instances` |
| Old code running after deploy | Image not rebuilt | Run `docker compose build` explicitly |
| Port 3001 already in use (local) | Another app using port | `kill $(lsof -t -iTCP:3001 -sTCP:LISTEN)` |

---

## Instance Management (AWS CLI)

```bash
# List instances
aws ec2 describe-instances --filters "Name=instance-state-name,Values=running"

# Start/stop
aws ec2 stop-instances --instance-ids $INSTANCE_ID
aws ec2 start-instances --instance-ids $INSTANCE_ID

# Check instance type
aws ec2 describe-instances \
  --instance-ids $INSTANCE_ID \
  --query "Reservations[0].Instances[0].InstanceType" \
  --output text

# Check CPU/memory metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=$INSTANCE_ID \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 300 \
  --statistics Average \
  --output table
```
