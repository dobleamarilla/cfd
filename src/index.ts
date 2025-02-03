import { MongoClient } from "mongodb";
import { execSync } from "child_process";
import { format } from "date-fns";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createLogger, format as winstonFormat, transports } from "winston";

// Configuración principal
const CONFIG = {
  MONGO_URI: process.env.MONGO_URI || "mongodb://localhost:27017/tocgame",
  DOCKER_VOLUME: process.env.DOCKER_VOLUME || "mongo_data",
  CONTAINER_NAME: process.env.CONTAINER_NAME || "mongodb",
  BACKUP_DIR: process.env.BACKUP_DIR || join(homedir(), "backups/tocgamedb"),
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL || "300000"), // 5 minutos
  SALES_COLLECTION: "sales",
  BACKUPS_COLLECTION: "backups",
};

// Configurar logger
const logger = createLogger({
  level: "info",
  format: winstonFormat.combine(
    winstonFormat.timestamp(),
    winstonFormat.json()
  ),
  transports: [
    new transports.File({ filename: "logs/error.log", level: "error" }),
    new transports.File({ filename: "logs/combined.log" }),
    new transports.Console({
      format: winstonFormat.combine(
        winstonFormat.colorize(),
        winstonFormat.simple()
      ),
    }),
  ],
});

// Tipos de datos
interface Sale {
  _id: string;
  createdAt: Date;
}

interface BackupRecord {
  _id?: any; // Puede ser ObjectId u otro tipo según tu configuración
  filename: string;
  path: string;
  createdAt: Date;
  sizeMB: number;
  status: "created" | "restored" | "failed";
}

class DisasterRecoverySystem {
  constructor() {
    this.ensureBackupDir();
  }

  private ensureBackupDir(): void {
    try {
      if (!existsSync(CONFIG.BACKUP_DIR)) {
        mkdirSync(CONFIG.BACKUP_DIR, { recursive: true, mode: 0o755 });
        logger.info(`Directorio de backups creado: ${CONFIG.BACKUP_DIR}`);
      }
    } catch (error) {
      logger.error("Error creando directorio de backups:", error);
      throw error;
    }
  }

  public async checkRecentSales(): Promise<boolean> {
    const client = new MongoClient(CONFIG.MONGO_URI);
    try {
      await client.connect();
      const collection = client.db().collection<Sale>(CONFIG.SALES_COLLECTION);
      const fiveMinutesAgo = new Date(Date.now() - CONFIG.CHECK_INTERVAL);
      const count = await collection.countDocuments({
        createdAt: { $gte: fiveMinutesAgo },
      });
      return count > 0;
    } finally {
      await client.close();
    }
  }

  private showDialog(): boolean {
    try {
      execSync(
        "zenity --question " +
          '--title="Estado del Sistema" ' +
          '--text="No se detectaron ventas en 5 minutos. ¿Existen problemas?" ' +
          '--width=400 --ok-label="Sí" --cancel-label="No"',
        { stdio: "inherit" }
      );
      return true;
    } catch {
      return false;
    }
  }

  public async createVolumeBackup(): Promise<string> {
    const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
    const backupFile = `backup-${timestamp}.gz`;
    const backupPath = join(CONFIG.BACKUP_DIR, backupFile);

    try {
      logger.info(`Iniciando backup: ${backupPath}`);

      // Capturamos la salida del comando mongodump
      const dump = execSync(
        `docker exec ${CONFIG.CONTAINER_NAME} mongodump --uri="${CONFIG.MONGO_URI}" --archive --gzip`
      );

      // Escribimos el dump en el archivo de backup
      writeFileSync(backupPath, dump);

      // Registrar el backup en MongoDB
      const stats = await this.registerBackup(backupFile, backupPath);
      logger.info(`Backup exitoso: ${stats.sizeMB}MB`);
      return backupPath;
    } catch (error) {
      logger.error("Error en backup:", error);
      throw error;
    }
  }

  private async registerBackup(
    filename: string,
    path: string
  ): Promise<{ sizeMB: number }> {
    const client = new MongoClient(CONFIG.MONGO_URI);
    try {
      await client.connect();
      const stats = await this.getFileStats(path);
      const collection = client
        .db()
        .collection<BackupRecord>(CONFIG.BACKUPS_COLLECTION);
      await collection.insertOne({
        filename,
        path,
        createdAt: new Date(),
        sizeMB: stats.sizeMB,
        status: "created",
      });
      return stats;
    } finally {
      await client.close();
    }
  }

  private async getFileStats(path: string): Promise<{ sizeMB: number }> {
    const statsStr = execSync(`du -m "${path}" | cut -f1`).toString().trim();
    return { sizeMB: parseInt(statsStr) || 0 };
  }

  public async restoreLatestBackup(): Promise<void> {
    const client = new MongoClient(CONFIG.MONGO_URI);
    try {
      await client.connect();
      const collection = client
        .db()
        .collection<BackupRecord>(CONFIG.BACKUPS_COLLECTION);

      const backup = await collection.findOne(
        { status: "created" },
        { sort: { createdAt: -1 } }
      );

      if (!backup) {
        throw new Error("No hay backups disponibles");
      }

      logger.info(`Iniciando restauración desde: ${backup.filename}`);

      // Detener contenedor
      execSync(`docker stop ${CONFIG.CONTAINER_NAME}`, { stdio: "inherit" });

      // Esperar unos segundos para que el contenedor se detenga completamente
      await this.delay(3000);

      // Construir y ejecutar el comando de restauración
      const restoreCmd = [
        "docker run --rm",
        `-v ${CONFIG.DOCKER_VOLUME}:/data/db`,
        `-v ${CONFIG.BACKUP_DIR}:/backups`,
        "mongo",
        `bash -c "mongorestore --uri='${CONFIG.MONGO_URI}' --gzip --archive=/backups/${backup.filename}"`,
      ].join(" ");
      execSync(restoreCmd, { stdio: "inherit" });

      // Actualizar el estado del backup a "restored"
      await collection.updateOne(
        { _id: backup._id },
        { $set: { status: "restored" } }
      );

      // Reiniciar contenedor
      execSync(`docker start ${CONFIG.CONTAINER_NAME}`, { stdio: "inherit" });
      logger.info("Restauración completada exitosamente");
    } catch (error) {
      logger.error("Error en restauración:", error);
      throw error;
    } finally {
      await client.close();
    }
  }

  public async startMonitoring(): Promise<void> {
    logger.info("Iniciando sistema de monitorización...");
    while (true) {
      try {
        const hasSales = await this.checkRecentSales();
        if (!hasSales) {
          const hasProblems = this.showDialog();
          if (hasProblems) {
            logger.warn("Problemas detectados - Restaurando último backup");
            await this.restoreLatestBackup();
          } else {
            logger.info("Creando backup preventivo");
            await this.createVolumeBackup();
          }
        }
        await this.delay(CONFIG.CHECK_INTERVAL);
      } catch (error) {
        logger.error("Error en ciclo de monitorización:", error);
        await this.delay(10000); // Espera antes de reintentar
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Ejecución principal
(async () => {
  try {
    const recoverySystem = new DisasterRecoverySystem();
    await recoverySystem.startMonitoring();
  } catch (error) {
    logger.error("Error crítico:", error);
    process.exit(1);
  }
})();
