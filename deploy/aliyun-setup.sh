#!/bin/bash
# Deployment script for Aliyun ECS 2vCPU 0.5GB instance
# Run this on your server after SSH login

set -e

echo "=== AI Swarm Studio Deployment ==="
echo "Instance: 2vCPU 0.5GB RAM"
echo ""

# ─── Step 0: Generate secrets ──────────────────────────────────────
echo "[0/10] Generating secrets..."
APP_SECRET=$(openssl rand -hex 32)
# Auto-generated secret — save this!
echo "APP_SECRET=$APP_SECRET"
MYSQL_ROOT_PASSWORD=$(openssl rand -hex 16)
MYSQL_SWARM_PASSWORD=$(openssl rand -hex 16)
echo "  Secrets generated (save these values securely)"

# ─── Step 1: Add 2GB swap (essential with 0.5GB RAM) ─────────────
echo "[1/10] Adding 2GB swap space..."
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "vm.swappiness=10" >> /etc/sysctl.conf
    sysctl -p
fi
echo "Swap: $(free -h | grep Swap | awk '{print $2}')"

# ─── Step 2: Update system ────────────────────────────────────────
echo "[2/10] Updating system packages..."
apt-get update -qq
apt-get install -y -qq curl wget git nginx ufw

# ─── Step 3: Install Node.js 20 ───────────────────────────────────
echo "[3/10] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs
node -v
npm -v

# ─── Step 4: Install PM2 ──────────────────────────────────────────
echo "[4/10] Installing PM2 process manager..."
npm install -g pm2

# ─── Step 5: Install MySQL 8.0 (minimal) ──────────────────────────
echo "[5/10] Installing MySQL 8.0 (minimal config)..."
apt-get install -y -qq mysql-server

# Create minimal MySQL config for low RAM
cat > /etc/mysql/mysql.conf.d/low-memory.cnf << 'MYSQLCFG'
[mysqld]
# Minimal memory settings for 0.5GB instance
innodb_buffer_pool_size = 64M
innodb_log_buffer_size = 4M
innodb_flush_log_at_trx_commit = 2
query_cache_size = 0
table_open_cache = 64
tmp_table_size = 8M
max_heap_table_size = 8M
thread_cache_size = 4
max_connections = 20
performance_schema = OFF
key_buffer_size = 8M
MYSQLCFG

systemctl restart mysql
systemctl enable mysql

# Secure MySQL root and create app user with generated passwords
mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '${MYSQL_ROOT_PASSWORD}';" 2>/dev/null || true
mysql -u root -p"${MYSQL_ROOT_PASSWORD}" -e "CREATE DATABASE IF NOT EXISTS swarm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null || \
  mysql -e "CREATE DATABASE IF NOT EXISTS swarm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null || true
mysql -u root -p"${MYSQL_ROOT_PASSWORD}" -e "CREATE USER IF NOT EXISTS 'swarm'@'localhost' IDENTIFIED BY '${MYSQL_SWARM_PASSWORD}';" 2>/dev/null || \
  mysql -e "CREATE USER IF NOT EXISTS 'swarm'@'localhost' IDENTIFIED BY '${MYSQL_SWARM_PASSWORD}';" 2>/dev/null || true
mysql -u root -p"${MYSQL_ROOT_PASSWORD}" -e "GRANT ALL PRIVILEGES ON swarm.* TO 'swarm'@'localhost';" 2>/dev/null || \
  mysql -e "GRANT ALL PRIVILEGES ON swarm.* TO 'swarm'@'localhost';" 2>/dev/null || true
mysql -u root -p"${MYSQL_ROOT_PASSWORD}" -e "FLUSH PRIVILEGES;" 2>/dev/null || \
  mysql -e "FLUSH PRIVILEGES;" 2>/dev/null || true

# ─── Step 6: Clone your project ───────────────────────────────────
echo "[6/10] Cloning project..."
# Replace with your actual GitHub repo, or upload files manually
cd /opt
if [ ! -d "swarm-studio" ]; then
    git clone https://github.com/YOUR_USERNAME/swarm-studio.git
fi
cd swarm-studio

# ─── Step 7: Install dependencies ─────────────────────────────────
echo "[7/10] Installing npm dependencies..."
npm install

# ─── Step 8: Build the app ────────────────────────────────────────
echo "[8/10] Building the app..."

# Create production .env with generated secrets
cat > .env << ENVCFG
DATABASE_URL=mysql://swarm:${MYSQL_SWARM_PASSWORD}@localhost:3306/swarm
NODE_ENV=production
PORT=3000
APP_ID=19e8d703-7842-80ce-8000-0000d3729e13
APP_SECRET=${APP_SECRET}
OWNER_UNION_ID=d8apdtgpe77usiq12f50
VITE_APP_ID=19e8d703-7842-80ce-8000-0000d3729e13
KIMI_AUTH_URL=https://auth.kimi.com
KIMI_OPEN_URL=https://open.kimi.com
ENVCFG

npm run build

# ─── Step 9: Push database schema ─────────────────────────────────
echo "[9/10] Pushing database schema..."
npx drizzle-kit push

# ─── Step 10: Start with PM2 ──────────────────────────────────────
echo "[10/10] Starting with PM2..."
pm2 delete swarm-studio 2>/dev/null || true
pm2 start npm --name "swarm-studio" -- start
pm2 save
pm2 startup systemd

# ─── Configure Nginx reverse proxy ────────────────────────────────
echo "Configuring Nginx..."
cat > /etc/nginx/sites-available/swarm-studio << 'NGINXCFG'
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=stream:10m rate=2r/s;

server {
    listen 80;
    server_name _;  # Accept any hostname

    location / {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }

    location /api/stream/ {
        limit_req zone=stream burst=5 nodelay;
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400;
        chunked_transfer_encoding off;
    }
}
NGINXCFG

ln -sf /etc/nginx/sites-available/swarm-studio /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
systemctl enable nginx

# ─── Open firewall ────────────────────────────────────────────────
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo ""
echo "=== DEPLOYMENT COMPLETE ==="
echo ""
echo "Your app should be running at:"
echo "  http://YOUR_SERVER_IP"
echo ""
echo "Check status: pm2 status"
echo "View logs:    pm2 logs swarm-studio"
echo "Restart:      pm2 restart swarm-studio"
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
# NOTE: You must have a DNS A record pointing to this server's IP before running certbot.
