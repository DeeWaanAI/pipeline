#!/bin/bash
# Optimized install for Aliyun 2vCPU 0.5GB
# Run as root on the server

set -e
APP_DIR="/opt/swarm-studio"

echo "=========================================="
echo "  AI Swarm Studio — Aliyun Deployment"
echo "  Instance: 2vCPU 0.5GB (optimized)"
echo "=========================================="
echo ""

# ─── Step 0: Generate secrets ────────────────────────────────────
echo "[0/8] Generating secrets..."
APP_SECRET=$(openssl rand -hex 32)
# Auto-generated secret — save this!
echo "APP_SECRET=$APP_SECRET"
MYSQL_ROOT_PASSWORD=$(openssl rand -hex 16)
MYSQL_SWARM_PASSWORD=$(openssl rand -hex 16)
echo "  Secrets generated (save these values securely)"

# ─── Step 1: Add 2GB swap (ESSENTIAL) ────────────────────────────
echo "[1/8] Adding 2GB swap..."
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "vm.swappiness=10" >> /etc/sysctl.conf
    sysctl -p >/dev/null
    echo "  Swap: $(free -h | awk '/Swap/{print $2}')"
else
    echo "  Swap already exists: $(free -h | awk '/Swap/{print $2}')"
fi

# ─── Step 2: Install packages ──────────────────────────────────────
echo "[2/8] Installing Node.js 20, MySQL, Nginx..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs git nginx mysql-server ufw >/dev/null

# PM2
npm install -g pm2@latest --silent

echo "  Node $(node -v), npm $(npm -v), PM2 $(pm2 -v)"

# ─── Step 3: MySQL minimal config ──────────────────────────────────
echo "[3/8] Configuring MySQL (ultra-low memory)..."
cat > /etc/mysql/mysql.conf.d/low-memory.cnf << 'MYSQLCFG'
[mysqld]
innodb_buffer_pool_size = 48M
innodb_log_buffer_size = 1M
innodb_flush_log_at_trx_commit = 2
key_buffer_size = 8M
query_cache_type = 0
query_cache_size = 0
tmp_table_size = 4M
max_heap_table_size = 4M
table_definition_cache = 64
table_open_cache = 32
thread_cache_size = 4
max_connections = 15
max_user_connections = 10
wait_timeout = 60
interactive_timeout = 60
performance_schema = OFF
slow_query_log = OFF
general_log = OFF
MYSQLCFG

systemctl restart mysql
systemctl enable mysql >/dev/null

# Secure MySQL root and create app user with generated passwords
mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '${MYSQL_ROOT_PASSWORD}';" 2>/dev/null || true
mysql -u root -p"${MYSQL_ROOT_PASSWORD}" -e "CREATE DATABASE IF NOT EXISTS swarm_db CHARACTER SET utf8mb4;" 2>/dev/null || \
  mysql -e "CREATE DATABASE IF NOT EXISTS swarm_db CHARACTER SET utf8mb4;" 2>/dev/null || true
mysql -u root -p"${MYSQL_ROOT_PASSWORD}" -e "CREATE USER IF NOT EXISTS 'swarm'@'localhost' IDENTIFIED BY '${MYSQL_SWARM_PASSWORD}';" 2>/dev/null || \
  mysql -e "CREATE USER IF NOT EXISTS 'swarm'@'localhost' IDENTIFIED BY '${MYSQL_SWARM_PASSWORD}';" 2>/dev/null || true
mysql -u root -p"${MYSQL_ROOT_PASSWORD}" -e "GRANT ALL ON swarm_db.* TO 'swarm'@'localhost';" 2>/dev/null || \
  mysql -e "GRANT ALL ON swarm_db.* TO 'swarm'@'localhost';" 2>/dev/null || true
mysql -u root -p"${MYSQL_ROOT_PASSWORD}" -e "FLUSH PRIVILEGES;" 2>/dev/null || \
  mysql -e "FLUSH PRIVILEGES;" 2>/dev/null || true
echo "  Database: swarm_db ready"

# ─── Step 4: Prepare app directory ─────────────────────────────────
echo "[4/8] Preparing app directory..."
mkdir -p "$APP_DIR/logs"
# NOTE: You must upload your project files to $APP_DIR first!
# From your Mac: rsync -avz --exclude node_modules --exclude dist . root@IP:$APP_DIR/

if [ ! -f "$APP_DIR/package.json" ]; then
    echo ""
    echo "  ERROR: No package.json found in $APP_DIR"
    echo "  Please upload your project files first:"
    echo "    rsync -avz --exclude node_modules --exclude dist . root@YOUR_IP:$APP_DIR/"
    echo ""
    exit 1
fi

cd "$APP_DIR"

# ─── Step 5: Install and build ─────────────────────────────────────
echo "[5/8] Installing dependencies..."
npm install --silent

echo "[6/8] Creating production .env and building..."
cat > .env << ENVCFG
DATABASE_URL=mysql://swarm:${MYSQL_SWARM_PASSWORD}@127.0.0.1:3306/swarm_db
NODE_ENV=production
PORT=3000
APP_ID=19e8d703-7842-80ce-8000-0000d3729e13
APP_SECRET=${APP_SECRET}
OWNER_UNION_ID=d8apdtgpe77usiq12f50
VITE_APP_ID=19e8d703-7842-80ce-8000-0000d3729e13
KIMI_AUTH_URL=https://auth.kimi.com
KIMI_OPEN_URL=https://open.kimi.com
ENVCFG

npm run build 2>&1 | tail -3

# Push DB schema
echo "  Pushing database schema..."
npx drizzle-kit push 2>&1 | tail -3

# ─── Step 6: Nginx config ──────────────────────────────────────────
echo "[7/8] Configuring Nginx..."
cat > /etc/nginx/sites-available/swarm-studio << 'NGINXCFG'
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=stream:10m rate=2r/s;

server {
    listen 80;
    server_name _;
    proxy_read_timeout 120s;
    proxy_connect_timeout 30s;
    proxy_send_timeout 120s;

    location / {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_cache off;
    }

    location /api/stream/ {
        limit_req zone=stream burst=5 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        chunked_transfer_encoding off;
    }
}
NGINXCFG

ln -sf /etc/nginx/sites-available/swarm-studio /etc/nginx/sites-enabled/ 2>/dev/null || true
rm -f /etc/nginx/sites-enabled/default
nginx -t 2>&1 | tail -1
systemctl restart nginx
systemctl enable nginx >/dev/null

# ─── Step 7: PM2 start ─────────────────────────────────────────────
echo "[8/8] Starting with PM2 (memory-limited)..."
pm2 delete swarm-studio 2>/dev/null || true
pm2 start ecosystem.config.cjs 2>&1 | tail -3
pm2 save >/dev/null
pm2 startup systemd >/dev/null

# Firewall
ufw allow 22/tcp >/dev/null 2>&1
ufw allow 80/tcp >/dev/null 2>&1
ufw allow 443/tcp >/dev/null 2>&1
ufw --force enable >/dev/null 2>&1

echo ""
echo "=========================================="
echo "  DEPLOYMENT COMPLETE!"
echo "=========================================="
echo ""
echo "Access your app at:"
echo "  http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP')"
echo ""
echo "Commands:"
echo "  pm2 status          — Check if running"
echo "  pm2 logs            — View live logs"
echo "  pm2 restart swarm-studio — Restart"
echo "  free -h             — Check memory"
echo ""
echo "Memory limit: 280MB (restarts if exceeded)"
echo "Swap: 2GB (prevents OOM crashes)"
echo "Max users: ~5-10 concurrent"
echo ""

# ─── TLS / Let's Encrypt (optional) ────────────────────────────────
# To enable HTTPS with a free Let's Encrypt certificate, uncomment and run:
#
# 1. Install certbot:
#    apt-get install -y certbot python3-certbot-nginx
#
# 2. Replace YOUR_DOMAIN with your actual domain (e.g., swarm.example.com):
#    certbot --nginx -d YOUR_DOMAIN --non-interactive --agree-tos --email YOUR_EMAIL
#
# 3. Certbot will auto-renew certificates via systemd timer.
#    Verify with: certbot renew --dry-run
#
# 4. After TLS is set up, update the firewall:
#    ufw allow 443/tcp
#
# NOTE: You must have a DNS A record pointing to this server's IP before running certbot.
