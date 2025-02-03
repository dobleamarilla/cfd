#!/bin/bash

# Crear directorio de backups con permisos adecuados
sudo mkdir -p /var/backups/tocgamedb
sudo chown -R $USER:$USER /var/backups/tocgamedb

# Crear configuración de sudoers segura
echo 'Defaults:root !requiretty' | sudo tee /etc/sudoers.d/disaster-recovery
sudo chmod 0440 /etc/sudoers.d/disaster-recovery

echo "Setup completado correctamente."