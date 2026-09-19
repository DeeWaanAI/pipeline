# Aliyun 2vCPU 0.5GB — Optimized for Multi-User Access

## Memory Budget (0.5GB total)

| Service | Memory | Config |
|---------|--------|--------|
| MySQL | ~150MB | Minimal (see below) |
| Node.js app | ~200MB | Single process, limited heap |
| Nginx | ~10MB | Default |
| OS overhead | ~80MB | Ubuntu minimal |
| **Reserved** | **~60MB** | Buffer for spikes |

**Realistic capacity: 5-10 concurrent users max.** More than that and the server will OOM-kill and crash.

## 1. MySQL — Ultra-Minimal Config

```bash
# /etc/mysql/mysql.conf.d/low-memory.cnf
[mysqld]
# Memory
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

# Connections — limit to prevent memory exhaustion
max_connections = 15
max_user_connections = 10
wait_timeout = 60
interactive_timeout = 60

# Disable performance schema (saves ~100MB)
performance_schema = OFF

# Reduce logging
slow_query_log = OFF
general_log = OFF
```

## 2. Node.js — Limited Memory + Single Process

```bash
# Start with 256MB max heap, single process
NODE_OPTIONS="--max-old-space-size=256" pm2 start npm --name "swarm-studio" -- start

# Do NOT use cluster mode — it forks multiple processes which uses more memory
# Fork mode (single process) is correct for 0.5GB
```

## 3. PM2 Config (ecosystem.config.cjs)

```javascript
module.exports = {
  apps: [{
    name: "swarm-studio",
    script: "./dist/boot.js",
    instances: 1,        // NEVER increase on 0.5GB
    exec_mode: "fork",   // NOT "cluster" — saves memory
    max_memory_restart: "280M",  // Restart if leak causes growth
    env: {
      NODE_ENV: "production",
      PORT: 3000,
      NODE_OPTIONS: "--max-old-space-size=256"
    },
    // Auto-restart on crash
    autorestart: true,
    // Max 10 restarts in 60 seconds, then stop trying
    max_restarts: 10,
    min_uptime: "10s",
    // Kill after 5s if graceful shutdown hangs
    kill_timeout: 5000,
    // Wait 3s between restarts
    restart_delay: 3000,
  }]
};
```

Save as `/opt/swarm-studio/ecosystem.config.cjs`, then start with:
```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd
```

## 4. Nginx — Rate Limiting (Prevent Abuse)

```nginx
# /etc/nginx/sites-available/swarm-studio

# Rate limit: 10 requests/second per IP, burst of 20
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

server {
    listen 80;
    server_name _;

    # Increase timeouts for LLM API calls (can take 30-60s)
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

        # SSE streaming for pipeline execution
        proxy_buffering off;
        proxy_cache off;
    }
}
```

## 5. Monitor Memory

```bash
# Watch memory every 2 seconds
watch -n 2 free -h

# Or using htop (install: apt-get install htop)
htop
```

**If memory usage goes above 90%, reduce concurrent users or upgrade the instance.**

## 6. What to Expect

| Concurrent Users | Memory Usage | Experience |
|-----------------|--------------|------------|
| 1-3 users | ~60-70% | Smooth |
| 4-6 users | ~75-85% | Slightly slower |
| 7-10 users | ~85-95% | Slow, risk of OOM |
| 10+ users | >95% | Crashes likely |

## 7. If You Need More Users

Upgrade to the next tier on Aliyun:
- **2vCPU 1GB** (~¥48/month) — handles 15-20 users
- **2vCPU 2GB** (~¥96/month) — handles 30-50 users
- Or use **阿里云的 99元/年** promotional 2vCPU 2GB instances (very popular, available during sales)
