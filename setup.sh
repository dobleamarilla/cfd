#!/bin/bash

# Crear directorio de backups con permisos adecuados
sudo mkdir -p ~/backups/tocgamedb
# sudo chown -R $USER:$USER /backups/tocgamedb

# Crear configuración de sudoers segura
echo 'Defaults:root !requiretty' | sudo tee /etc/sudoers.d/disaster-recovery
sudo chmod 0440 /etc/sudoers.d/disaster-recovery

# Asignar permisos de ejecución a mongodump y mongorestore
chmod +x "$(dirname "$0")"/mongodump
chmod +x "$(dirname "$0")"/mongorestore

echo "Setup completado correctamente."