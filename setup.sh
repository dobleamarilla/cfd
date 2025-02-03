#!/bin/bash

# Crear directorio de backups con permisos adecuados
sudo mkdir -p /var/backups/tocgamedb
sudo chown -R $USER:$USER /var/backups/tocgamedb

# Dar permisos para ejecutar zenity como root (si es necesario)
echo 'Defaults:root !' | sudo tee -a /etc/sudoers

echo "Setup completado."