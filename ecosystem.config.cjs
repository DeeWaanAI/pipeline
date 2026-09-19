module.exports = {
  apps: [{
    name: "swarm-studio",
    script: "./dist/boot.js",
    // CRITICAL for 0.5GB: single process only
    instances: 1,
    exec_mode: "fork",
    // Restart if memory leaks above 280MB
    max_memory_restart: "280M",
    env: {
      NODE_ENV: "production",
      PORT: 3000,
      // Limit Node.js heap to 256MB
      NODE_OPTIONS: "--max-old-space-size=256"
    },
    // Auto-restart on crash
    autorestart: true,
    max_restarts: 10,
    min_uptime: "10s",
    kill_timeout: 5000,
    restart_delay: 3000,
    // Log rotation (prevent disk fill)
    log_file: "./logs/combined.log",
    out_file: "./logs/out.log",
    error_file: "./logs/error.log",
    max_size: "10M",
    max_files: 5,
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    merge_logs: true,
  }]
};
