#!/bin/bash

# Configurar entorno de backups
BACKUP_DIR="$HOME/backups/tocgamedb"
LOG_DIR="$PWD/logs"

# 1. Crear directorios con permisos
mkdir -p "$BACKUP_DIR" "$LOG_DIR"
chmod 755 "$BACKUP_DIR"
chmod 755 "$LOG_DIR"

# 2. Configurar Docker
sudo groupadd docker 2>/dev/null
sudo usermod -aG docker $USER

# 3. Instalar dependencias
sudo apt-get update
sudo apt-get install -y \
  mongodb-org-tools \
  zenity \
  docker.io

# 4. Configurar servicio systemd
SERVICE_FILE="/etc/systemd/system/toc-monitor.service"
sudo tee "$SERVICE_FILE" > /dev/null <<EOL
[Unit]
Description=TOC Disaster Recovery Monitor
After=docker.service

[Service]
User=$USER
WorkingDirectory=$PWD
ExecStart=$(which node) dist/index.js
Restart=always
Environment="MONGO_URI=mongodb://localhost:27017/tocgame"
Environment="BACKUP_DIR=$BACKUP_DIR"

[Install]
WantedBy=multi-user.target
EOL

# 5. Recargar e iniciar servicio
sudo systemctl daemon-reload
sudo systemctl enable toc-monitor
sudo systemctl start toc-monitor

echo "Configuración completada"
echo " - Backups: $BACKUP_DIR"
echo " - Logs: $LOG_DIR"
echo " - Servicio: toc-monitor"
