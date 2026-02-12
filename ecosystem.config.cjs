module.exports = {
  apps: [
    {
      name: "ai-news",
      script: "src/index.js",
      cwd: ".",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      min_uptime: "10s",
      max_restarts: 20,
      restart_delay: 5000,
      kill_timeout: 8000,
      env: {
        NODE_ENV: "production"
      },
      out_file: "logs/engine.out.log",
      error_file: "logs/engine.err.log",
      merge_logs: true,
      time: true
    }
  ]
};
